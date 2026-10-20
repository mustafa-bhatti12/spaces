import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CALL_LOG_DIR, CALL_LOG_NAME } from './callLog';

/**
 * /admin → Call quality: turns the browsers' own call log (`logs/calls-<UTC day>.jsonl`, written by
 * callLog.ts) into one row per call session, with the `stats` samples (every 15 s while connected)
 * summarised and a good/fair/poor verdict, plus totals per browser and per day.
 */

/** One line of a call log file. */
export interface CallLogRow {
  at?: string;
  room?: string;
  identity?: string;
  t?: number;
  e?: string;
  d?: unknown;
}

export type Verdict = 'good' | 'fair' | 'poor';

export interface CallSession {
  room: string;
  identity: string;
  /** LiveKit participant sids (one per connect; a rejoin after a drop adds one). */
  sids: string[];
  browser: string;
  os: string;
  /** The app whose built-in browser this was (Google app, Facebook, …), else null. */
  inApp: string | null;
  embedded: boolean | null;
  joined: boolean;
  start: string;
  end: string;
  durationSec: number;
  samples: number;
  rttMedian: number | null;
  rttP95: number | null;
  rttMax: number | null;
  lossAvg: number | null;
  lossMax: number | null;
  concealedAvg: number | null;
  concealedMax: number | null;
  remoteLossAvg: number | null;
  upAudioKbps: number | null;
  path: string | null;
  reconnects: number;
  drops: number;
  adaptLow: number;
  relaySwitches: number;
  poorQuality: number;
  lostQuality: number;
  mediaErrors: number;
  endReason: string | null;
  verdict: Verdict;
}

export interface CallGroup {
  key: string;
  sessions: number;
  poor: number;
  fair: number;
  rttMedian: number | null;
  lossAvg: number | null;
  concealedAvg: number | null;
  drops: number;
}

export interface CallStatsReport {
  days: number;
  from: string;
  to: string;
  summary: CallGroup & { withStats: number };
  byBrowser: CallGroup[];
  byDay: CallGroup[];
  /** All sessions in the selected window, newest first. */
  sessions: CallSession[];
  sessionsTotal: number;
}

export const MAX_DAYS = 30;

/**
 * Verdict thresholds (session averages; RTT is the 95th percentile of the 15 s samples):
 *   poor: a drop (the client had to rejoin), concealed audio > 5 %, audio loss > 5 %,
 *         loss of our own mic at the others > 5 %, or RTT p95 > 800 ms;
 *   fair: a reconnect (LiveKit resumed it), LiveKit reported poor/lost quality, concealed > 2 %,
 *         loss > 2 %, remote loss > 2 %, or RTT p95 > 400 ms;
 *   good: none of those. A session without stats samples is judged on its events alone.
 */
export const THRESHOLDS = {
  poor: { pct: 5, rttP95: 800 },
  fair: { pct: 2, rttP95: 400 },
};

export function verdictFor(s: Pick<CallSession, 'drops' | 'reconnects' | 'poorQuality' | 'lostQuality' | 'concealedAvg' | 'lossAvg' | 'remoteLossAvg' | 'rttP95'>): Verdict {
  const over = (v: number | null, limit: number) => v !== null && v > limit;
  const pcts = [s.concealedAvg, s.lossAvg, s.remoteLossAvg];
  if (s.drops > 0 || pcts.some((v) => over(v, THRESHOLDS.poor.pct)) || over(s.rttP95, THRESHOLDS.poor.rttP95)) return 'poor';
  if (
    s.reconnects > 0 ||
    s.poorQuality + s.lostQuality > 0 ||
    pcts.some((v) => over(v, THRESHOLDS.fair.pct)) ||
    over(s.rttP95, THRESHOLDS.fair.rttP95)
  ) {
    return 'fair';
  }
  return 'good';
}

