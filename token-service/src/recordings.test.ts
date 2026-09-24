import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RECORDING_DIRS, resolveRecordingFile } from './recordings';

test('resolves an egress-named file inside its kind directory', () => {
  assert.equal(
    resolveRecordingFile('compressed', 'case-1-brainstorm-1758700000000.ogg'),
    path.resolve(RECORDING_DIRS.compressed, 'case-1-brainstorm-1758700000000.ogg'),
  );
  assert.equal(resolveRecordingFile('raw', 'r-1.ogg'), path.resolve(RECORDING_DIRS.raw, 'r-1.ogg'));
});

test('rejects names that could leave the recordings directory', () => {
  for (const name of ['..', '../raw/x.ogg', '../../token-service/.env', 'a/b.ogg', 'a\\b.ogg', '/etc/passwd', '.env', '', '%2e%2e']) {
    assert.equal(resolveRecordingFile('compressed', name), null, name);
  }
});

test('rejects unknown or prototype-inherited kinds', () => {
  for (const kind of ['', 'egress', '..', 'constructor', '__proto__', 'toString']) {
    assert.equal(resolveRecordingFile(kind, 'x.ogg'), null, kind);
  }
});
