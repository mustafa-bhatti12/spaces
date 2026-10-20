'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Led } from '../ui/Device';
import type { Signal } from '../ui/Device';
import { api } from './api';
import { formatBytes, formatDuration } from './format';

interface CallSession {
  room: string;
  identity: string;
  browser: string;
  os: string;
  inApp: string | null;
  embedded: boolean | null;
  start: string;
  durationSec: number;
  samples: number;
  rttP95: number | null;
  lossAvg: number | null;
  concealedAvg: number | null;
  path: string | null;
  drops: number;
  adaptLow: number;
  reconnects: number;
  relaySwitches: number;
  poorQuality: number;
  lostQuality: number;
  mediaErrors: number;
  verdict: 'good' | 'fair' | 'poor';
}
interface CallGroup {
  key: string;
  sessions: number;
  poor: number;
  fair: number;
  rttMedian: number | null;
  lossAvg: number | null;
  concealedAvg: number | null;
  drops: number;
}
interface CallStatsReport {
  from: string;
  to: string;
  summary: CallGroup & { withStats: number };
  byBrowser: CallGroup[];
  byDay: CallGroup[];
  sessions: CallSession[];
  sessionsTotal: number;
}
interface CallLogFile {
  name: string;
  bytes: number;
  modifiedAt: string;
}

