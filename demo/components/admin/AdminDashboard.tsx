'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
const SOURCE_LABELS: Record<string, string> = {
  MICROPHONE: '🎙️ Mic',
  CAMERA: '📷 Camera',
  SCREEN_SHARE: '🖥️ Screen',
  SCREEN_SHARE_AUDIO: '🔊 Screen audio',
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
      <main className="lobby">
        <div className="lobby-card">
          <h1>Admin is disabled</h1>
          <p>Set ADMIN_PASSWORD and ADMIN_SHARED_SECRET on this deployment to enable the control center.</p>
        </div>
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
    <main className="lobby">
      <form
        className="lobby-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          const res = await fetch('/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
          });
          setBusy(false);
          if (res.ok) {
            onLoggedIn();
            return;
          }
          const data = await res.json().catch(() => ({}));
          setError(data.error || `Login failed (${res.status})`);
        }}
      >
        <h1>Space Control Center</h1>
        <p>Operator access to rooms, recordings and service health.</p>
        <input
          className="lk-form-control"
          type="password"
          placeholder="Admin password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-label="Admin password"
          required
          autoFocus
        />
        <div className="error-text" role="alert">
          {error}
        </div>
        <button type="submit" className="lk-button lk-join-button" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
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

  return (
    <div className="admin">
      <header className="conference-topbar">
        <span className="room-title">⚙️ Space Control Center</span>
        <span className="spacer" />
        <span className={`admin-status${stale ? ' stale' : ''}`}>{status}</span>
        <a className="lk-button" href="/" target="_blank" rel="noopener">
          Open call page
        </a>
        <button
          type="button"
          className="lk-button"
          onClick={async () => {
            await fetch('/admin/logout', { method: 'POST' });
            onLoggedOut();
          }}
        >
          Log out
        </button>
      </header>

      <main className="admin-main">
        <section>
          <h2>Service health</h2>
          <div className="health-grid">
            {health ? (
              <>
                <HealthCard name="LiveKit server" check={health.livekit} okLabel="Running" badLabel="Unreachable" />
                <HealthCard name="Recording worker" check={health.egressWorker} okLabel="Running" badLabel="Not running" />
                <HealthCard name="Compressor" check={health.compressor} okLabel="Running" badLabel="Unreachable" />
                <DiskCard disk={health.disk} />
              </>
            ) : (
              <div className="health-card">
                <span className="muted">Health unavailable</span>
              </div>
            )}
          </div>
        </section>

        <section>
          <h2>
            Live rooms <span className="muted">{overview?.rooms.length ? `(${overview.rooms.length})` : ''}</span>
          </h2>
          {!overview?.rooms.length ? (
            <div className="admin-empty">No active rooms. Rooms appear here as soon as someone joins.</div>
          ) : (
            <div className="admin-rooms">
              {overview.rooms.map((room) => {
                const rec = recordingByRoom.get(room.name);
                return (
                  <div key={room.name} className="admin-card">
                    <div className="admin-room-head">
                      <strong className="mono">{room.name}</strong>
                      <span className="muted">
                        {room.participants.length} participant{room.participants.length === 1 ? '' : 's'} · started{' '}
                        {since(room.createdAt)}
                      </span>
                      <span className="spacer" />
                      {rec ? (
                        <>
                          <span className="rec-badge">REC{rec.startedBy ? ` · ${rec.startedBy}` : ''}</span>
                          <button
                            type="button"
                            className="lk-button"
                            disabled={busyKey === `rec-${room.name}`}
                            onClick={() =>
                              act(`rec-${room.name}`, () => api('POST', '/recordings/stop', { egressId: rec.egressId }), 'Recording stopped; it appears below once saved')
                            }
                          >
                            Stop recording
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="lk-button"
                          disabled={busyKey === `rec-${room.name}`}
                          onClick={() => act(`rec-${room.name}`, () => api('POST', '/recordings/start', { room: room.name }), `Recording started in ${room.name}`)}
                        >
                          ⏺ Start recording
                        </button>
                      )}
                      <button
                        type="button"
                        className="lk-button lk-disconnect-button"
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
                        Close room
                      </button>
                    </div>
                    {room.participants.length === 0 && <div className="admin-row muted">Nobody connected right now.</div>}
                    {room.participants.map((p) => {
                      const label = p.name || p.identity;
                      return (
                        <div key={p.identity} className="admin-row">
                          <span className="participant-avatar">{label.trim().charAt(0).toUpperCase() || '?'}</span>
                          <span className="participant-info">
                            <span className="name">{p.name || '(no name)'}</span>
                            <span className="sub mono">
                              {p.identity} · joined {since(p.joinedAt)}
                            </span>
                          </span>
                          <span className="admin-tracks">
                            {p.tracks.length === 0 && <span className="muted">Not publishing</span>}
                            {p.tracks.map((t) => (
                              <span key={t.sid} className={`admin-track${t.muted ? ' muted' : ''}`}>
                                {SOURCE_LABELS[t.source] ?? t.kind}
                                {t.muted ? ' (muted)' : ''}
                                {!t.muted && (t.kind === 'AUDIO' || t.kind === 'VIDEO') && (
                                  <button
                                    type="button"
                                    className="lk-button"
                                    disabled={busyKey === `mute-${t.sid}`}
                                    onClick={() =>
                                      act(
                                        `mute-${t.sid}`,
                                        () => api('POST', '/tracks/mute', { room: room.name, identity: p.identity, trackSid: t.sid, muted: true }),
                                        'Track muted',
                                      )
                                    }
                                  >
                                    Mute
                                  </button>
                                )}
                              </span>
                            ))}
                          </span>
                          <button
                            type="button"
                            className="lk-button lk-disconnect-button"
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
                            Remove
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <h2>
            Recordings <span className="muted">{overview?.files.length ? `(${overview.files.length})` : ''}</span>
          </h2>
          {!overview?.files.length ? (
            <div className="admin-empty">No recordings yet. Start one from a live room above or with Record in a call.</div>
          ) : (
            <div className="admin-card">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Type</th>
                    <th>Size</th>
                    <th>Saved</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {overview.files.map((f) => {
                    const key = `${f.kind}/${f.name}`;
                    return (
                      <tr key={key}>
                        <td className="mono">{f.name}</td>
                        <td>
                          <span className={`kind ${f.kind}`} title={f.kind === 'raw' ? 'Still recording, or waiting to be compressed' : 'Final compressed copy'}>
                            {f.kind}
                          </span>
                        </td>
                        <td>{formatBytes(f.bytes)}</td>
                        <td title={new Date(f.modifiedAt).toLocaleString()}>{since(f.modifiedAt)}</td>
                        <td>
                          <div className="file-actions">
                            {playing.has(key) ? (
                              <audio controls autoPlay src={fileUrl(f)} onError={() => flash('Could not play this file (it may still be recording).', true)} />
                            ) : (
                              <button type="button" className="lk-button" onClick={() => setPlaying((s) => new Set(s).add(key))}>
                                ▶ Play
                              </button>
                            )}
                            <a className="lk-button" href={fileUrl(f, true)}>
                              Download
                            </a>
                            <button
                              type="button"
                              className="lk-button lk-disconnect-button"
                              disabled={busyKey === `delete-${key}`}
                              onClick={() =>
                                act(
                                  `delete-${key}`,
                                  () => api('DELETE', `/files/${encodeURIComponent(f.kind)}/${encodeURIComponent(f.name)}`),
                                  'Recording deleted',
                                  `Permanently delete ${f.name}? This cannot be undone.`,
                                )
                              }
                            >
                              Delete
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

      {toast && <div className={`lk-toast app-toast${toast.error ? ' error' : ''}`}>{toast.message}</div>}
    </div>
  );
}

function HealthCard({ name, check, okLabel, badLabel }: { name: string; check: Check; okLabel: string; badLabel: string }) {
  return (
    <div className="health-card">
      <span className="health-name">{name}</span>
      <span className="health-status">
        <span className={`status-dot ${check.ok ? 'ok' : 'bad'}`} />
        {check.ok ? okLabel : badLabel}
      </span>
      <span className="muted">{check.detail}</span>
    </div>
  );
}

function DiskCard({ disk }: { disk: Health['disk'] }) {
  if (!disk) {
    return (
      <div className="health-card">
        <span className="health-name">Disk</span>
        <span className="health-status">Unknown</span>
      </div>
    );
  }
  const usedPct = Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100);
  const state = usedPct >= 90 ? 'bad' : usedPct >= 75 ? 'warn' : 'ok';
  return (
    <div className="health-card">
      <span className="health-name">Disk</span>
      <span className="health-status">
        <span className={`status-dot ${state}`} />
        {formatBytes(disk.freeBytes)} free
      </span>
      <span className="muted">
        {usedPct}% of {formatBytes(disk.totalBytes)} used
      </span>
      <div className="meter">
        <div style={{ width: `${usedPct}%` }} />
      </div>
    </div>
  );
}
