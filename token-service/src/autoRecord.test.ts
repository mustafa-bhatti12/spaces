import test from 'node:test';
import assert from 'node:assert/strict';
import { onRecordingStoppedByHand, shouldAutoRecord } from './autoRecord';

// RECORD_ALL_CALLS is unset under `npm test`, so only the room's own flag can turn recording on.
const marked = JSON.stringify({ hosts: ['h'], waitingRoom: false, spotlight: null, record: true });

test('a room marked on /token records on join; an unmarked or unreadable one does not', () => {
  assert.equal(shouldAutoRecord('a', 0, marked), true);
  assert.equal(shouldAutoRecord('b', 0, JSON.stringify({ hosts: ['h'] })), false);
  assert.equal(shouldAutoRecord('c', 0, undefined), false);
  assert.equal(shouldAutoRecord('d', 0, 'not json'), false);
});

test('the recorder joining its own room does not start a recording', () => {
  assert.equal(shouldAutoRecord('e', 2, marked), false);
});

test('once stopped by hand a marked room stays unrecorded for later joins', () => {
  onRecordingStoppedByHand('f');
  assert.equal(shouldAutoRecord('f', 0, marked), false);
});
