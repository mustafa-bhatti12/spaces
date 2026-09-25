'use client';

import type { ReactNode } from 'react';
import type { Signal } from '../ui/Device';
import { Led } from '../ui/Device';
import { formatBytes, formatDuration, formatRate, since } from './format';

// Mirrors token-service/src/system.ts's SystemSnapshot (GET /admin/system).
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

export interface Usage {
  rooms: number;
  people: number;
  tracks: number;
  recording: number;
  files: number;
  filesBytes: number;
  rawFiles: number;
}

const level = (pct: number, warn: number, alert: number): Signal => (pct >= alert ? 'alert' : pct >= warn ? 'warn' : 'live');

function Meter({ pct, signal, label }: { pct: number; signal: Signal; label: string }) {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <div className={`meter meter-${signal}`} role="meter" aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div style={{ width: `${clamped}%` }} />
    </div>
  );
}

function Tile({ name, signal, value, detail, children }: { name: string; signal: Signal; value: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="health-seg">
      <span className="health-name">{name}</span>
      <span className="health-state">
        <Led signal={signal} />
        {value}
      </span>
      {detail && <span className="note health-detail">{detail}</span>}
      {children}
    </div>
  );
}

export function ServerPanel({ system, usage }: { system: SystemSnapshot | null; usage: Usage | null }) {
  if (!system) {
    return (
      <div className="health-strip">
        <Tile name="Server" signal="idle" value="Metrics unavailable" detail="Retrying every 15 seconds." />
      </div>
    );
  }
  const { cpu, memory, network, tls, deploy, host } = system;
  const memUsedPct = ((memory.totalBytes - memory.availableBytes) / memory.totalBytes) * 100;
  const swapUsed = memory.swapTotalBytes ? memory.swapTotalBytes - (memory.swapFreeBytes ?? 0) : null;
  const loadHigh = cpu.load[0] > host.cores;

  return (
    <div className="server-panel">
      <div className="health-strip">
        <Tile
          name="CPU"
          signal={cpu.usagePct === null ? 'idle' : level(cpu.usagePct, 60, 85)}
          value={cpu.usagePct === null ? 'Measuring…' : <span className="mono">{cpu.usagePct}%</span>}
          detail={
            <span className={loadHigh ? 'readout-warn' : undefined} title="Load average over 1, 5 and 15 minutes">
              Load {cpu.load.join(' / ')} on {host.cores} {host.cores === 1 ? 'core' : 'cores'}
            </span>
          }
        >
          {cpu.usagePct !== null && <Meter pct={cpu.usagePct} signal={level(cpu.usagePct, 60, 85)} label="CPU used" />}
        </Tile>
        <Tile
          name="Memory"
          signal={level(memUsedPct, 75, 90)}
          value={
            <span className="mono">
              {formatBytes(memory.totalBytes - memory.availableBytes)} / {formatBytes(memory.totalBytes)}
            </span>
          }
          detail={swapUsed === null ? `${Math.round(memUsedPct)}% used` : `${Math.round(memUsedPct)}% used, swap ${formatBytes(swapUsed)} of ${formatBytes(memory.swapTotalBytes ?? 0)}`}
        >
          <Meter pct={memUsedPct} signal={level(memUsedPct, 75, 90)} label="Memory used" />
        </Tile>
        <Tile
          name={network ? `Network (${network.iface})` : 'Network'}
          signal={network ? 'live' : 'idle'}
          value={
            network && network.rxBytesPerSec !== null && network.txBytesPerSec !== null ? (
              <span className="mono net-rates">
                <span title="Received">In {formatRate(network.rxBytesPerSec)}</span>
                <span title="Sent">Out {formatRate(network.txBytesPerSec)}</span>
              </span>
            ) : network ? (
              'Measuring…'
            ) : (
              'Unavailable'
            )
          }
          detail={network ? `Since boot: ${formatBytes(network.rxTotalBytes)} in, ${formatBytes(network.txTotalBytes)} out` : 'Only reported on Linux'}
        />
        {tls && 'daysLeft' in tls ? (
          <Tile
            name="TLS certificate"
            signal={tls.daysLeft < 7 ? 'alert' : tls.daysLeft < 21 ? 'warn' : 'live'}
            value={`${tls.daysLeft} days left`}
            detail={`${tls.host}, ${tls.issuer}, expires ${new Date(tls.validTo).toLocaleDateString()}`}
          />
        ) : (
          <Tile name="TLS certificate" signal={tls ? 'alert' : 'idle'} value={tls ? 'Check failed' : 'Not configured'} detail={tls ? `${tls.host}: ${tls.error}` : 'No public URL set'} />
        )}
      </div>

      <div className="health-strip">
        <Tile
          name="Calls now"
          signal={usage && usage.rooms > 0 ? 'live' : 'idle'}
          value={usage ? `${usage.people} ${usage.people === 1 ? 'person' : 'people'} in ${usage.rooms} ${usage.rooms === 1 ? 'room' : 'rooms'}` : '…'}
          detail={usage ? `${usage.tracks} published ${usage.tracks === 1 ? 'track' : 'tracks'}, ${usage.recording} recording` : undefined}
        />
        <Tile
          name="Recording storage"
          signal={usage && usage.rawFiles > 0 ? 'warn' : 'live'}
          value={usage ? <span className="mono">{formatBytes(usage.filesBytes)}</span> : '…'}
          detail={usage ? `${usage.files} ${usage.files === 1 ? 'file' : 'files'}${usage.rawFiles ? `, ${usage.rawFiles} raw (recording or not yet compressed)` : ''}` : undefined}
        />
        <Tile
          name="Deployed"
          signal={deploy ? 'live' : 'idle'}
          value={deploy ? <span className="mono">{deploy.commit}</span> : 'Unknown'}
          detail={deploy ? <span title={deploy.subject}>{`${since(deploy.committedAt)}: ${deploy.subject}`}</span> : 'git not available'}
        />
        <Tile
          name="Host"
          signal="live"
          value={<span className="mono">{host.hostname}</span>}
          detail={<span title={`${host.cpuModel}, kernel ${host.kernel}`}>{`${host.os}, ${host.arch}, up ${formatDuration(host.uptimeSec)}`}</span>}
        />
      </div>

      <div className="table-wrap">
        <table className="rec-table proc-table">
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">
                Uptime
              </th>
              <th scope="col" className="num">
                CPU
              </th>
              <th scope="col" className="num">
                Memory
              </th>
              <th scope="col">Version</th>
              <th scope="col" className="num">
                PID
              </th>
            </tr>
          </thead>
          <tbody>
            {system.processes.map((p) => (
              <tr key={p.name}>
                <td className="proc-name">{p.name}</td>
                <td>
                  <span className="proc-state">
                    <Led signal={p.running ? 'live' : 'alert'} />
                    {p.running ? 'Running' : 'Stopped'}
                  </span>
                  {p.detail && <span className="note proc-detail">{p.detail}</span>}
                </td>
                <td className="num mono">{p.uptimeSec === null ? '-' : formatDuration(p.uptimeSec)}</td>
                <td className="num mono">{p.cpuPct === null ? '-' : `${p.cpuPct}%`}</td>
                <td className="num mono">{p.rssBytes === null ? '-' : formatBytes(p.rssBytes)}</td>
                <td className="mono proc-version">{p.version ?? '-'}</td>
                <td className="num mono">{p.pid ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
