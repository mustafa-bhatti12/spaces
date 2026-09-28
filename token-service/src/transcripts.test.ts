import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecordingName } from './transcripts';

// /recording/transcripts?room= matches recordings to a room by this parse, so a room whose own
// name ends in digits or contains dashes must not be confused with another room's recordings.
test('parseRecordingName splits room and time at the last 13-digit stamp', () => {
  assert.deepEqual(parseRecordingName('case-1-brainstorm-1790340266388.ogg'), {
    room: 'case-1-brainstorm',
    recordedAt: new Date(1790340266388).toISOString(),
  });
  assert.equal(parseRecordingName('sunny-summit-306-1790340266388.ogg')?.room, 'sunny-summit-306');
});

test('parseRecordingName rejects files egress never names that way', () => {
  assert.equal(parseRecordingName('EG_abc.json'), null);
  assert.equal(parseRecordingName('room-179034026638.ogg'), null);
  assert.equal(parseRecordingName('-1790340266388.ogg'), null);
});
