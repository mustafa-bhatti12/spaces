import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSettings, resetSettings, saveSettings, validateSettings } from './settings';

// settings.ts reads the file path and .env values when first used, so these apply.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-settings-'));
process.env.SPACES_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.RECORDING_AUDIO_KBPS = '24';
process.env.TRANSCRIPTION_LANGUAGE_HINTS = 'en, ur';

const valid = {
  transcription: { enabled: true, languageHints: ['en'], terms: ['USCIS'], translateTo: 'en' },
  recording: { audioKbps: 24, recordAllCalls: false },
};
const withKbps = (audioKbps: unknown) => ({ ...valid, recording: { ...valid.recording, audioKbps } });

test('bitrate must be a whole number within 12-128 kbps', () => {
  assert.equal(validateSettings(withKbps(12)).recording.audioKbps, 12);
  assert.equal(validateSettings(withKbps(128)).recording.audioKbps, 128);
  for (const bad of [11, 129, 24.5, '24']) assert.throws(() => validateSettings(withKbps(bad)), /Audio bitrate/);
});

test('language codes are normalized and checked; an empty translate-to turns translation off', () => {
  const s = validateSettings({ ...valid, transcription: { ...valid.transcription, languageHints: [' EN', 'ur', 'en', ''], translateTo: ' ' } });
  assert.deepEqual(s.transcription.languageHints, ['en', 'ur']);
  assert.equal(s.transcription.translateTo, '');
  assert.throws(() => validateSettings({ ...valid, transcription: { ...valid.transcription, languageHints: ['english'] } }), /isn't a language code/);
  assert.throws(() => validateSettings({ ...valid, transcription: { ...valid.transcription, translateTo: 'en-US!' } }), /isn't a language code/);
});

test('missing switches are rejected rather than defaulted', () => {
  assert.throws(() => validateSettings({ ...valid, transcription: { ...valid.transcription, enabled: undefined } }), /enabled/);
  assert.throws(() => validateSettings({ transcription: valid.transcription }), /recordAllCalls/);
});

test('saved settings win over .env until reset', () => {
  assert.equal(getSettings().recording.audioKbps, 24);
  assert.deepEqual(getSettings().transcription.languageHints, ['en', 'ur']);
  saveSettings(withKbps(32));
  assert.equal(getSettings().recording.audioKbps, 32);
  assert.ok(fs.existsSync(process.env.SPACES_SETTINGS_FILE!));
  resetSettings();
  assert.equal(getSettings().recording.audioKbps, 24);
  assert.ok(!fs.existsSync(process.env.SPACES_SETTINGS_FILE!));
});

test('an invalid save leaves the settings in force unchanged', () => {
  saveSettings(withKbps(40));
  assert.throws(() => saveSettings(withKbps(500)));
  assert.equal(getSettings().recording.audioKbps, 40);
  resetSettings();
});
