require('dotenv/config');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const fs = require('fs');
const path = require('path');
const httpProxy = require('http-proxy');
const { registerAdmin } = require('./admin');

const TOKEN_SERVICE_URL = process.env.TOKEN_SERVICE_URL ?? 'http://localhost:8880';
const TOKEN_SERVICE_SHARED_SECRET = process.env.TOKEN_SERVICE_SHARED_SECRET;
const LIVEKIT_HTTP_URL = (process.env.LIVEKIT_URL ?? 'ws://localhost:7880').replace(/^ws/, 'http');

if (!TOKEN_SERVICE_SHARED_SECRET) {
  throw new Error('TOKEN_SERVICE_SHARED_SECRET is required (copy .env.example to .env).');
}

const port = Number(process.env.PORT ?? 8888);
const certPath = path.join(__dirname, 'certs', 'cert.pem');
const keyPath = path.join(__dirname, 'certs', 'key.pem');
// Codespaces / SPACE_HTTP=1: TLS is terminated at github.dev (or nginx/Caddy). Serving a
// leftover self-signed cert on :8888 would make the proxy's HTTP health-check fail.
const behindProxy = process.env.SPACE_HTTP === '1' || Boolean(process.env.CODESPACES || process.env.CODESPACE_NAME);
const hasCert = !behindProxy && fs.existsSync(certPath) && fs.existsSync(keyPath);
const tlsOptions = hasCert ? { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) } : null;

// Codespaces (and any TLS-terminating proxy) talks HTTP to this process but the
// browser sees HTTPS. Honor X-Forwarded-* so we advertise wss://<public-host>
// instead of ws://localhost, which mixed-content blocking would refuse.
function firstForwarded(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return value.split(',')[0].trim();
}
function clientFacingHttps(request) {
  if (hasCert) return true;
  return firstForwarded(request.headers['x-forwarded-proto']).toLowerCase() === 'https';
}
function clientFacingHost(request) {
  return (
    firstForwarded(request.headers['x-forwarded-host']) ||
    request.headers.host ||
    `${request.hostname}:${port}`
  );
}

const fastify = Fastify(hasCert ? { https: tlsOptions } : {});

fastify.addHook('onRequest', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  reply.header('Access-Control-Allow-Headers', '*');
  if (request.method === 'OPTIONS') {
    reply.code(204).send();
  }
});

const proxy = httpProxy.createProxyServer({ target: LIVEKIT_HTTP_URL, ws: true });
proxy.on('error', (err) => console.error('LiveKit proxy error:', err.message));
proxy.on('proxyRes', (proxyRes) => {
  proxyRes.headers['access-control-allow-origin'] = '*';
  proxyRes.headers['access-control-allow-methods'] = 'GET, POST, OPTIONS, PUT, DELETE';
  proxyRes.headers['access-control-allow-headers'] = '*';
});

// Forward LiveKit's client signaling endpoint (/rtc, /rtc/*) directly on this server port. Only
// /rtc: LiveKit's admin API (/twirp) is server-to-server and must never be reachable through this
// public proxy — token-service talks to it on localhost. Fastify's router needs the wildcard on its
// own path segment (unlike Express's glued `/rtc*`), so register both the bare prefix and everything
// under it. `reply.hijack()` hands the raw response to http-proxy so Fastify doesn't also try to
// send one.
function isLiveKitClientPath(url) {
  return url === '/rtc' || url.startsWith('/rtc/') || url.startsWith('/rtc?');
}
function forwardToLiveKit(request, reply) {
  reply.hijack();
  proxy.web(request.raw, reply.raw);
}
fastify.all('/rtc', forwardToLiveKit);
fastify.all('/rtc/*', forwardToLiveKit);

fastify.register(fastifyStatic, { root: path.join(__dirname, 'public') });

