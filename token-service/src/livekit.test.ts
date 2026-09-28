import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessToken } from 'livekit-server-sdk';
import { mintToken, listActiveRooms, tokenIdentity, inspectJoinToken } from './livekit';

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

// tokenIdentity is the gate in front of every host action (which then checks the room's hosts list).
test('tokenIdentity returns who a token was issued to, for its own room', async () => {
  useDevEnv();
  const guest = await mintToken({ room: 'r1', identity: 'guest', name: 'Guest' });
  assert.equal(await tokenIdentity('r1', guest.participantToken), 'guest');
});

test('tokenIdentity refuses a token for a different room', async () => {
  useDevEnv();
  const host = await mintToken({ room: 'r1', identity: 'host', name: 'Host' });
  assert.equal(await tokenIdentity('r2', host.participantToken), null);
});

test('tokenIdentity refuses a token signed with another secret', async () => {
  process.env.LIVEKIT_API_SECRET = 'someone-elses-secret';
  const forged = await mintToken({ room: 'r1', identity: 'host', name: 'Host' });
  useDevEnv();
  assert.equal(await tokenIdentity('r1', forged.participantToken), null);
});

test('inspectJoinToken returns room, identity and name from a valid join token', async () => {
  useDevEnv();
  const { participantToken } = await mintToken({ room: 'r1', identity: 'u1', name: 'Sara' });
  const session = await inspectJoinToken(participantToken);
  assert.deepEqual(session, { room: 'r1', identity: 'u1', name: 'Sara', serverUrl: 'ws://localhost:7880' });
});

test('inspectJoinToken prefers LIVEKIT_PUBLIC_URL for the browser', async () => {
  useDevEnv();
  process.env.LIVEKIT_PUBLIC_URL = 'wss://calls.example.com';
  try {
    const { participantToken } = await mintToken({ room: 'r1', identity: 'u1', name: 'Sara' });
    assert.equal((await inspectJoinToken(participantToken))?.serverUrl, 'wss://calls.example.com');
  } finally {
    delete process.env.LIVEKIT_PUBLIC_URL;
  }
});

test('inspectJoinToken rejects a token signed with another secret', async () => {
  useDevEnv();
  const at = new AccessToken('devkey', 'not-the-secret', { identity: 'u1', name: 'x' });
  at.addGrant({ room: 'r1', roomJoin: true });
  assert.equal(await inspectJoinToken(await at.toJwt()), null);
});

test('inspectJoinToken rejects a token without a room join grant', async () => {
  useDevEnv();
  const at = new AccessToken('devkey', 'secret', { identity: 'u1' });
  at.addGrant({ roomList: true });
  assert.equal(await inspectJoinToken(await at.toJwt()), null);
});

test('inspectJoinToken rejects garbage', async () => {
  useDevEnv();
  assert.equal(await inspectJoinToken('not-a-jwt'), null);
});
