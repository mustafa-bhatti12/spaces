require('dotenv/config');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const fs = require('fs');
const path = require('path');
const https = require('https');
const httpProxy = require('http-proxy');

const TOKEN_SERVICE_URL = process.env.TOKEN_SERVICE_URL ?? 'http://localhost:8880';
const TOKEN_SERVICE_SHARED_SECRET = process.env.TOKEN_SERVICE_SHARED_SECRET;
const LIVEKIT_HTTP_URL = (process.env.LIVEKIT_URL ?? 'ws://localhost:7880').replace(/^ws/, 'http');

if (!TOKEN_SERVICE_SHARED_SECRET) {
  throw new Error('TOKEN_SERVICE_SHARED_SECRET is required (copy .env.example to .env).');
}

const port = Number(process.env.PORT ?? 8888);
const wssProxyPort = Number(process.env.WSS_PROXY_PORT ?? 8889);
const certPath = path.join(__dirname, 'certs', 'cert.pem');
const keyPath = path.join(__dirname, 'certs', 'key.pem');
const hasCert = fs.existsSync(certPath) && fs.existsSync(keyPath);
const tlsOptions = hasCert ? { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) } : null;

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

// Forward LiveKit HTTP endpoints (/rtc/*, /twirp/*) directly on this server port. Fastify's router
// needs the wildcard on its own path segment (unlike Express's glued `/rtc*`), so register both the
// bare prefix and everything under it. `reply.hijack()` hands the raw response to http-proxy so
// Fastify doesn't also try to send one.
function forwardToLiveKit(request, reply) {
  reply.hijack();
  proxy.web(request.raw, reply.raw);
}
fastify.all('/rtc', forwardToLiveKit);
fastify.all('/rtc/*', forwardToLiveKit);
fastify.all('/twirp', forwardToLiveKit);
fastify.all('/twirp/*', forwardToLiveKit);

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
    // Point the browser at the same host & port (or wss proxy), so Firefox only needs
    // one certificate acceptance for both the web app and WebSockets/LiveKit signaling.
    const host = request.headers.host || `${request.hostname}:${port}`;
    const protocol = hasCert ? 'wss' : 'ws';
    details.serverUrl = `${protocol}://${host}`;
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

fastify
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    if (hasCert) {
      console.log(`test-call listening on https://0.0.0.0:${port} (LAN-reachable, self-signed cert)`);
      console.log('Each browser will warn "not private" once — that is expected for a self-signed cert; proceed past it.');
    } else {
      console.warn(
        'No certs/cert.pem + certs/key.pem found — falling back to plain http, no wss proxy either.',
      );
      console.log(`test-call listening on http://0.0.0.0:${port} (LAN-reachable)`);
    }

    // WebSocket upgrades (LiveKit signaling) are proxied below the Fastify request pipeline
    // entirely, straight off the real Node server Fastify creates and exposes as `fastify.server`.
    fastify.server.on('upgrade', (req, socket, head) => {
      proxy.ws(req, socket, head);
    });

    if (hasCert) {
      // Keep standalone proxy on wssProxyPort (8889) as fallback
      const proxyServer = https.createServer(tlsOptions, (req, res) => proxy.web(req, res));
      proxyServer.on('upgrade', (req, socket, head) => proxy.ws(req, socket, head));
      proxyServer.listen(wssProxyPort, '0.0.0.0', () => {
        console.log(`wss proxy fallback listening on wss://0.0.0.0:${wssProxyPort}`);
      });
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
