require('dotenv/config');
const express = require('express');
const path = require('path');

const app = express();

const TOKEN_SERVICE_URL = process.env.TOKEN_SERVICE_URL ?? 'http://localhost:8880';
const TOKEN_SERVICE_SHARED_SECRET = process.env.TOKEN_SERVICE_SHARED_SECRET;

if (!TOKEN_SERVICE_SHARED_SECRET) {
  throw new Error('TOKEN_SERVICE_SHARED_SECRET is required (copy .env.example to .env).');
}

app.use(express.static(path.join(__dirname, 'public')));

// The browser never sees TOKEN_SERVICE_SHARED_SECRET: this endpoint holds it
// and proxies to token-service server-side, same shape Petition Studio's own
// backend will eventually use.
app.get('/connect', async (req, res) => {
  const room = String(req.query.room ?? '').trim();
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

const port = Number(process.env.PORT ?? 8888);
app.listen(port, '0.0.0.0', () => {
  console.log(`test-call listening on :${port} (LAN-reachable)`);
});
