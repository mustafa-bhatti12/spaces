import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import tls from 'node:tls';
import { promisify } from 'node:util';

/**
 * Host and service metrics for the operator console. token-service runs natively on the droplet
 * next to LiveKit, Redis, Caddy and the compressor, so it reads them straight from the OS: `os`,
 * `/proc` (Linux) and `ps`, plus `docker` for the recording worker. Anything a platform can't
 * provide (no `/proc` on macOS) comes back null rather than failing the whole snapshot.
 *
 * CPU figures are averages since the previous call (the console polls every 15 s), so the first
 * call after a restart reports null for them.
 */

export interface ServiceProcess {
  name: string;
  running: boolean;
  pid: number | null;
  uptimeSec: number | null;
  rssBytes: number | null;
  cpuPct: number | null;
  version: string | null;
  detail?: string;
}

export interface SystemSnapshot {
  collectedAt: string;
  host: { hostname: string; os: string; kernel: string; arch: string; cores: number; cpuModel: string; uptimeSec: number };
  cpu: { usagePct: number | null; load: [number, number, number] };
  memory: { totalBytes: number; availableBytes: number; swapTotalBytes: number | null; swapFreeBytes: number | null };
  network: { iface: string; rxBytesPerSec: number | null; txBytesPerSec: number | null; rxTotalBytes: number; txTotalBytes: number } | null;
  tls: { host: string; validTo: string; daysLeft: number; issuer: string } | { host: string; error: string } | null;
  deploy: { commit: string; committedAt: string; subject: string } | null;
  processes: ServiceProcess[];
}

const execFileAsync = promisify(execFile);

/** stdout of a command, or null if it's missing, fails or times out. */
function run(cmd: string, args: string[], timeout = 3000): Promise<string | null> {
  return execFileAsync(cmd, args, { timeout }).then(
    ({ stdout }) => stdout.toString(),
    () => null,
  );
}

const readText = (file: string) => fs.promises.readFile(file, 'utf8').catch(() => null);

/** `ps -o etime` is `[[dd-]hh:]mm:ss` on both Linux and macOS. */
export function parseEtime(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const [, d = '0', h = '0', min, s] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(s);
}

/** Rx/tx byte counters for one interface out of `/proc/net/dev`. */
export function parseNetDev(text: string, iface: string): { rx: number; tx: number } | null {
  for (const line of text.split('\n')) {
    const [name, rest] = line.split(':');
    if (rest === undefined || name.trim() !== iface) continue;
    const fields = rest.trim().split(/\s+/).map(Number);
    // receive: bytes packets errs drop fifo frame compressed multicast | transmit: bytes ...
    if (fields.length < 9) return null;
    return { rx: fields[0], tx: fields[8] };
  }
  return null;
}

/** `/proc/meminfo` values are in kB. */
export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) out[m[1]] = Number(m[2]) * 1024;
  }
  return out;
}

// --- deltas between calls -------------------------------------------------------------

let lastCpu: { idle: number; total: number } | null = null;
let lastNet: { at: number; rx: number; tx: number } | null = null;
const lastProcTicks = new Map<number, { at: number; ticks: number }>();
let lastSelfCpu: { at: number; usage: NodeJS.CpuUsage } | null = null;

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

function hostCpuPct(): number | null {
  const now = cpuTimes();
  const prev = lastCpu;
  lastCpu = now;
  if (!prev || now.total <= prev.total) return null;
  return round1(100 * (1 - (now.idle - prev.idle) / (now.total - prev.total)));
}

/** Linux: utime+stime of a pid from /proc/<pid>/stat, as a percentage of one core since last call. */
async function procCpuPct(pid: number): Promise<number | null> {
  const stat = await readText(`/proc/${pid}/stat`);
  if (!stat) return null;
  // comm (field 2) may contain spaces; fields after the closing paren are fixed.
  const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(after[11]) + Number(after[12]); // utime, stime (fields 14, 15)
  const now = Date.now();
  const prev = lastProcTicks.get(pid);
  lastProcTicks.set(pid, { at: now, ticks });
  if (!prev || now <= prev.at) return null;
  const CLK_TCK = 100; // Linux USER_HZ on every mainstream kernel
  return round1((100 * (ticks - prev.ticks)) / CLK_TCK / ((now - prev.at) / 1000));
}

