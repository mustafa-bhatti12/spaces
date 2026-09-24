'use client';

import type { LucideIcon } from 'lucide-react';
import { CircleDot, CircleStop, Download, ExternalLink, Lock, LogOut, Mic, MicOff, MonitorUp, Play, Trash2, UserX, Video, Volume2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { initials, Led, Readout, ReadoutSegment, Wordmark } from '../ui/Device';

// Operator control center. Everything goes through /admin/api/* (session-checked, then forwarded to
// token-service's /admin/* with ADMIN_SHARED_SECRET). Names/identities come from call participants,
// so they're rendered as text only — React escapes them.

interface Check {
  ok: boolean;
  detail: string;
}
interface Health {
  livekit: Check;
  compressor: Check;
  egressWorker: Check;
  disk: { freeBytes: number; totalBytes: number } | null;
}
interface AdminTrack {
  sid: string;
  kind: string;
  source: string;
  muted: boolean;
}
interface AdminParticipant {
  identity: string;
  name: string;
  state: string;
  joinedAt: string;
  tracks: AdminTrack[];
}
interface AdminRoom {
  name: string;
  createdAt: string;
  participants: AdminParticipant[];
}
interface ActiveRecording {
  egressId: string;
  roomName: string;
  startedBy?: string;
}
interface RecordingFile {
  kind: 'raw' | 'compressed';
  name: string;
  bytes: number;
  modifiedAt: string;
}
interface Overview {
  rooms: AdminRoom[];
  activeRecordings: ActiveRecording[];
  files: RecordingFile[];
  errors: Record<string, string>;
}

const OVERVIEW_EVERY_MS = 5000;
const HEALTH_EVERY_MS = 15000;
const SOURCES: Record<string, { label: string; icon: LucideIcon }> = {
  MICROPHONE: { label: 'Mic', icon: Mic },
  CAMERA: { label: 'Camera', icon: Video },
  SCREEN_SHARE: { label: 'Screen', icon: MonitorUp },
  SCREEN_SHARE_AUDIO: { label: 'Screen audio', icon: Volume2 },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function since(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
  return new Date(iso).toLocaleString();
}

const fileUrl = (f: RecordingFile, download = false) =>
  `/admin/api/files/${encodeURIComponent(f.kind)}/${encodeURIComponent(f.name)}${download ? '?download=1' : ''}`;

class SessionExpired extends Error {}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (res.status === 401) throw new SessionExpired('Session expired, please log in again.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status})`);
  return data as T;
}

export function AdminDashboard() {
  const [session, setSession] = useState<'loading' | 'disabled' | 'login' | 'in'>('loading');

  useEffect(() => {
    fetch('/admin/session', { cache: 'no-store' })
      .then((res) => res.json())
      .then((s: { enabled: boolean; authenticated: boolean }) =>
        setSession(!s.enabled ? 'disabled' : s.authenticated ? 'in' : 'login'),
      )
      .catch(() => setSession('login'));
  }, []);

  if (session === 'loading') return null;
  if (session === 'disabled') {
    return (
      <main className="gate">
        <header className="page-top">
          <Wordmark suffix="Control Center" />
        </header>
        <section className="face gate-face">
          <span className="end-icon end-icon-idle" aria-hidden="true">
            <Lock />
          </span>
          <h1 className="title">The control center is off</h1>
          <p className="lede">
            Set <code>ADMIN_PASSWORD</code> and <code>ADMIN_SHARED_SECRET</code> on this deployment to turn it on.
          </p>
        </section>
      </main>
    );
  }
  if (session === 'login') return <Login onLoggedIn={() => setSession('in')} />;
  return <Dashboard onLoggedOut={() => setSession('login')} />;
}

function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <main className="gate">
      <header className="page-top">
        <Wordmark suffix="Control Center" />
      </header>
      <form
        className="face gate-face"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            const res = await fetch('/admin/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password }),
            });
            if (res.ok) {
              onLoggedIn();
              return;
            }
            const data = await res.json().catch(() => ({}));
            setError(data.error || `Sign-in failed (${res.status}).`);
          } catch {
            setError('Could not reach the server. Check your connection and try again.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="end-icon end-icon-idle" aria-hidden="true">
          <Lock />
        </span>
        <h1 className="title">Operator sign-in</h1>
        <p className="lede">Live rooms, recordings and service health for this Space deployment.</p>
        <label className="field-label" htmlFor="admin-password">
          Password
        </label>
        <input
          id="admin-password"
          className="field"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? 'admin-error' : undefined}
          required
          autoFocus
        />
        <p id="admin-error" className="note note-alert" role="alert" hidden={!error}>
          {error}
        </p>
        <button type="submit" className="key key-go key-wide" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

function Dashboard({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState('Loading…');
  const [stale, setStale] = useState(false);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [playing, setPlaying] = useState<Set<string>>(() => new Set());
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flash = useCallback((message: string, error = false) => {
    setToast({ message, error });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof SessionExpired) onLoggedOut();
      return err instanceof Error ? err.message : String(err);
    },
    [onLoggedOut],
  );

  const refreshOverview = useCallback(async () => {
    try {
      const data = await api<Overview>('GET', '/overview');
      setOverview(data);
      const problems = Object.entries(data.errors ?? {}).map(([part, message]) => `${part}: ${message}`);
      setStatus(problems.length ? `Partial update (${problems.join('; ')})` : `Updated ${new Date().toLocaleTimeString()}`);
      setStale(problems.length > 0);
    } catch (err) {
      setStatus(`Update failed: ${handleError(err)}`);
      setStale(true);
    }
  }, [handleError]);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api<Health>('GET', '/health'));
    } catch (err) {
      handleError(err);
      setHealth(null);
    }
  }, [handleError]);

  useEffect(() => {
    refreshOverview();
    refreshHealth();
    const a = setInterval(refreshOverview, OVERVIEW_EVERY_MS);
    const b = setInterval(refreshHealth, HEALTH_EVERY_MS);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [refreshOverview, refreshHealth]);

  const act = async (key: string, work: () => Promise<unknown>, success: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusyKey(key);
    try {
      await work();
      flash(success);
      await refreshOverview();
    } catch (err) {
      flash(handleError(err), true);
    } finally {
      setBusyKey(null);
    }
  };

  const recordingByRoom = new Map((overview?.activeRecordings ?? []).map((r) => [r.roomName, r]));
  const roomCount = overview?.rooms.length ?? 0;
  const peopleCount = overview?.rooms.reduce((n, r) => n + r.participants.length, 0) ?? 0;

  return (
    <div className="console">
      <header className="console-top">
        <Wordmark suffix="Control Center" />
        <Readout className="console-status" live>
          <ReadoutSegment>
            <Led signal={stale ? 'warn' : 'live'} />
            <span className={stale ? 'readout-warn' : undefined} title={status}>
              {status}
            </span>
          </ReadoutSegment>
        </Readout>
        <nav className="console-actions" aria-label="Console">
          <a className="key key-quiet" href="/" target="_blank" rel="noopener">
            Call page
            <ExternalLink aria-hidden="true" />
          </a>
          <button
            type="button"
            className="key key-quiet"
            onClick={async () => {
              await fetch('/admin/logout', { method: 'POST' });
              onLoggedOut();
            }}
          >
            <LogOut aria-hidden="true" />
            Sign out
          </button>
        </nav>
      </header>

      <main className="console-main">
        <section aria-labelledby="h-health">
          <h2 id="h-health" className="section-title">
            Services
          </h2>
          <div className="health-strip">
            {health ? (
              <>
                <HealthSegment name="LiveKit server" check={health.livekit} okLabel="Running" badLabel="Unreachable" />
                <HealthSegment name="Recording worker" check={health.egressWorker} okLabel="Running" badLabel="Not running" />
                <HealthSegment name="Compressor" check={health.compressor} okLabel="Running" badLabel="Unreachable" />
                <DiskSegment disk={health.disk} />
              </>
            ) : (
              <div className="health-seg">
                <span className="health-state">
                  <Led signal="idle" />
                  Health unavailable
                </span>
                <span className="note">Retrying every 15 seconds.</span>
              </div>
            )}
          </div>
        </section>

        <section aria-labelledby="h-rooms">
          <h2 id="h-rooms" className="section-title">
            Live rooms
            {overview && (
              <span className="section-meta">
                {roomCount} {roomCount === 1 ? 'room' : 'rooms'} · {peopleCount} {peopleCount === 1 ? 'person' : 'people'}
              </span>
            )}
          </h2>
          {!overview?.rooms.length ? (
            <p className="empty">No active rooms. A room appears here as soon as someone joins it.</p>
          ) : (
            <div className="room-blocks">
              {overview.rooms.map((room) => {
                const rec = recordingByRoom.get(room.name);
                const recKey = `rec-${room.name}`;
                return (
                  <article key={room.name} className="room-block" aria-label={`Room ${room.name}`}>
                    <header className="room-block-head">
                      <div className="room-block-id">
                        <h3 className="mono">{room.name}</h3>
                        <span className="note">
                          {room.participants.length} {room.participants.length === 1 ? 'person' : 'people'} · started {since(room.createdAt)}
                        </span>
                      </div>
                      <div className="room-block-actions">
                        {rec ? (
                          <>
                            <span className="rec-tag">
                              <Led signal="alert" pulse />
                              REC{rec.startedBy ? ` · ${rec.startedBy}` : ''}
                            </span>
                            <button
                              type="button"
                              className="key"
                              disabled={busyKey === recKey}
                              onClick={() =>
                                act(recKey, () => api('POST', '/recordings/stop', { egressId: rec.egressId }), 'Recording stopped. It appears below once saved.')
                              }
                            >
                              <CircleStop aria-hidden="true" />
                              Stop recording
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="key"
                            disabled={busyKey === recKey}
                            onClick={() => act(recKey, () => api('POST', '/recordings/start', { room: room.name }), `Recording started in ${room.name}`)}
                          >
                            <CircleDot aria-hidden="true" />
                            Record
                          </button>
                        )}
                        <span className="danger-gap" aria-hidden="true" />
                        <button
                          type="button"
                          className="key key-danger"
                          disabled={busyKey === `close-${room.name}`}
                          onClick={() =>
                            act(
                              `close-${room.name}`,
                              () => api('POST', '/rooms/close', { room: room.name }),
                              `${room.name} closed`,
                              `Close ${room.name}? Everyone is disconnected and any recording in it stops.`,
                            )
                          }
                        >
                          <X aria-hidden="true" />
                          Close room
                        </button>
                      </div>
                    </header>
                    {room.participants.length === 0 ? (
                      <p className="room-block-empty note">Nobody connected right now.</p>
                    ) : (
                      <ul className="room-people">
                        {room.participants.map((p) => {
                          const label = p.name || p.identity;
                          return (
                            <li key={p.identity} className="room-person">
                              <span className="avatar" aria-hidden="true">
                                {initials(label)}
                              </span>
                              <span className="person-info">
                                <span className="person-name">{p.name || '(no name)'}</span>
                                <span className="person-status mono">
                                  {p.identity} · joined {since(p.joinedAt)}
                                </span>
                              </span>
                              <span className="tracks">
                                {p.tracks.length === 0 && <span className="note">Not publishing</span>}
                                {p.tracks.map((t) => {
                                  const source = SOURCES[t.source];
                                  const Icon = t.muted && t.source === 'MICROPHONE' ? MicOff : (source?.icon ?? Mic);
                                  const canMute = !t.muted && (t.kind === 'AUDIO' || t.kind === 'VIDEO');
                                  return (
                                    <span key={t.sid} className={`track${t.muted ? ' track-muted' : ''}`}>
                                      <Icon aria-hidden="true" />
                                      {source?.label ?? t.kind.toLowerCase()}
                                      {t.muted && <span className="track-state">muted</span>}
                                      {canMute && (
                                        <button
                                          type="button"
                                          className="track-mute"
                                          disabled={busyKey === `mute-${t.sid}`}
                                          aria-label={`Mute ${label}'s ${(source?.label ?? t.kind).toLowerCase()}`}
                                          onClick={() =>
                                            act(
                                              `mute-${t.sid}`,
                                              () => api('POST', '/tracks/mute', { room: room.name, identity: p.identity, trackSid: t.sid, muted: true }),
                                              `${label}'s ${(source?.label ?? 'track').toLowerCase()} muted`,
                                            )
                                          }
                                        >
                                          Mute
                                        </button>
                                      )}
                                    </span>
                                  );
                                })}
                              </span>
                              <span className="danger-gap" aria-hidden="true" />
                              <button
                                type="button"
                                className="key key-danger"
                                disabled={busyKey === `remove-${p.identity}`}
                                onClick={() =>
                                  act(
                                    `remove-${p.identity}`,
                                    () => api('POST', '/participants/remove', { room: room.name, identity: p.identity }),
                                    `${label} removed`,
                                    `Remove ${label} from ${room.name}? They can rejoin with the room link.`,
                                  )
                                }
                              >
                                <UserX aria-hidden="true" />
                                Remove
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section aria-labelledby="h-recs">
          <h2 id="h-recs" className="section-title">
            Recordings
            {overview && (
              <span className="section-meta">
                {overview.files.length} {overview.files.length === 1 ? 'file' : 'files'}
              </span>
            )}
          </h2>
          {!overview?.files.length ? (
            <p className="empty">No recordings yet. Start one from a live room above, or with Record in a call.</p>
          ) : (
            <div className="table-wrap">
              <table className="rec-table">
                <thead>
                  <tr>
                    <th scope="col">File</th>
                    <th scope="col">Type</th>
                    <th scope="col" className="num">
                      Size
                    </th>
                    <th scope="col">Saved</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.files.map((f) => {
                    const key = `${f.kind}/${f.name}`;
                    return (
                      <tr key={key}>
                        <td className="mono rec-file">{f.name}</td>
                        <td>
                          <span className={`kind kind-${f.kind}`} title={f.kind === 'raw' ? 'Still recording, or waiting to be compressed' : 'Final compressed copy'}>
                            {f.kind === 'raw' ? 'Raw' : 'Compressed'}
                          </span>
                        </td>
                        <td className="num mono">{formatBytes(f.bytes)}</td>
                        <td title={new Date(f.modifiedAt).toLocaleString()}>{since(f.modifiedAt)}</td>
                        <td>
                          <div className="file-actions">
                            {playing.has(key) ? (
                              <audio controls autoPlay src={fileUrl(f)} onError={() => flash('Could not play this file. It may still be recording.', true)} />
                            ) : (
                              <button type="button" className="key" onClick={() => setPlaying((s) => new Set(s).add(key))}>
                                <Play aria-hidden="true" />
                                Play
                              </button>
                            )}
                            <a className="key key-square" href={fileUrl(f, true)} aria-label={`Download ${f.name}`} title="Download">
                              <Download aria-hidden="true" />
                            </a>
                            <span className="danger-gap" aria-hidden="true" />
                            <button
                              type="button"
                              className="key key-danger key-square"
                              disabled={busyKey === `delete-${key}`}
                              aria-label={`Delete ${f.name}`}
                              title="Delete"
                              onClick={() =>
                                act(
                                  `delete-${key}`,
                                  () => api('DELETE', `/files/${encodeURIComponent(f.kind)}/${encodeURIComponent(f.name)}`),
                                  'Recording deleted',
                                  `Permanently delete ${f.name}? This cannot be undone.`,
                                )
                              }
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
      </main>

      <div className="toast-slot" role="status" aria-live="polite">
        {toast && (
          <div className={`toast${toast.error ? ' toast-error' : ''}`} key={toast.message}>
            {toast.message}
          </div>
        )}
      </div>
    </div>
  );
}

function HealthSegment({ name, check, okLabel, badLabel }: { name: string; check: Check; okLabel: string; badLabel: string }) {
  return (
    <div className="health-seg">
      <span className="health-name">{name}</span>
      <span className="health-state">
        <Led signal={check.ok ? 'live' : 'alert'} />
        {check.ok ? okLabel : badLabel}
      </span>
      <span className="note health-detail">{check.detail}</span>
    </div>
  );
}

function DiskSegment({ disk }: { disk: Health['disk'] }) {
  if (!disk) {
    return (
      <div className="health-seg">
        <span className="health-name">Disk</span>
        <span className="health-state">
          <Led signal="idle" />
          Unknown
        </span>
      </div>
    );
  }
  const usedPct = Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100);
  const signal = usedPct >= 90 ? 'alert' : usedPct >= 75 ? 'warn' : 'live';
  return (
    <div className="health-seg">
      <span className="health-name">Disk</span>
      <span className="health-state">
        <Led signal={signal} />
        <span className="mono">{formatBytes(disk.freeBytes)}</span> free
      </span>
      <span className="note health-detail">
        {usedPct}% of {formatBytes(disk.totalBytes)} used
      </span>
      <div className={`meter meter-${signal}`} role="meter" aria-valuenow={usedPct} aria-valuemin={0} aria-valuemax={100} aria-label="Disk used">
        <div style={{ width: `${usedPct}%` }} />
      </div>
    </div>
  );
}
