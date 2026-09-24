require('dotenv/config');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const Fastify = require('fastify');

// Space control center: operator login + a thin authenticated proxy to token-service's /admin/*
// routes. Holds ADMIN_SHARED_SECRET (never the consumer TOKEN_SERVICE_SHARED_SECRET, never LiveKit
// keys) and is the only login anywhere in this repo. Deployed on Railway, reaching token-service
// through Caddy on the droplet — the same path Petition Studio's API takes.
const TOKEN_SERVICE_URL = (process.env.TOKEN_SERVICE_URL ?? 'http://localhost:8880').replace(/\/$/, '');
const ADMIN_SHARED_SECRET = process.env.ADMIN_SHARED_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PORT = Number(process.env.PORT ?? 8870);

if (!ADMIN_SHARED_SECRET || !ADMIN_PASSWORD) {
  throw new Error('ADMIN_SHARED_SECRET and ADMIN_PASSWORD are required (copy .env.example to .env).');
}

const SESSION_COOKIE = 'space_admin';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MAX_FAILED_LOGINS = 5;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
// Upstream response headers the page needs: JSON bodies, and audio playback/seeking/download.
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition'];
const PAGE = path.join(__dirname, 'public', 'index.html');

const passwordDigest = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
// Per-process signing key: a restart/redeploy logs the operator out, which is fine for a
// single-operator tool and means no second secret to manage.
const signingKey = crypto.randomBytes(32);
const sign = (expiresAt) => crypto.createHmac('sha256', signingKey).update(String(expiresAt)).digest('base64url');
const failedLogins = new Map(); // client ip -> { count, since }

// Always runs behind a TLS-terminating proxy (Railway's edge, or Caddy), so request.ip /
// request.protocol come from X-Forwarded-*. Exposing this process directly to the internet would
// let clients spoof their IP past the login rate limit — don't.
const fastify = Fastify({ trustProxy: true });

function hasValidSession(request) {
  const cookie = (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return false;
  const [expiresAt, signature] = cookie.slice(SESSION_COOKIE.length + 1).split('.');
  if (!expiresAt || !signature || Number(expiresAt) < Date.now()) return false;
  const expected = Buffer.from(sign(expiresAt));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function sessionCookie(request, value, maxAgeSeconds) {
  const secure = request.protocol === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

fastify.get('/', (_request, reply) => {
  reply.type('text/html').header('Cache-Control', 'no-store').send(fs.createReadStream(PAGE));
});

fastify.get('/health', async () => ({ ok: true }));

fastify.get('/session', (request) => ({ authenticated: hasValidSession(request) }));

fastify.post('/login', (request, reply) => {
  const now = Date.now();
  const record = failedLogins.get(request.ip);
  if (record && now - record.since > FAILED_LOGIN_WINDOW_MS) failedLogins.delete(request.ip);
  if ((failedLogins.get(request.ip)?.count ?? 0) >= MAX_FAILED_LOGINS) {
    reply.code(429).send({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    return;
  }
  const attempt = crypto.createHash('sha256').update(String(request.body?.password ?? '')).digest();
  if (!crypto.timingSafeEqual(attempt, passwordDigest)) {
    const current = failedLogins.get(request.ip) ?? { count: 0, since: now };
    failedLogins.set(request.ip, { count: current.count + 1, since: current.since });
    reply.code(401).send({ error: 'Wrong password.' });
    return;
  }
  failedLogins.delete(request.ip);
  const expiresAt = now + SESSION_TTL_SECONDS * 1000;
  reply
    .header('Set-Cookie', sessionCookie(request, `${expiresAt}.${sign(expiresAt)}`, SESSION_TTL_SECONDS))
    .send({ ok: true });
});

fastify.post('/logout', (request, reply) => {
  reply.header('Set-Cookie', sessionCookie(request, '', 0)).send({ ok: true });
});

// /api/<path> -> token-service /admin/<path>, streamed both ways so audio playback and seeking work.
fastify.all('/api/*', async (request, reply) => {
  if (!hasValidSession(request)) {
    reply.code(401).send({ error: 'Not logged in.' });
    return;
  }
  const headers = { Authorization: `Bearer ${ADMIN_SHARED_SECRET}` };
  if (request.headers.range) headers.Range = request.headers.range;
  let body;
  if (request.body !== undefined && request.method !== 'GET' && request.method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(request.body);
  }
  let upstream;
  try {
    upstream = await fetch(`${TOKEN_SERVICE_URL}/admin${request.url.slice('/api'.length)}`, {
      method: request.method,
      headers,
      body,
    });
  } catch (err) {
    console.error('Failed to reach token-service:', err);
    reply.code(502).send({ error: 'Could not reach token-service. Is the droplet up?' });
    return;
  }
  reply.code(upstream.status);
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) reply.header(name, value);
  }
  return reply.send(upstream.body ? Readable.fromWeb(upstream.body) : null);
});

fastify
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log(`admin listening on :${PORT} (token-service: ${TOKEN_SERVICE_URL})`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
