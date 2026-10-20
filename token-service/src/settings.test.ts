import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CALL_SETTINGS, defaultSettings, getSettings, resetSettings, saveSettings, validateSettings } from './settings';

// settings.ts reads the file path and .env values when first used, so these apply.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-settings-'));
process.env.SPACES_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.RECORDING_AUDIO_KBPS = '24';
process.env.TRANSCRIPTION_LANGUAGE_HINTS = 'en, ur';

const valid = {
  transcription: { enabled: true, languageHints: ['en'], terms: ['USCIS'], translateTo: 'en' },
  recording: { audioKbps: 24, recordAllCalls: false },
  limits: { maxPerRoom: 40, maxTotal: 40 },
};
const withKbps = (audioKbps: unknown) => ({ ...valid, recording: { ...valid.recording, audioKbps } });
const withCalls = (calls: unknown) => ({ ...valid, calls });
const withLimits = (limits: unknown) => ({ ...valid, limits });

test('people limits are whole numbers, and the total is never below one call', () => {
  assert.deepEqual(validateSettings(withLimits({ maxPerRoom: 8, maxTotal: 30 })).limits, { maxPerRoom: 8, maxTotal: 30 });
  for (const bad of [1, 201, 12.5, '12', undefined]) {
    assert.throws(() => validateSettings(withLimits({ maxPerRoom: bad, maxTotal: 40 })), /People per call/);
    assert.throws(() => validateSettings(withLimits({ maxPerRoom: 40, maxTotal: bad })), /People across all calls/);
  }
  assert.throws(() => validateSettings(withLimits({ maxPerRoom: 40, maxTotal: 20 })), /fewer than people per call/);
});

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
test('call settings default missing values and validate every option', () => {
  assert.deepEqual(defaultSettings().calls, DEFAULT_CALL_SETTINGS);
  assert.deepEqual(validateSettings(valid).calls, DEFAULT_CALL_SETTINGS);
  assert.deepEqual(
    validateSettings(withCalls({ micPreset: 'music', adaptive: false, relayRttMs: 2400 })).calls,
    { ...DEFAULT_CALL_SETTINGS, micPreset: 'music', adaptive: false, relayRttMs: 2400 },
  );

  for (const [field, value] of [
    ['micPreset', 'studio'],
    ['red', 1],
    ['adaptive', 'true'],
    ['adaptAvailOutKbps', -1],
    ['adaptHoldSec', 1.5],
    ['lowCameraHeight', 240],
    ['lowScreenFps', 0],
    ['relayFallback', 'false'],
    ['relayRttMs', -1],
    ['relayDrops', 0],
    ['statsIntervalSec', -1],
  ] as [string, unknown][]) {
    assert.throws(() => validateSettings(withCalls({ ...DEFAULT_CALL_SETTINGS, [field]: value })), /calls\./, field);
  }
});


test('saved settings win over .env until reset', () => {
  assert.equal(getSettings().recording.audioKbps, 24);
  assert.deepEqual(getSettings().transcription.languageHints, ['en', 'ur']);
  saveSettings({ ...withKbps(32), calls: { ...DEFAULT_CALL_SETTINGS, adaptive: false } });
  assert.equal(getSettings().recording.audioKbps, 32);
  assert.equal(getSettings().calls.adaptive, false);
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