/** Browser, OS and in-app host from a user agent, coarse on purpose (major version only). */
export function parseUserAgent(ua: string): { browser: string; os: string; inApp: string | null } {
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /CrOS/.test(ua)
        ? 'ChromeOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Macintosh|Mac OS X/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Other';
  const apps: [RegExp, string][] = [
    [/\bGSA\//, 'Google app'],
    [/FBAN|FBAV|FB_IAB/, 'Facebook'],
    [/Instagram/, 'Instagram'],
    [/LinkedInApp/, 'LinkedIn'],
    [/\bLine\//, 'LINE'],
    [/Snapchat/, 'Snapchat'],
    [/; wv\)/, 'Android WebView'],
  ];
  const inApp = apps.find(([re]) => re.test(ua))?.[1] ?? null;
  const browsers: [RegExp, string][] = [
    [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
    [/FxiOS\/(\d+)/, 'Firefox'],
    [/CriOS\/(\d+)/, 'Chrome'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/Chrome\/(\d+)/, 'Chrome'],
    [/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//, 'Safari'],
  ];
  if (inApp) return { browser: inApp, os, inApp };
  for (const [re, name] of browsers) {
    const m = re.exec(ua);
    if (m) return { browser: `${name} ${m[1]}`, os, inApp: null };
  }
  return { browser: /Safari\//.test(ua) && os === 'iOS' ? 'Safari' : 'Other', os, inApp: null };
}

/** `calls-YYYY-MM-DD.jsonl` inside the log directory, else null (bad name, traversal). */
export function resolveCallLogFile(name: string, dir = CALL_LOG_DIR): string | null {
  if (typeof name !== 'string' || !CALL_LOG_NAME.test(name)) return null;
  const root = path.resolve(dir);
  const file = path.resolve(root, name);
  return path.dirname(file) === root ? file : null;
}

export interface CallLogFile {
  name: string;
  bytes: number;
  modifiedAt: string;
}

/** The day files in the log directory, newest first. */
export async function listCallLogs(dir = CALL_LOG_DIR): Promise<CallLogFile[]> {
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const files: CallLogFile[] = [];
  for (const name of names.filter((n) => CALL_LOG_NAME.test(n)).sort().reverse()) {
    const stat = await fs.promises.stat(path.join(dir, name)).catch(() => null);
    if (stat?.isFile()) files.push({ name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
  }
  return files;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (v: number) => Math.round(v * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const max = (xs: number[]) => (xs.length ? xs.reduce((a, b) => (a > b ? a : b)) : null);
function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  if (q === 0.5) {
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}
const opt = (v: number | null, f: (n: number) => number) => (v === null ? null : f(v));

interface Acc {
  room: string;
  identity: string;
  sids: string[];
  ua: string | null;
  embedded: boolean | null;
  start: number;
  end: number;
  joined: boolean;
  /** A `rejoin` since the last `joined`: the next `joined` continues this session. */
  rejoining: boolean;
  rtt: number[];
  loss: number[];
  concealed: number[];
  remoteLoss: number[];
  upAudio: number[];
  paths: Map<string, number>;
  samples: number;
  reconnects: number;
  drops: number;
  relaySwitches: number;
  poorQuality: number;
  adaptLow: number;
  lostQuality: number;
  mediaErrors: number;
  endReason: string | null;
}

/**
 * Feed rows in file order (oldest file first); `report()` groups them. A session is one page's
 * call: it starts at a `session` line, or at a `joined` when the current one already joined and
 * didn't drop in between (a `rejoin` continues the same session). Rows from before any of those
 * still open one, so old logs and partial days count too.
 */
export class CallStatsAggregator {
  private open = new Map<string, Acc>();
  private done: Acc[] = [];

  add(row: CallLogRow): void {
    if (typeof row.room !== 'string' || typeof row.identity !== 'string' || typeof row.e !== 'string') return;
    const time = num(row.t) ?? (row.at ? Date.parse(row.at) : NaN);
    if (!Number.isFinite(time)) return;
    const key = `${row.room}\u0000${row.identity}`;
    let acc = this.open.get(key);
    const d = row.d as Record<string, unknown> | string | undefined;
    const field = (name: string) => (d && typeof d === 'object' ? d[name] : undefined);

    const startNew = row.e === 'session' || (row.e === 'joined' && acc?.joined && !acc.rejoining);
    if (!acc || startNew) {
      if (acc) this.done.push(acc);
      acc = {
        room: row.room,
        identity: row.identity,
        sids: [],
        // Same browser (identity is a per-browser id), so a new join without a `session` line keeps it.
        ua: acc?.ua ?? null,
        embedded: acc?.embedded ?? null,
        start: time,
        end: time,
        joined: false,
        rejoining: false,
        rtt: [],
        loss: [],
        concealed: [],
        remoteLoss: [],
        upAudio: [],
        paths: new Map(),
        samples: 0,
        reconnects: 0,
        drops: 0,
        relaySwitches: 0,
        adaptLow: 0,
        poorQuality: 0,
        lostQuality: 0,
        mediaErrors: 0,
        endReason: null,
      };
      this.open.set(key, acc);
    }
    acc.start = Math.min(acc.start, time);
    acc.end = Math.max(acc.end, time);

    switch (row.e) {
      case 'session': {
        const ua = field('ua');
        acc.ua = typeof ua === 'string' ? ua : null;
        const embedded = field('embedded');
        acc.embedded = typeof embedded === 'boolean' ? embedded : null;
        break;
      }
      case 'joined': {
        acc.joined = true;
        acc.rejoining = false;
        const sid = field('sid');
        if (typeof sid === 'string' && sid && !acc.sids.includes(sid)) acc.sids.push(sid);
        break;
      }
      case 'state':
        if (d === 'reconnecting' || d === 'signalReconnecting') acc.reconnects++;
        break;
      case 'rejoin': {
        // Logged per attempt; the first attempt is the drop.
        const attempt = num(field('attempt'));
        if (attempt === null || attempt === 1) acc.drops++;
        acc.rejoining = true;
        break;
      }
      case 'relay':
        acc.relaySwitches++;
        break;
      case 'adapt':
        if (field('level') === 'low') acc.adaptLow++;
        break;
      case 'quality':
        if (d === 'poor') acc.poorQuality++;
        else if (d === 'lost') acc.lostQuality++;
        break;
      case 'media-error':
        acc.mediaErrors++;
        break;
      case 'disconnected':
        acc.endReason = typeof d === 'string' ? d : null;
        break;
      case 'stats': {
        acc.samples++;
        const push = (list: number[], name: string) => {
          const v = num(field(name));
          if (v !== null) list.push(v);
        };
        push(acc.rtt, 'rttMs');
        push(acc.loss, 'audioLossPct');
        push(acc.concealed, 'concealedPct');
        push(acc.remoteLoss, 'remoteLossPct');
        push(acc.upAudio, 'upAudioKbps');
        const p = field('path');
        if (typeof p === 'string' && p) acc.paths.set(p, (acc.paths.get(p) ?? 0) + 1);
        break;
      }
    }
  }

  report(days: number, from: string, to: string): CallStatsReport {
    const sessions = [...this.done, ...this.open.values()].map(toSession).sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
    const groupBy = (keyOf: (s: CallSession) => string) => {
      const groups = new Map<string, CallSession[]>();
      for (const s of sessions) {
        const k = keyOf(s);
        const list = groups.get(k);
        if (list) list.push(s);
        else groups.set(k, [s]);
      }
      return [...groups].map(([k, list]) => summarize(k, list));
    };
    return {
      days,
      from,
      to,
      summary: { ...summarize('all', sessions), withStats: sessions.filter((s) => s.samples > 0).length },
      byBrowser: groupBy((s) => `${s.browser.replace(/ \d+$/, '')} · ${s.os}`).sort((a, b) => b.sessions - a.sessions),
      byDay: groupBy((s) => s.start.slice(0, 10)).sort((a, b) => (a.key < b.key ? 1 : -1)),
      sessions,
      sessionsTotal: sessions.length,
    };
  }
}

function toSession(a: Acc): CallSession {
  const rtt = [...a.rtt].sort((x, y) => x - y);
  const ua = a.ua ? parseUserAgent(a.ua) : { browser: 'Unknown', os: 'Unknown', inApp: null };
  let path: string | null = null;
  let best = 0;
  for (const [p, n] of a.paths) {
    if (n > best) [path, best] = [p, n];
  }
  const s = {
    room: a.room,
    identity: a.identity,
    sids: a.sids,
    ...ua,
    embedded: a.embedded,
    joined: a.joined,
    start: new Date(a.start).toISOString(),
    end: new Date(a.end).toISOString(),
    durationSec: Math.round((a.end - a.start) / 1000),
    samples: a.samples,
    rttMedian: opt(quantile(rtt, 0.5), Math.round),
    rttP95: opt(quantile(rtt, 0.95), Math.round),
    rttMax: opt(max(rtt), Math.round),
    lossAvg: opt(mean(a.loss), round1),
    lossMax: opt(max(a.loss), round1),
    concealedAvg: opt(mean(a.concealed), round1),
    concealedMax: opt(max(a.concealed), round1),
    remoteLossAvg: opt(mean(a.remoteLoss), round1),
    upAudioKbps: opt(mean(a.upAudio), Math.round),
    path,
    reconnects: a.reconnects,
    drops: a.drops,
    relaySwitches: a.relaySwitches,
    adaptLow: a.adaptLow,
    poorQuality: a.poorQuality,
    lostQuality: a.lostQuality,
    mediaErrors: a.mediaErrors,
    endReason: a.endReason,
  };
  return { ...s, verdict: verdictFor(s) };
}

/** Totals for a set of sessions: medians/averages are over the sessions that have the value. */
function summarize(key: string, list: CallSession[]): CallGroup {
  const values = (pick: (s: CallSession) => number | null) => list.map(pick).filter((v): v is number => v !== null);
  return {
    key,
    sessions: list.length,
    poor: list.filter((s) => s.verdict === 'poor').length,
    fair: list.filter((s) => s.verdict === 'fair').length,
    rttMedian: opt(quantile(values((s) => s.rttMedian).sort((x, y) => x - y), 0.5), Math.round),
    lossAvg: opt(mean(values((s) => s.lossAvg)), round1),
    concealedAvg: opt(mean(values((s) => s.concealedAvg)), round1),
    drops: list.reduce((n, s) => n + s.drops, 0),
  };
}

/** The day files covering the last `days` UTC days up to `now`, oldest first. */
export function callLogNamesFor(days: number, now = new Date()): string[] {
  const names: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    names.push(`calls-${new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10)}.jsonl`);
  }
  return names;
}

/** Streams the window's files line by line (they can be several MB) into one report. */
export async function readCallStats(days: number, dir = CALL_LOG_DIR, now = new Date()): Promise<CallStatsReport> {
  const names = callLogNamesFor(days, now);
  const agg = new CallStatsAggregator();
  for (const name of names) {
    const file = path.join(dir, name);
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        try {
          agg.add(JSON.parse(line) as CallLogRow);
        } catch {
          // A line cut short by a crash or a full disk; skip it.
        }
      }
    } catch (err) {
      // A file can disappear after the directory snapshot when an operator deletes logs.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    } finally {
      lines.close();
    }
  }
  return agg.report(days, names[0].slice(6, 16), names[names.length - 1].slice(6, 16));
}