// Browsers only grant camera/mic access on a "secure context" — https, or the single special
// case of http://localhost. A second laptop loading this over plain http://<lan-ip> gets no
// permission prompt at all: getUserMedia rejects immediately, silently, with no dialog. Hence the
// self-signed cert below instead of plain http.
function normalizeRoomName(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

// The browser never sees TOKEN_SERVICE_SHARED_SECRET: this endpoint holds it
// and proxies to token-service server-side, same shape a real consuming
// backend will eventually use.
fastify.get('/connect', async (request, reply) => {
  const room = normalizeRoomName(request.query.room);
  const name = String(request.query.name ?? '').trim();
  const deviceId = String(request.query.deviceId ?? '').trim();
  if (!room || !name) {
    reply.code(400).send({ error: 'room and name query params are required.' });
    return;
  }
  // Identity is what LiveKit uses to tell participants apart within a room: joining again with
  // the same identity replaces the earlier connection rather than adding a second one. Keying it
  // on a per-browser id (persisted client-side in localStorage) instead of the free-typed name
  // means two tabs in the *same browser* can't both be in the call under different display names
  // -- the second join kicks the first. A different browser, or a private window, has its own
  // localStorage and so its own id; no server-side signal distinguishes that from a genuinely
  // different laptop, and no browser API exposes real machine identity for this to check instead.
  const identity = deviceId || `${name}__${Math.random().toString(36).slice(2, 8)}`;

  try {
    const upstream = await fetch(`${TOKEN_SERVICE_URL}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN_SERVICE_SHARED_SECRET}`,
      },
      body: JSON.stringify({ room, identity, name }),
    });
    if (!upstream.ok) {
      reply.code(502).send({ error: `token-service responded ${upstream.status}` });
      return;
    }
    const details = await upstream.json();
    // A deployed token-service (LIVEKIT_PUBLIC_URL set) hands back the public wss:// LiveKit host:
    // use it as-is, exactly like Petition Studio will. Otherwise (local dev) it returns the
    // internal ws://localhost URL, so point the browser at this server's own /rtc proxy instead —
    // same host & cert, so Firefox only needs one certificate acceptance for page + signaling.
    if (!String(details.serverUrl ?? '').startsWith('wss://')) {
      const protocol = clientFacingHttps(request) ? 'wss' : 'ws';
      details.serverUrl = `${protocol}://${clientFacingHost(request)}`;
    }
    reply.send(details);
  } catch (err) {
    console.error('Failed to reach token-service:', err);
    reply.code(502).send({ error: 'Could not reach token-service. Is it running?' });
  }
});

// Powers the room picker: lets whoever opens the page second see rooms the first person already
// started, instead of having to be told an exact string to type.
fastify.get('/rooms', async (_request, reply) => {
  try {
    const upstream = await fetch(`${TOKEN_SERVICE_URL}/rooms`, {
      headers: { Authorization: `Bearer ${TOKEN_SERVICE_SHARED_SECRET}` },
    });
    if (!upstream.ok) {
      reply.code(502).send({ error: `token-service responded ${upstream.status}` });
      return;
    }
    reply.send(await upstream.json());
  } catch (err) {
    console.error('Failed to reach token-service:', err);
    reply.code(502).send({ error: 'Could not reach token-service. Is it running?' });
  }
});

// Heartbeat for the client-side duplicate-identity check: LiveKit's push-based disconnect signal
// to the losing side of a duplicate-identity join wasn't observed firing promptly in testing, so
// the client instead polls this while connected and self-disconnects the moment the sid it holds
// no longer matches the one LiveKit currently has on file for its identity.
fastify.get('/whoami', async (request, reply) => {
  const room = normalizeRoomName(request.query.room);
  const identity = String(request.query.identity ?? '').trim();
  if (!room || !identity) {
    reply.code(400).send({ error: 'room and identity query params are required.' });
    return;
  }
  try {
    const upstream = await fetch(
      `${TOKEN_SERVICE_URL}/participant?room=${encodeURIComponent(room)}&identity=${encodeURIComponent(identity)}`,
      { headers: { Authorization: `Bearer ${TOKEN_SERVICE_SHARED_SECRET}` } },
    );
    if (!upstream.ok) {
      reply.code(502).send({ error: `token-service responded ${upstream.status}` });
      return;
    }
    reply.send(await upstream.json());
  } catch (err) {
    console.error('Failed to reach token-service:', err);
    reply.code(502).send({ error: 'Could not reach token-service. Is it running?' });
  }
});

