const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

// Space control center, mounted at /admin on the test-call server so one Railway service hosts both
// the call page (/) and the operator console (/admin). Self-contained on purpose: test-call is
// throwaway, the admin is not — when test-call is deleted, move this file + admin.html into their
// own tiny Fastify service instead of deleting them.
//
// Holds ADMIN_SHARED_SECRET (token-service's /admin/* routes) and ADMIN_PASSWORD (the only login in
// the repo). The call page never sees either: they stay server-side in this process.
const SESSION_COOKIE = 'space_admin';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MAX_FAILED_LOGINS = 5;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
// Upstream response headers the page needs: JSON bodies, and audio playback/seeking/download.
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition'];
// Kept outside public/ so the page isn't served at all while the admin is disabled.
const ADMIN_PAGE = path.join(__dirname, 'admin.html');

/**
 * @param trustForwardedFor true when a TLS-terminating proxy (Railway, Caddy, Codespaces) is the
 *   only way in, so X-Forwarded-For is the real client for the login rate limit. When false, the
 *   header is ignored — a direct client could otherwise spoof it to dodge the limit.
 */
function registerAdmin(fastify, { tokenServiceUrl, isHttps, trustForwardedFor }) {
  const password = process.env.ADMIN_PASSWORD ?? '';
  const adminSecret = process.env.ADMIN_SHARED_SECRET ?? '';
  if (!password || !adminSecret) {
    console.log('Admin control center disabled (set ADMIN_PASSWORD and ADMIN_SHARED_SECRET to enable /admin).');
    return;
  }
  const passwordDigest = crypto.createHash('sha256').update(password).digest();
  // Per-process signing key: a restart/redeploy logs the operator out, which is fine for a
  // single-operator tool and means no second secret to manage.
  const signingKey = crypto.randomBytes(32);
  const sign = (expiresAt) => crypto.createHmac('sha256', signingKey).update(String(expiresAt)).digest('base64url');
  const failedLogins = new Map(); // client ip -> { count, since }

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
    const secure = isHttps(request) ? '; Secure' : '';
    return `${SESSION_COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
  }

  function clientIp(request) {
    const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    return trustForwardedFor && forwarded ? forwarded : request.socket.remoteAddress ?? '';
  }

  fastify.get('/admin', (_request, reply) => {
    reply.type('text/html').header('Cache-Control', 'no-store').send(fs.createReadStream(ADMIN_PAGE));
  });

  fastify.get('/admin/session', (request) => ({ authenticated: hasValidSession(request) }));

  fastify.post('/admin/login', (request, reply) => {
    const ip = clientIp(request);
    const now = Date.now();
    const record = failedLogins.get(ip);
    if (record && now - record.since > FAILED_LOGIN_WINDOW_MS) failedLogins.delete(ip);
    if ((failedLogins.get(ip)?.count ?? 0) >= MAX_FAILED_LOGINS) {
      reply.code(429).send({ error: 'Too many failed attempts. Try again in 15 minutes.' });
      return;
    }
    const attempt = crypto.createHash('sha256').update(String(request.body?.password ?? '')).digest();
    if (!crypto.timingSafeEqual(attempt, passwordDigest)) {
      const current = failedLogins.get(ip) ?? { count: 0, since: now };
      failedLogins.set(ip, { count: current.count + 1, since: current.since });
      reply.code(401).send({ error: 'Wrong password.' });
      return;
    }
    failedLogins.delete(ip);
    const expiresAt = now + SESSION_TTL_SECONDS * 1000;
    reply
      .header('Set-Cookie', sessionCookie(request, `${expiresAt}.${sign(expiresAt)}`, SESSION_TTL_SECONDS))
      .send({ ok: true });
  });

  fastify.post('/admin/logout', (request, reply) => {
    reply.header('Set-Cookie', sessionCookie(request, '', 0)).send({ ok: true });
  });

  // /admin/api/<path> -> token-service /admin/<path>, streamed both ways so audio playback and
  // seeking work.
  fastify.all('/admin/api/*', async (request, reply) => {
    if (!hasValidSession(request)) {
      reply.code(401).send({ error: 'Not logged in.' });
      return;
    }
    const headers = { Authorization: `Bearer ${adminSecret}` };
    if (request.headers.range) headers.Range = request.headers.range;
    let body;
    if (request.body !== undefined && request.method !== 'GET' && request.method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(request.body);
    }
    let upstream;
    try {
      upstream = await fetch(`${tokenServiceUrl}/admin${request.url.slice('/admin/api'.length)}`, {
        method: request.method,
        headers,
        body,
      });
    } catch (err) {
      console.error('Failed to reach token-service:', err);
      reply.code(502).send({ error: 'Could not reach token-service. Is it running?' });
      return;
    }
    reply.code(upstream.status);
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) reply.header(name, value);
    }
    return reply.send(upstream.body ? Readable.fromWeb(upstream.body) : null);
  });

  console.log('Admin control center enabled at /admin.');
}

module.exports = { registerAdmin };
