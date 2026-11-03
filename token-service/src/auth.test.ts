import assert from 'node:assert/strict';
import test from 'node:test';
import { authorize } from './auth';
import { AppRegistry } from './apps';
import { RateLimiter } from './rateLimit';

const SECRET = 'shared-secret-for-tests';
const setup = () => ({ r: new AppRegistry(':memory:'), l: new RateLimiter() });

test('a valid key with the scope succeeds as its app', () => {
  const { r, l } = setup();
  const { key, keyId } = r.issueKey('erp');
  const res = authorize(r, l, `Bearer ${key}`, SECRET, 'rooms:create');
  assert.ok(res.ok);
  assert.equal(res.caller.app.slug, 'erp');
  assert.equal(res.caller.keyId, keyId);
  assert.equal(res.caller.via, 'key');
});

test('a key without the scope gets 403', () => {
  const { r, l } = setup();
  const { key } = r.issueKey('spaces-web');
  assert.ok(authorize(r, l, `Bearer ${key}`, SECRET, 'tokens:mint').ok);
  const res = authorize(r, l, `Bearer ${key}`, SECRET, 'rooms:create');
  assert.deepEqual(res.ok, false);
  assert.equal(!res.ok && res.status, 403);
});

test('a revoked or unknown key gets 401, and never falls through to the shared secret', () => {
  const { r, l } = setup();
  const { key, keyId } = r.issueKey('erp');
  r.revokeKey('erp', keyId);
  const revoked = authorize(r, l, `Bearer ${key}`, SECRET, 'tokens:mint');
  assert.equal(!revoked.ok && revoked.status, 401);
  const unknown = authorize(r, l, `Bearer hsk_000000000000_${'a'.repeat(43)}`, SECRET, 'tokens:mint');
  assert.equal(!unknown.ok && unknown.status, 401);
});

test('a missing or wrong credential gets 401', () => {
  const { r, l } = setup();
  for (const h of [undefined, '', 'Bearer', 'Bearer wrong', SECRET]) {
    const res = authorize(r, l, h, SECRET, 'tokens:mint');
    assert.equal(!res.ok && res.status, 401, String(h));
  }
});

test('the shared secret resolves to petition-studio, with every consumer scope', () => {
  const { r, l } = setup();
  const res = authorize(r, l, `Bearer ${SECRET}`, SECRET, 'rooms:end');
  assert.ok(res.ok);
  assert.equal(res.caller.app.slug, 'petition-studio');
  assert.equal(res.caller.via, 'shared-secret');
  assert.equal(res.caller.keyId, null);
  for (const scope of ['rooms:create', 'rooms:read', 'tokens:mint', 'recordings:read'] as const) {
    assert.ok(authorize(r, l, `Bearer ${SECRET}`, SECRET, scope).ok, scope);
  }
  assert.ok(r.listApps().find((a) => a.slug === 'petition-studio')!.lastUsedAt);
});

test('without a configured shared secret only keys work', () => {
  const { r, l } = setup();
  const res = authorize(r, l, `Bearer ${SECRET}`, undefined, 'tokens:mint');
  assert.equal(!res.ok && res.status, 500);
  assert.ok(authorize(r, l, `Bearer ${r.issueKey('erp').key}`, undefined, 'tokens:mint').ok);
});

test('over the app limit gets 429 with Retry-After, per scope', () => {
  const { r, l } = setup();
  const { key } = r.issueKey('erp'); // rooms:create is 30/min
  for (let i = 0; i < 30; i++) assert.ok(authorize(r, l, `Bearer ${key}`, SECRET, 'rooms:create', 1000).ok);
  const over = authorize(r, l, `Bearer ${key}`, SECRET, 'rooms:create', 1000);
  assert.ok(!over.ok && over.status === 429 && over.retryAfterSec === 60);
  assert.ok(authorize(r, l, `Bearer ${key}`, SECRET, 'tokens:mint', 1000).ok);
  assert.ok(authorize(r, l, `Bearer ${key}`, SECRET, 'rooms:create', 61_000).ok);
});
