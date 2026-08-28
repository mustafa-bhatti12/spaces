import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintToken, listActiveRooms } from './livekit';

test('throws when LiveKit env vars are missing', async () => {
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  delete process.env.LIVEKIT_URL;
  await assert.rejects(() => mintToken({ room: 'r', identity: 'i', name: 'n' }));
});

test('returns connection details shaped for the caller when env vars are present', async () => {
  process.env.LIVEKIT_API_KEY = 'devkey';
  process.env.LIVEKIT_API_SECRET = 'secret';
  process.env.LIVEKIT_URL = 'ws://localhost:7880';

  const details = await mintToken({ room: 'case-1-brainstorm', identity: 'user-1__ab12', name: 'writer@hof.test' });

  assert.equal(details.serverUrl, 'ws://localhost:7880');
  assert.equal(details.roomName, 'case-1-brainstorm');
  assert.equal(details.participantName, 'writer@hof.test');
  assert.equal(typeof details.participantToken, 'string');
  assert.ok(details.participantToken.length > 0);
});

test('listActiveRooms throws when LiveKit env vars are missing', async () => {
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  delete process.env.LIVEKIT_URL;
  await assert.rejects(() => listActiveRooms());
});