function selfCpuPct(): number | null {
  const now = { at: Date.now(), usage: process.cpuUsage() };
  const prev = lastSelfCpu;
  lastSelfCpu = now;
  if (!prev || now.at <= prev.at) return null;
  const micros = now.usage.user - prev.usage.user + (now.usage.system - prev.usage.system);
  return round1((100 * micros) / 1000 / (now.at - prev.at));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// --- slow facts, cached ---------------------------------------------------------------

const cache = new Map<string, { until: number; value: unknown }>();
/** Memoizes `load` for `ttlMs`; `keep` false means don't cache this result (e.g. a transient failure). */
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>, keep: (value: T) => boolean = () => true): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value as T;
  const value = await load();
  if (keep(value)) cache.set(key, { until: Date.now() + ttlMs, value });
  return value;
}

const firstLine = (s: string | null) => s?.trim().split('\n')[0] ?? null;

async function versions() {
  return cached('versions', 10 * 60_000, async () => {
    const [livekit, redis, caddy] = await Promise.all([
      run('livekit-server', ['--version']),
      run('redis-server', ['--version']),
      run('caddy', ['version']),
    ]);
    return {
      livekit: firstLine(livekit)?.replace(/^livekit-server version /, '') ?? null,
      redis: /v=(\S+)/.exec(redis ?? '')?.[1] ?? null,
      caddy: firstLine(caddy)?.split(' ')[0] ?? null,
    };
  });
}

async function deployInfo(): Promise<SystemSnapshot['deploy']> {
  return cached('deploy', 60_000, async () => {
    const out = await run('git', ['log', '-1', '--format=%h%x1f%cI%x1f%s']);
    if (!out) return null;
    const [commit, committedAt, subject] = out.trim().split('\x1f');
    return { commit, committedAt, subject };
  });
}

async function osName(): Promise<string> {
  return cached('os', Infinity, async () => {
    const release = await readText('/etc/os-release');
    const pretty = release && /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release)?.[1];
    return pretty || `${os.type()} ${os.release()}`;
  });
}

function certificate(): Promise<SystemSnapshot['tls']> {
  const publicUrl = process.env.LIVEKIT_PUBLIC_URL;
  if (!publicUrl) return Promise.resolve(null);
  let host: string;
  try {
    host = new URL(publicUrl).hostname;
  } catch {
    return Promise.resolve(null);
  }
  return cached('tls', 60 * 60_000, async () => {
    const socket = tls.connect({ host, port: 443, servername: host });
    socket.setTimeout(4000, () => socket.destroy(new Error('timed out')));
    try {
      await once(socket, 'secureConnect'); // rejects on the socket's 'error'
      const cert = socket.getPeerCertificate();
      const validTo = new Date(cert.valid_to);
      return {
        host,
        validTo: validTo.toISOString(),
        daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86_400_000),
        issuer: String(cert.issuer?.O ?? cert.issuer?.CN ?? 'unknown'),
      };
    } catch (err) {
      return { host, error: (err as Error).message };
    } finally {
      socket.destroy();
    }
  }, (value) => value !== null && !('error' in value));
}

// --- processes --------------------------------------------------------------------------

interface PsRow {
  pid: number;
  uptimeSec: number | null;
  rssBytes: number;
  args: string;
}

async function psRows(): Promise<PsRow[]> {
  const out = await run('ps', ['-eo', 'pid=,etime=,rss=,args=']);
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), uptimeSec: parseEtime(m[2]), rssBytes: Number(m[3]) * 1024, args: m[4] }));
}

async function cwdOf(pid: number): Promise<string | null> {
  return fs.promises.readlink(`/proc/${pid}/cwd`).catch(() => null);
}

async function fromPs(name: string, row: PsRow | undefined, version: string | null): Promise<ServiceProcess> {
  if (!row) return { name, running: false, pid: null, uptimeSec: null, rssBytes: null, cpuPct: null, version };
  return { name, running: true, pid: row.pid, uptimeSec: row.uptimeSec, rssBytes: row.rssBytes, cpuPct: await procCpuPct(row.pid), version };
}

/** docker stats' MemUsage looks like "25.3MiB / 3.83GiB". */
export function parseDockerBytes(text: string): number | null {
  const m = /^([\d.]+)\s*([KMGT]?i?B)$/.exec(text.trim());
  if (!m) return null;
  const unit: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  return unit[m[2]] ? Math.round(Number(m[1]) * unit[m[2]]) : null;
}

