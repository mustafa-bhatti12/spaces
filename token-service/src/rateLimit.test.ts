import assert from 'node:assert/strict';
import test from 'node:test';
import { RateLimiter, WINDOW_MS } from './rateLimit';

test('allows up to the limit, then says how long to wait', () => {
  const l = new RateLimiter();
  assert.deepEqual(l.hit('a', 2, 1000), { allowed: true });
  assert.deepEqual(l.hit('a', 2, 2000), { allowed: true });
  assert.deepEqual(l.hit('a', 2, 11_000), { allowed: false, retryAfterSec: 50 });
});

test('the window resets after a minute', () => {
  const l = new RateLimiter();
  l.hit('a', 1, 0);
  assert.equal(l.hit('a', 1, WINDOW_MS - 1).allowed, false);
  assert.equal(l.hit('a', 1, WINDOW_MS).allowed, true);
});

test('keys are counted separately', () => {
  const l = new RateLimiter();
  l.hit('erp:tokens:mint', 1, 0);
  assert.equal(l.hit('erp:rooms:create', 1, 0).allowed, true);
  assert.equal(l.hit('erp:tokens:mint', 1, 0).allowed, false);
});
