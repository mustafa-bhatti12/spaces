import 'dotenv/config';
import express from 'express';
import { mintToken, listActiveRooms, getParticipantSid } from './livekit';
import { requireSharedSecret } from './auth';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/rooms', requireSharedSecret, async (_req, res) => {
  try {
    res.json(await listActiveRooms());
  } catch (err) {
    console.error('Failed to list LiveKit rooms:', err);
    res.status(500).json({ error: 'Could not list rooms.' });
  }
});

app.get('/participant', requireSharedSecret, async (req, res) => {
  const room = String(req.query.room ?? '');
  const identity = String(req.query.identity ?? '');
  if (!room || !identity) {
    res.status(400).json({ error: 'room and identity query params are required.' });
    return;
  }
  try {
    res.json({ sid: await getParticipantSid(room, identity) });
  } catch (err) {
    console.error('Failed to look up LiveKit participant:', err);
    res.status(500).json({ error: 'Could not look up participant.' });
  }
});

app.post('/token', requireSharedSecret, async (req, res) => {
  const { room, identity, name } = req.body ?? {};
  if (
    typeof room !== 'string' ||
    !room ||
    typeof identity !== 'string' ||
    !identity ||
    typeof name !== 'string' ||
    !name
  ) {
    res.status(400).json({ error: 'room, identity and name are required strings.' });
    return;
  }

  try {
    const details = await mintToken({ room, identity, name });
    res.json(details);
  } catch (err) {
    console.error('Failed to mint LiveKit token:', err);
    res.status(500).json({ error: 'Could not mint a token.' });
  }
});

const port = Number(process.env.PORT ?? 8880);
app.listen(port, () => {
  console.log(`token-service listening on :${port}`);
});