// Recording controls: same proxy shape as /connect and /rooms, just forwarding to
// token-service's /recording/* routes so the browser never needs the shared secret.
fastify.post('/recording/start', async (request, reply) => {
  const room = normalizeRoomName(request.query.room);
  const startedBy = String(request.query.startedBy ?? '').trim();
  if (!room) {
    reply.code(400).send({ error: 'room query param is required.' });
    return;
  }
  try {
    const upstream = await fetch(`${TOKEN_SERVICE_URL}/recording/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_SERVICE_SHARED_SECRET}` },
      body: JSON.stringify({ room, startedBy: startedBy || undefined }),
    });
    if (!upstream.ok) {
      reply.code(502).send({ error: `token-service responded ${upstream.status}` });
      return;
    }
    reply.send(await upstream.json());
  } catch (err) {
    console.error('Failed to reach token-service:', err);
    reply.code(502).send({ error: 'Could not reach token-service. Is it running?' });
  }
});

fastify.post('/recording/stop', async (request, reply) => {
  const egressId = String(request.query.egressId ?? '').trim();
  if (!egressId) {
    reply.code(400).send({ error: 'egressId query param is required.' });
    return;
  }
  try {
    const upstream = await fetch(`${TOKEN_SERVICE_URL}/recording/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_SERVICE_SHARED_SECRET}` },
      body: JSON.stringify({ egressId }),
    });
    if (!upstream.ok) {
      reply.code(502).send({ error: `token-service responded ${upstream.status}` });
      return;
    }
    reply.send(await upstream.json());
  } catch (err) {
    console.error('Failed to reach token-service:', err);
    reply.code(502).send({ error: 'Could not reach token-service. Is it running?' });
  }
});

fastify.get('/recording/status', async (request, reply) => {
  const room = normalizeRoomName(request.query.room);
  if (!room) {
    reply.code(400).send({ error: 'room query param is required.' });
    return;
  }
  try {
    const upstream = await fetch(`${TOKEN_SERVICE_URL}/recording/status?room=${encodeURIComponent(room)}`, {
      headers: { Authorization: `Bearer ${TOKEN_SERVICE_SHARED_SECRET}` },
    });
    if (!upstream.ok) {
      reply.code(502).send({ error: `token-service responded ${upstream.status}` });
      return;
    }
    reply.send(await upstream.json());
  } catch (err) {
    console.error('Failed to reach token-service:', err);
    reply.code(502).send({ error: 'Could not reach token-service. Is it running?' });
  }
});

registerAdmin(fastify, {
  tokenServiceUrl: TOKEN_SERVICE_URL,
  isHttps: clientFacingHttps,
  trustForwardedFor: behindProxy,
});

fastify
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    if (hasCert) {
      console.log(`test-call listening on https://0.0.0.0:${port} (LAN-reachable, self-signed cert)`);
      console.log('Each browser will warn "not private" once — that is expected for a self-signed cert; proceed past it.');
    } else if (behindProxy) {
      console.log(
        `test-call listening on http://0.0.0.0:${port} (TLS terminated upstream — use the public https URL, not http://localhost from another machine)`,
      );
    } else {
      console.warn(
        'No certs/cert.pem + certs/key.pem found — falling back to plain http. Camera/mic on a second machine will only work from http://localhost.',
      );
      console.log(`test-call listening on http://0.0.0.0:${port} (LAN-reachable)`);
    }

    // WebSocket upgrades (LiveKit signaling) are proxied below the Fastify request pipeline
    // entirely, straight off the real Node server Fastify creates and exposes as `fastify.server`.
    fastify.server.on('upgrade', (req, socket, head) => {
      if (!isLiveKitClientPath(req.url)) {
        socket.destroy();
        return;
      }
      // Without a listener, a client resetting its socket (e.g. after LiveKit rejects a bad token)
      // is an unhandled 'error' event and takes the whole process down.
      socket.on('error', (err) => console.error('LiveKit WS client socket error:', err.message));
      proxy.ws(req, socket, head);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
