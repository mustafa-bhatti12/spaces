require('dotenv/config');
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const httpProxy = require('http-proxy');

const app = express();

const TOKEN_SERVICE_URL = process.env.TOKEN_SERVICE_URL ?? 'http://localhost:8880';
const TOKEN_SERVICE_SHARED_SECRET = process.env.TOKEN_SERVICE_SHARED_SECRET;
const LIVEKIT_HTTP_URL = (process.env.LIVEKIT_URL ?? 'ws://localhost:7880').replace(/^ws/, 'http');

if (!TOKEN_SERVICE_SHARED_SECRET) {
  throw new Error('TOKEN_SERVICE_SHARED_SECRET is required (copy .env.example to .env).');
}
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

const proxy = httpProxy.createProxyServer({ target: LIVEKIT_HTTP_URL, ws: true });
proxy.on('error', (err) => console.error('LiveKit proxy error:', err.message));
proxy.on('proxyRes', (proxyRes) => {
  proxyRes.headers['access-control-allow-origin'] = '*';
  proxyRes.headers['access-control-allow-methods'] = 'GET, POST, OPTIONS, PUT, DELETE';
  proxyRes.headers['access-control-allow-headers'] = '*';
});

// Forward LiveKit HTTP endpoints (/rtc/*, /twirp/*) directly on this server port
app.all(['/rtc*', '/twirp*'], (req, res) => {
  proxy.web(req, res);
});

app.use(express.static(path.join(__dirname, 'public')));
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
app.get('/connect', async (req, res) => {
  const room = normalizeRoomName(req.query.room);
  const name = String(req.query.name ?? '').trim();
  const deviceId = String(req.query.deviceId ?? '').trim();
  if (!room || !name) {
    res.status(400).json({ error: 'room and name query params are required.' });
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
      res.status(502).json({ error: `token-service responded ${upstream.status}` });
      return;
    }
    const details = await upstream.json();
    // Point the browser at the same host & port (or wss proxy), so Firefox only needs
    // one certificate acceptance for both the web app and WebSockets/LiveKit signaling.
    const host = req.headers.host || `${req.hostname}:${port}`;
    const protocol = hasCert ? 'wss' : 'ws';
    details.serverUrl = `${protocol}://${host}`;
    res.json(details);
  } catch (err) {
    console.error('Failed to reach token-service:', err);
    res.status(502).json({ error: 'Could not reach token-service. Is it running?' });
  }
});

// Powers the room picker: lets whoever opens the page second see rooms the first person already
// started, instead of having to be told an exact string to type.
app.get('/rooms', async (_req, res) => {
  try {
    const upstream = await fetch(`${TOKEN_SERVICE_URL}/rooms`, {
      headers: { Authorization: `Bearer ${TOKEN_SERVICE_SHARED_SECRET}` },
    });
    if (!upstream.ok) {
      res.status(502).json({ error: `token-service responded ${upstream.status}` });
      return;
    }
    res.json(await upstream.json());
  } catch (err) {
    console.error('Failed to reach token-service:', err);
    res.status(502).json({ error: 'Could not reach token-service. Is it running?' });
  }
});

// Heartbeat for the client-side duplicate-identity check: LiveKit's push-based disconnect signal
// to the losing side of a duplicate-identity join wasn't observed firing promptly in testing, so
// the client instead polls this while connected and self-disconnects the moment the sid it holds
// no longer matches the one LiveKit currently has on file for its identity.
app.get('/whoami', async (req, res) => {
  const room = normalizeRoomName(req.query.room);
  const identity = String(req.query.identity ?? '').trim();
  if (!room || !identity) {
    res.status(400).json({ error: 'room and identity query params are required.' });
    return;
  }
  try {
    const upstream = await fetch(
      `${TOKEN_SERVICE_URL}/participant?room=${encodeURIComponent(room)}&identity=${encodeURIComponent(identity)}`,
      { headers: { Authorization: `Bearer ${TOKEN_SERVICE_SHARED_SECRET}` } },
    );
    if (!upstream.ok) {
      res.status(502).json({ error: `token-service responded ${upstream.status}` });
      return;
    }
    res.json(await upstream.json());
  } catch (err) {
    console.error('Failed to reach token-service:', err);
    res.status(502).json({ error: 'Could not reach token-service. Is it running?' });
  }
});

const port = Number(process.env.PORT ?? 8888);
const wssProxyPort = Number(process.env.WSS_PROXY_PORT ?? 8889);
const certPath = path.join(__dirname, 'certs', 'cert.pem');
const keyPath = path.join(__dirname, 'certs', 'key.pem');
const hasCert = fs.existsSync(certPath) && fs.existsSync(keyPath);

if (hasCert) {
  const tlsOptions = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };

  const mainServer = https.createServer(tlsOptions, app);
  mainServer.on('upgrade', (req, socket, head) => {
    proxy.ws(req, socket, head);
  });
  mainServer.listen(port, '0.0.0.0', () => {
    console.log(`test-call listening on https://0.0.0.0:${port} (LAN-reachable, self-signed cert)`);
    console.log('Each browser will warn "not private" once — that is expected for a self-signed cert; proceed past it.');
  });

  // Keep standalone proxy on wssProxyPort (8889) as fallback
  const proxyServer = https.createServer(tlsOptions, (req, res) => proxy.web(req, res));
  proxyServer.on('upgrade', (req, socket, head) => proxy.ws(req, socket, head));
  proxyServer.listen(wssProxyPort, '0.0.0.0', () => {
    console.log(`wss proxy fallback listening on wss://0.0.0.0:${wssProxyPort}`);
  });
} else {
  console.warn(
    'No certs/cert.pem + certs/key.pem found — falling back to plain http, no wss proxy either.',
  );
  const mainServer = http.createServer(app);
  mainServer.on('upgrade', (req, socket, head) => {
    proxy.ws(req, socket, head);
  });
  mainServer.listen(port, '0.0.0.0', () => {
    console.log(`test-call listening on http://0.0.0.0:${port} (LAN-reachable)`);
  });
}
