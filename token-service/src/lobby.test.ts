import test from 'node:test';
import assert from 'node:assert/strict';
import { ASK_STALE_MS, ASK_TIMEOUT_MS, Lobby } from './lobby';

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('asking twice from the same identity keeps one request', () => {
  const lobby = new Lobby(clock().now);
  const first = lobby.ask('r', 'alice', 'Alice');
  const second = lobby.ask('r', 'alice', 'Alice W');
  assert.equal(second.id, first.id);
  assert.deepEqual(lobby.pending('r').map((p) => p.name), ['Alice W']);
});

test('admit lets the asker in, and later joins by that identity skip the waiting room', () => {
  const lobby = new Lobby(clock().now);
  const a = lobby.ask('r', 'alice', 'Alice');
  const b = lobby.ask('r', 'bob', 'Bob');
  assert.equal(lobby.answer('r', [a.id], true), 1);
  assert.equal(lobby.poll(a.id)?.status, 'admitted');
  assert.equal(lobby.poll(b.id)?.status, 'waiting');
  assert.equal(lobby.isAdmitted('r', 'alice'), true);
  assert.equal(lobby.isAdmitted('r', 'bob'), false);
  lobby.revoke('r', 'alice');
  assert.equal(lobby.isAdmitted('r', 'alice'), false);
});

test('answering all only touches waiting requests in that room', () => {
  const lobby = new Lobby(clock().now);
  const a = lobby.ask('r', 'alice', 'Alice');
  const other = lobby.ask('other', 'carol', 'Carol');
  lobby.answer('r', [a.id], false);
  lobby.ask('r', 'bob', 'Bob');
  assert.equal(lobby.answer('r', 'all', true), 1);
  assert.equal(lobby.poll(a.id)?.status, 'denied');
  assert.equal(lobby.poll(other.id)?.status, 'waiting');
});

test('an asker that keeps polling times out after ASK_TIMEOUT_MS', () => {
  const c = clock();
  const lobby = new Lobby(c.now);
  const a = lobby.ask('r', 'alice', 'Alice');
  for (let waited = 0; waited < ASK_TIMEOUT_MS; waited += 5_000) {
    c.advance(5_000);
    lobby.poll(a.id);
  }
  c.advance(5_000);
  assert.equal(lobby.poll(a.id)?.status, 'timeout');
  assert.deepEqual(lobby.pending('r'), []);
});

test('an asker that stops polling disappears from the pending list', () => {
  const c = clock();
  const lobby = new Lobby(c.now);
  const a = lobby.ask('r', 'alice', 'Alice');
  c.advance(ASK_STALE_MS + 1);
  assert.deepEqual([...lobby.sweep()], ['r']);
  assert.equal(lobby.poll(a.id), null);
});

test('a host removal keeps that identity out of that room until the room ends', () => {
  const lobby = new Lobby(clock().now);
  const ask = lobby.ask('r', 'alice', 'Alice');
  lobby.admit('r', 'alice');
  lobby.remove('r', 'alice');
  assert.equal(lobby.isRemoved('r', 'alice'), true);
  assert.equal(lobby.isAdmitted('r', 'alice'), false);
  assert.equal(lobby.poll(ask.id)?.status, 'denied');
  assert.equal(lobby.isRemoved('other', 'alice'), false);
  lobby.forgetRoom('r');
  assert.equal(lobby.isRemoved('r', 'alice'), false);
});