async function egressWorker(): Promise<ServiceProcess> {
  const name = 'Recording worker';
  const inspect = await run('docker', ['inspect', '-f', '{{.State.Status}}|{{.State.Pid}}|{{.State.StartedAt}}|{{.Config.Image}}', 'space-egress']);
  if (!inspect) return { name, running: false, pid: null, uptimeSec: null, rssBytes: null, cpuPct: null, version: null, detail: 'container not found or Docker unavailable' };
  const [status, pid, startedAt, image] = inspect.trim().split('|');
  const running = status === 'running';
  const stats = running ? await run('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', 'space-egress'], 6000) : null;
  const [cpu, mem] = stats?.trim().split('|') ?? [];
  return {
    name,
    running,
    pid: running ? Number(pid) : null,
    uptimeSec: running ? Math.round((Date.now() - Date.parse(startedAt)) / 1000) : null,
    rssBytes: mem ? parseDockerBytes(mem.split('/')[0]) : null,
    cpuPct: cpu ? round1(Number.parseFloat(cpu)) : null,
    version: image ?? null,
    detail: running ? undefined : status,
  };
}

async function processes(): Promise<ServiceProcess[]> {
  const [rows, v] = await Promise.all([psRows(), versions()]);
  const compressorRow = await (async () => {
    // `npm start` runs it as `sh -c node server.js` -> `node server.js`; the node child is the service.
    for (const r of rows.filter((r) => /^(\S*\/)?node\s+server\.js\b/.test(r.args))) {
      if ((await cwdOf(r.pid))?.endsWith('/compressor')) return r;
    }
    return rows.find((r) => r.args.includes('compressor/server.js'));
  })();

  const self: ServiceProcess = {
    name: 'Token service',
    running: true,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    rssBytes: process.memoryUsage().rss,
    cpuPct: selfCpuPct(),
    version: `Node ${process.version}`,
  };

  return Promise.all([
    fromPs('LiveKit server', rows.find((r) => /(^|\/)livekit-server\s/.test(r.args)), v.livekit),
    Promise.resolve(self),
    fromPs('Compressor', compressorRow, null),
    fromPs('Redis', rows.find((r) => /(^|\/)redis-server\s/.test(r.args)), v.redis),
    fromPs('Caddy', rows.find((r) => /(^|\/)caddy run\b/.test(r.args)), v.caddy),
    egressWorker(),
  ]);
}

// --- host -------------------------------------------------------------------------------

async function network(): Promise<SystemSnapshot['network']> {
  const route = await readText('/proc/net/route');
  // Default route: destination 00000000. Its interface carries the droplet's public traffic.
  const iface = route?.split('\n').slice(1).map((l) => l.split('\t')).find((f) => f[1] === '00000000')?.[0];
  const dev = iface ? await readText('/proc/net/dev') : null;
  const counters = dev && iface ? parseNetDev(dev, iface) : null;
  if (!iface || !counters) return null;
  const now = Date.now();
  const prev = lastNet;
  lastNet = { at: now, ...counters };
  const secs = prev ? (now - prev.at) / 1000 : 0;
  return {
    iface,
    rxBytesPerSec: prev && secs > 0 ? Math.max(0, Math.round((counters.rx - prev.rx) / secs)) : null,
    txBytesPerSec: prev && secs > 0 ? Math.max(0, Math.round((counters.tx - prev.tx) / secs)) : null,
    rxTotalBytes: counters.rx,
    txTotalBytes: counters.tx,
  };
}

async function memory(): Promise<SystemSnapshot['memory']> {
  const info = await readText('/proc/meminfo');
  if (info) {
    const m = parseMeminfo(info);
    return {
      totalBytes: m.MemTotal ?? os.totalmem(),
      availableBytes: m.MemAvailable ?? os.freemem(),
      swapTotalBytes: m.SwapTotal ?? null,
      swapFreeBytes: m.SwapFree ?? null,
    };
  }
  return { totalBytes: os.totalmem(), availableBytes: os.freemem(), swapTotalBytes: null, swapFreeBytes: null };
}

export async function collectSystemSnapshot(): Promise<SystemSnapshot> {
  const [osPretty, mem, net, tlsInfo, deploy, procs] = await Promise.all([
    osName(),
    memory(),
    network(),
    certificate(),
    deployInfo(),
    processes(),
  ]);
  const cpus = os.cpus();
  const [l1, l5, l15] = os.loadavg();
  return {
    collectedAt: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      os: osPretty,
      kernel: os.release(),
      arch: os.arch(),
      cores: cpus.length,
      cpuModel: cpus[0]?.model.trim() ?? 'unknown',
      uptimeSec: Math.round(os.uptime()),
    },
    cpu: { usagePct: hostCpuPct(), load: [round1(l1), round1(l5), round1(l15)] },
    memory: mem,
    network: net,
    tls: tlsInfo,
    deploy,
    processes: procs,
  };
}
