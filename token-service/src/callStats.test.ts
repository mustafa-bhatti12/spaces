import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallLogRow } from './callStats';
import { callLogNamesFor, CallStatsAggregator, parseUserAgent, readCallStats, resolveCallLogFile, verdictFor } from './callStats';

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0';
const GSA_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/385.0.0 Mobile/15E148 Safari/604.1';
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

const T0 = Date.parse('2026-10-20T10:00:00Z');
const row = (sec: number, e: string, d?: unknown, identity = 'dev-a', room = 'r1'): CallLogRow => ({
  at: new Date(T0 + sec * 1000).toISOString(),
  room,
  identity,
  t: T0 + sec * 1000,
  e,
  d,
});
const stats = (sec: number, d: Record<string, unknown>, identity = 'dev-a') => row(sec, 'stats', d, identity);
const report = (rows: CallLogRow[]) => {
  const agg = new CallStatsAggregator();
  rows.forEach((r) => agg.add(r));
  return agg.report(1, '2026-10-20', '2026-10-20');
};
const clean = { drops: 0, reconnects: 0, poorQuality: 0, lostQuality: 0, concealedAvg: null, lossAvg: null, remoteLossAvg: null, rttP95: null };

test('verdict thresholds', () => {
  assert.equal(verdictFor(clean), 'good');
  assert.equal(verdictFor({ ...clean, rttP95: 400, lossAvg: 2, concealedAvg: 2, remoteLossAvg: 2 }), 'good');
  assert.equal(verdictFor({ ...clean, rttP95: 401 }), 'fair');
  assert.equal(verdictFor({ ...clean, lossAvg: 2.1 }), 'fair');
  assert.equal(verdictFor({ ...clean, reconnects: 1 }), 'fair');
  assert.equal(verdictFor({ ...clean, poorQuality: 1 }), 'fair');
  assert.equal(verdictFor({ ...clean, rttP95: 801 }), 'poor');
  assert.equal(verdictFor({ ...clean, concealedAvg: 5.1 }), 'poor');
  assert.equal(verdictFor({ ...clean, remoteLossAvg: 6 }), 'poor');
  assert.equal(verdictFor({ ...clean, drops: 1 }), 'poor');
});

test('summarises stats samples into one session row', () => {
  const r = report([
    row(0, 'session', { ua: CHROME_WIN, embedded: true }),
    row(1, 'joined', { sid: 'PA_1' }),
    stats(15, { rttMs: 100, path: 'udp', audioLossPct: 1, concealedPct: 0.5, remoteLossPct: 0, upAudioKbps: 40 }),
    stats(30, { rttMs: 300, path: 'udp', audioLossPct: 3, concealedPct: 1.5, remoteLossPct: 1, upAudioKbps: 50 }),
    stats(45, { rttMs: 200, path: 'tcp', audioLossPct: null, concealedPct: null, remoteLossPct: null, upAudioKbps: null }),
    row(50, 'state', 'reconnecting'),
    row(52, 'state', 'connected'),
    row(60, 'quality', 'poor'),
    row(70, 'disconnected', 'CLIENT_INITIATED'),
  ]);
  assert.equal(r.sessions.length, 1);
  const s = r.sessions[0];
  assert.equal(s.browser, 'Chrome 141');
  assert.equal(s.os, 'Windows');
  assert.equal(s.embedded, true);
  assert.deepEqual(s.sids, ['PA_1']);
  assert.equal(s.durationSec, 70);
  assert.equal(s.samples, 3);
  assert.equal(s.rttMedian, 200);
  assert.equal(s.rttP95, 300);
  assert.equal(s.rttMax, 300);
  assert.equal(s.lossAvg, 2);
  assert.equal(s.lossMax, 3);
  assert.equal(s.concealedAvg, 1);
  assert.equal(s.remoteLossAvg, 0.5);
  assert.equal(s.upAudioKbps, 45);
  assert.equal(s.path, 'udp');
  assert.equal(s.reconnects, 1);
  assert.equal(s.poorQuality, 1);
  assert.equal(s.endReason, 'CLIENT_INITIATED');
  assert.equal(s.verdict, 'fair');
  assert.equal(r.summary.sessions, 1);
  assert.equal(r.summary.withStats, 1);
  assert.equal(r.byBrowser[0].key, 'Chrome · Windows');
});
test('counts recovery and media events and aggregates by browser and UTC start day', () => {
  const r = report([
    row(0, 'session', { ua: CHROME_WIN }),
    row(1, 'joined', { sid: 'PA_1' }),
    row(2, 'state', 'signalReconnecting'),
    row(3, 'rejoin', { attempt: 1 }),
    row(4, 'relay', { reason: 'ice' }),
    row(5, 'adapt', { level: 'low', reason: 'network' }),
    row(6, 'adapt', { level: 'normal', reason: 'recovered' }),
    row(7, 'quality', 'poor'),
    row(8, 'quality', 'lost'),
    row(9, 'media-error', 'NotAllowedError'),
    stats(10, { rttMs: 900, audioLossPct: 6, concealedPct: 1, remoteLossPct: 0, upAudioKbps: 40 }),
    row(86_400, 'session', { ua: FIREFOX_MAC }),
    row(86_401, 'joined', { sid: 'PB_1' }),
    stats(86_415, { rttMs: 100, audioLossPct: 0, concealedPct: 0, remoteLossPct: 0, upAudioKbps: 30 }, 'dev-a'),
  ]);

  assert.equal(r.sessionsTotal, 2);
  assert.deepEqual([r.sessions[1].reconnects, r.sessions[1].drops, r.sessions[1].relaySwitches], [1, 1, 1]);
  assert.deepEqual([r.sessions[1].poorQuality, r.sessions[1].lostQuality, r.sessions[1].mediaErrors], [1, 1, 1]);
  assert.equal(r.sessions[1].adaptLow, 1);
  assert.equal(r.sessions[0].adaptLow, 0);
  assert.deepEqual(r.byBrowser.map((group) => group.key).sort(), ['Chrome · Windows', 'Firefox · macOS']);
  assert.deepEqual(r.byDay.map((group) => group.key).sort(), ['2026-10-20', '2026-10-21']);
  assert.equal(r.summary.poor, 1);
  assert.equal(r.summary.drops, 1);
});