function percent(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

function milliseconds(value: number | null): string {
  return value === null ? '—' : `${value} ms`;
}

function GroupTable({ title, groups }: { title: string; groups: CallGroup[] }) {
  return (
    <section className="call-quality-group" aria-label={title}>
      <h3 className="call-quality-group-title">{title}</h3>
      <div className="table-wrap">
        <table className="rec-table call-quality-group-table">
          <thead>
            <tr>
              <th scope="col">{title === 'By browser' ? 'Browser' : 'UTC day'}</th>
              <th scope="col" className="num">Sessions</th>
              <th scope="col" className="num">Poor</th>
              <th scope="col" className="num">Median RTT</th>
              <th scope="col" className="num">Loss</th>
              <th scope="col" className="num">Concealed</th>
              <th scope="col" className="num">Drops</th>
            </tr>
          </thead>
          <tbody>
            {groups.length ? groups.map((group) => (
              <tr key={group.key}>
                <td className={title === 'By day' ? 'mono' : undefined}>{group.key}</td>
                <td className="num mono">{group.sessions}</td>
                <td className="num mono" title={`${group.poor} poor sessions`}>
                  {group.sessions ? `${(group.poor / group.sessions * 100).toFixed(1)}%` : '—'}
                </td>
                <td className="num mono">{milliseconds(group.rttMedian)}</td>
                <td className="num mono">{percent(group.lossAvg)}</td>
                <td className="num mono">{percent(group.concealedAvg)}</td>
                <td className="num mono">{group.drops}</td>
              </tr>
            )) : (
              <tr><td colSpan={7} className="call-quality-empty">No sessions in this period.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function CallQuality({ onError, flash }: { onError: (error: unknown) => string; flash: (message: string, error?: boolean) => void }) {
  const [days, setDays] = useState<1 | 7 | 30>(7);
  const [report, setReport] = useState<CallStatsReport | null>(null);
  const [files, setFiles] = useState<CallLogFile[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [logsError, setLogsError] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const statsRequest = useRef(0);
  const logsRequest = useRef(0);

  const refreshStats = useCallback(async () => {
    const request = ++statsRequest.current;
    setLoading(true);
    setReport(null);
    setLoadError('');
    try {
      const data = await api<CallStatsReport>('GET', `/call-stats?days=${days}`);
      if (statsRequest.current === request) setReport(data);
    } catch (err) {
      if (statsRequest.current === request) setLoadError(onError(err));
    } finally {
      if (statsRequest.current === request) setLoading(false);
    }
  }, [days, onError]);

  const refreshLogs = useCallback(async () => {
    const request = ++logsRequest.current;
    setLogsLoading(true);
    setLogsError('');
    try {
      const data = await api<{ files: CallLogFile[] }>('GET', '/call-logs');
      if (logsRequest.current === request) setFiles(data.files);
    } catch (err) {
      if (logsRequest.current === request) setLogsError(onError(err));
    } finally {
      if (logsRequest.current === request) setLogsLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void refreshStats();
    return () => { statsRequest.current++; };
  }, [refreshStats]);

  useEffect(() => {
    void refreshLogs();
    return () => { logsRequest.current++; };
  }, [refreshLogs]);

  const deleteLogs = async (name?: string) => {
    const message = name
      ? `Permanently delete ${name}? New call events can create today's log file again.`
      : 'Permanently delete all call log files? New call events can create today’s file again.';
    if (!window.confirm(message)) return;
    const key = name ?? 'all';
    setBusyKey(key);
    try {
      await api('DELETE', name ? `/call-logs/${encodeURIComponent(name)}` : '/call-logs');
      flash(name ? `${name} deleted.` : 'All call logs deleted.');
      await Promise.all([refreshLogs(), refreshStats()]);
    } catch (err) {
      flash(onError(err), true);
    } finally {
      setBusyKey(null);
    }
  };

  const summary = report?.summary;
  const poorRate = summary?.sessions ? `${(summary.poor / summary.sessions * 100).toFixed(1)}%` : '—';
  const verdictSignal: Record<CallSession['verdict'], Signal> = { good: 'live', fair: 'warn', poor: 'alert' };

  return (
    <div className="call-quality" aria-busy={loading || logsLoading}>
      <section aria-labelledby="h-call-quality">
        <header className="call-quality-head">
          <h2 id="h-call-quality" className="section-title">
            Call quality
            {report && <span className="section-meta">{report.from}–{report.to} UTC</span>}
          </h2>
          <label className="call-quality-days">
            <span>Days</span>
            <select className="field" value={days} onChange={(event) => setDays(Number(event.target.value) as 1 | 7 | 30)}>
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
            </select>
          </label>
        </header>
        {loadError && <p className="note note-alert" role="alert">Call stats unavailable: {loadError}</p>}
        {loading && <p className="empty" role="status">Loading call statistics…</p>}
        {report && (
          <>
            <div className="call-quality-summary" aria-label="Call quality summary">
              <div className="health-seg">
                <span className="health-name">Sessions</span>
                <strong className="call-quality-value">{summary?.sessions ?? 0}</strong>
                <span className="note">{summary?.withStats ?? 0} with browser stats</span>
              </div>
              <div className="health-seg">
                <span className="health-name">Poor</span>
                <strong className="call-quality-value">{poorRate}</strong>
                <span className="note">{summary?.poor ?? 0} sessions</span>
              </div>
              <div className="health-seg">
                <span className="health-name">Median RTT</span>
                <strong className="call-quality-value">{milliseconds(summary?.rttMedian ?? null)}</strong>
              </div>
              <div className="health-seg">
                <span className="health-name">Avg audio loss</span>
                <strong className="call-quality-value">{percent(summary?.lossAvg ?? null)}</strong>
              </div>
              <div className="health-seg">
                <span className="health-name">Avg concealed</span>
                <strong className="call-quality-value">{percent(summary?.concealedAvg ?? null)}</strong>
              </div>
            </div>
            <div className="call-quality-groups">
              <GroupTable title="By browser" groups={report.byBrowser} />
              <GroupTable title="By day" groups={report.byDay} />
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="h-call-sessions">
        <h2 id="h-call-sessions" className="section-title">
          Sessions <span className="section-meta">{report ? `${report.sessionsTotal} total` : ''}</span>
        </h2>
        {loadError && !report ? <p className="empty">Call session rows could not be loaded.</p> : null}
        {report && (report.sessions.length ? (
          <div className="table-wrap">
            <table className="rec-table call-quality-sessions">
              <thead>
                <tr>
                  <th scope="col">Room</th>
                  <th scope="col">Person / browser</th>
                  <th scope="col">Duration / started</th>
                  <th scope="col" className="num">RTT p95</th>
                  <th scope="col" className="num">Loss</th>
                  <th scope="col" className="num">Concealed</th>
                  <th scope="col">Path</th>
                  <th scope="col" className="num">Drops</th>
                  <th scope="col" className="num">Low-bandwidth mode</th>
                  <th scope="col">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {report.sessions.map((session) => {
                  const shortIdentity = session.identity.length > 17
                    ? `${session.identity.slice(0, 8)}…${session.identity.slice(-6)}`
                    : session.identity;
                  const started = new Date(session.start);
                  return (
                    <tr key={`${session.room}/${session.identity}/${session.start}`}>
                      <td className="mono call-quality-room">{session.room}</td>
                      <td>
                        <span className="mono" title={session.identity}>{shortIdentity}</span>
                        <span className="call-quality-secondary">
                          {session.browser} · {session.os} · {session.samples} samples{session.embedded ? ' · embedded' : ''}
                        </span>
                      </td>
                      <td>
                        <span>{formatDuration(session.durationSec)}</span>
                        <time className="call-quality-secondary" dateTime={session.start}>{started.toLocaleString()}</time>
                      </td>
                      <td className="num mono">{milliseconds(session.rttP95)}</td>
                      <td className="num mono">{percent(session.lossAvg)}</td>
                      <td className="num mono">{percent(session.concealedAvg)}</td>
                      <td className="mono">{session.path ?? '—'}</td>
                      <td className="num mono">{session.drops}</td>
                      <td className="num mono" title={`${session.adaptLow} low-bandwidth switch${session.adaptLow === 1 ? '' : 'es'}`}>{session.adaptLow}</td>
                      <td><span className="call-quality-verdict"><Led signal={verdictSignal[session.verdict]} />{session.verdict}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="empty">No call sessions in this period.</p>)}
      </section>

      <section aria-labelledby="h-call-logs">
        <header className="call-quality-log-head">
          <h2 id="h-call-logs" className="section-title">
            Logs <span className="section-meta">{files ? `${files.length} ${files.length === 1 ? 'file' : 'files'}` : ''}</span>
          </h2>
          <button type="button" className="key key-danger" disabled={!files?.length || busyKey !== null} onClick={() => void deleteLogs()}>
            <Trash2 aria-hidden="true" />
            {busyKey === 'all' ? 'Deleting…' : 'Delete all'}
          </button>
        </header>
        {logsError && <p className="note note-alert" role="alert">Call logs unavailable: {logsError}</p>}
        {logsLoading && <p className="empty" role="status">Loading log files…</p>}
        {files && !files.length && !logsLoading && <p className="empty">No call log files have been written yet.</p>}
        {files && files.length > 0 && (
          <div className="table-wrap">
            <table className="rec-table call-quality-logs">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col" className="num">Size</th>
                  <th scope="col">Modified</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => {
                  const modified = new Date(file.modifiedAt);
                  return (
                    <tr key={file.name}>
                      <td className="mono rec-file">{file.name}</td>
                      <td className="num mono">{formatBytes(file.bytes)}</td>
                      <td><time dateTime={file.modifiedAt}>{modified.toLocaleString()}</time></td>
                      <td>
                        <div className="file-actions">
                          <button
                            type="button"
                            className="key key-danger key-square"
                            disabled={busyKey !== null}
                            aria-label={`Delete ${file.name}`}
                            title="Delete log"
                            onClick={() => void deleteLogs(file.name)}
                          >
                            <Trash2 aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
