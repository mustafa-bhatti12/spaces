require('dotenv/config');
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();

const TOKEN_SERVICE_URL = process.env.TOKEN_SERVICE_URL ?? 'http://localhost:8880';
const TOKEN_SERVICE_SHARED_SECRET = process.env.TOKEN_SERVICE_SHARED_SECRET;

if (!TOKEN_SERVICE_SHARED_SECRET) {
  throw new Error('TOKEN_SERVICE_SHARED_SECRET is required (copy .env.example to .env).');
}

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
  if (!room || !name) {
    res.status(400).json({ error: 'room and name query params are required.' });
    return;
  }
  const identity = `${name}__${Math.random().toString(36).slice(2, 8)}`;

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
    res.json(await upstream.json());
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

const port = Number(process.env.PORT ?? 8888);
const certPath = path.join(__dirname, 'certs', 'cert.pem');
const keyPath = path.join(__dirname, 'certs', 'key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  https
    .createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
    .listen(port, '0.0.0.0', () => {
      console.log(`test-call listening on https://0.0.0.0:${port} (LAN-reachable, self-signed cert)`);
      console.log('Each browser will warn "not private" once — that is expected for a self-signed cert; proceed past it.');
    });
} else {
  console.warn(
    'No certs/cert.pem + certs/key.pem found — falling back to plain http. ' +
      'Camera/mic will only work from http://localhost, not from a second machine. ' +
      'Generate one with: openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem -days 30 ' +
      '-subj "/CN=test-call" -addext "subjectAltName=IP:<your-lan-ip>,IP:127.0.0.1,DNS:localhost"',
  );
  http.createServer(app).listen(port, '0.0.0.0', () => {
    console.log(`test-call listening on http://0.0.0.0:${port} (LAN-reachable)`);
  });
}