test('returns every session rather than truncating the call history', () => {
  const agg = new CallStatsAggregator();
  for (let i = 0; i < 501; i++) agg.add(row(i, 'joined', { sid: `PA_${i}` }, `dev-${i}`));
  assert.equal(agg.report(30, '2026-09-21', '2026-10-20').sessions.length, 501);
});

test('old rows without stats still make a row with null stats', () => {
  const s = report([row(0, 'session', { ua: FIREFOX_MAC }), row(1, 'joined', { sid: 'PA_1' }), row(9, 'media-error', 'Requested device not found')])
    .sessions[0];
  assert.equal(s.samples, 0);
  assert.equal(s.rttP95, null);
  assert.equal(s.lossAvg, null);
  assert.equal(s.path, null);
  assert.equal(s.mediaErrors, 1);
  assert.equal(s.verdict, 'good');
  assert.equal(s.browser, 'Firefox 144');
});

test('sessions split by joined and session, but a rejoin continues the session', () => {
  const r = report([
    row(0, 'session', { ua: CHROME_WIN }),
    row(1, 'joined', { sid: 'PA_1' }),
    row(20, 'rejoin', { attempt: 1 }),
    row(22, 'rejoin', { attempt: 2 }),
    row(25, 'relay', { reason: 'ice' }),
    row(26, 'joined', { sid: 'PA_2' }),
    row(26, 'rejoined', { attempt: 2 }),
    // Joined again with no drop in between: a new call from the same page.
    row(100, 'joined', { sid: 'PA_3' }),
    // A reload: new session line.
    row(200, 'session', { ua: SAFARI_IOS }),
    row(201, 'joined', { sid: 'PA_4' }),
    // Someone else in the same room is separate.
    row(5, 'joined', { sid: 'PB_1' }, 'dev-b'),
  ]);
  assert.equal(r.sessionsTotal, 4);
  const [reload, again, , first] = r.sessions;
  assert.deepEqual(first.sids, ['PA_1', 'PA_2']);
  assert.equal(first.drops, 1);
  assert.equal(first.relaySwitches, 1);
  assert.equal(first.verdict, 'poor');
  assert.deepEqual(again.sids, ['PA_3']);
  assert.equal(again.browser, 'Chrome 141', 'keeps the browser from the earlier session line');
  assert.deepEqual(reload.sids, ['PA_4']);
  assert.equal(reload.browser, 'Safari 18');
  assert.equal(reload.os, 'iOS');
  assert.equal(r.summary.poor, 1);
  assert.equal(r.summary.drops, 1);
});

test('parses in-app browsers', () => {
  assert.deepEqual(parseUserAgent(GSA_IOS), { browser: 'Google app', os: 'iOS', inApp: 'Google app' });
});

test('validates log file names and keeps them in the log directory', () => {
  const dir = '/var/logs/spaces';
  assert.equal(resolveCallLogFile('calls-2026-10-20.jsonl', dir), path.resolve(dir, 'calls-2026-10-20.jsonl'));
  for (const name of ['', '..', '../calls-2026-10-20.jsonl', 'calls-2026-10-20.jsonl/..', 'calls-2026-10-2.jsonl', 'calls-2026-10-20.json', 'x/calls-2026-10-20.jsonl', 'calls-2026-10-20.jsonl\n', '/etc/passwd', 'settings.json']) {
    assert.equal(resolveCallLogFile(name, dir), null, JSON.stringify(name));
  }
});

test('reads the window of day files line by line, skipping torn lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callstats-'));
  try {
    const now = new Date('2026-10-20T12:00:00Z');
    assert.deepEqual(callLogNamesFor(2, now), ['calls-2026-10-19.jsonl', 'calls-2026-10-20.jsonl']);
    const lines = (rows: CallLogRow[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'calls-2026-10-18.jsonl'), lines([row(-200000, 'joined', { sid: 'OLD' }, 'dev-x')]));
    fs.writeFileSync(path.join(dir, 'calls-2026-10-20.jsonl'), `${lines([row(0, 'joined', { sid: 'PA_1' }), stats(15, { rttMs: 900 })])}{"torn`);
    const r = await readCallStats(2, dir, now);
    assert.equal(r.sessionsTotal, 1);
    assert.equal(r.sessions[0].rttP95, 900);
    assert.equal(r.sessions[0].verdict, 'poor');
    assert.equal(r.from, '2026-10-19');
    assert.equal(r.to, '2026-10-20');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
