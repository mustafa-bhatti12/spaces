import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintToken, listActiveRooms, endRoomAsHost } from './livekit';

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

function useDevEnv() {
  process.env.LIVEKIT_API_KEY = 'devkey';
  process.env.LIVEKIT_API_SECRET = 'secret';
  process.env.LIVEKIT_URL = 'ws://localhost:7880';
}

test('endRoomAsHost refuses a non-host token for the room', async () => {
  useDevEnv();
  const guest = await mintToken({ room: 'r1', identity: 'guest', name: 'Guest' });
  assert.equal(await endRoomAsHost('r1', guest.participantToken), 'forbidden');
});

test('endRoomAsHost refuses a host token for a different room', async () => {
  useDevEnv();
  const host = await mintToken({ room: 'r1', identity: 'host', name: 'Host', host: true });
  assert.equal(await endRoomAsHost('r2', host.participantToken), 'forbidden');
});

test('endRoomAsHost refuses a host token signed with another secret', async () => {
  process.env.LIVEKIT_API_SECRET = 'someone-elses-secret';
  const forged = await mintToken({ room: 'r1', identity: 'host', name: 'Host', host: true });
  useDevEnv();
  assert.equal(await endRoomAsHost('r1', forged.participantToken), 'forbidden');
});
