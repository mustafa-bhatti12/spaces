'use client';

import { RotateCcw, RotateCw, Save } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Led } from '../ui/Device';
import { SwitchRow } from '../ui/SwitchRow';
import { api, SessionExpired } from './api';
import type { SystemSnapshot } from './ServerPanel';

// Settings tab. Recording, transcription and capacity settings are saved on the droplet by
// token-service (settings.ts) and apply to the next recording or join, no restart. Everything else is read-only here:
// droplet .env and Railway variables are changed where they live. The restart key restarts the
// droplet stack, which token-service refuses while anyone is in a call.

interface RuntimeSettings {
  transcription: { enabled: boolean; languageHints: string[]; terms: string[]; translateTo: string };
  recording: { audioKbps: number; recordAllCalls: boolean };
  limits: { maxPerRoom: number; maxTotal: number };
}
interface SettingsView {
  settings: RuntimeSettings;
  defaults: RuntimeSettings;
  saved: boolean;
  limits: { kbpsMin: number; kbpsMax: number; peopleMin: number; peopleMax: number };
  info: {
    publicUrl: string | null;
    livekitUrl: string | null;
    turnDomain: string | null;
    sonioxRegion: string;
    /** What livekit/config.yaml runs with; only a restart changes these. */
    room: { emptyTimeout: number; departureTimeout: number; maxParticipants: number } | null;
    secrets: { livekitApiKey: boolean; consumerSecret: boolean; adminSecret: boolean; sonioxApiKey: boolean };
    restart: { available: boolean; reason?: string };
  };
}
interface AppConfig {
  tokenServiceUrl: string;
  embedAllowedOrigins: string[];
  trustProxy: boolean;
  secrets: { consumerSecret: boolean; adminSecret: boolean; adminPassword: boolean };
  commit: string | null;
}

interface Draft {
  enabled: boolean;
  hints: string;
  terms: string;
  translateTo: string;
  kbps: string;
  recordAll: boolean;
  maxPerRoom: string;
  maxTotal: string;
}

const toDraft = (s: RuntimeSettings): Draft => ({
  enabled: s.transcription.enabled,
  hints: s.transcription.languageHints.join(', '),
  terms: s.transcription.terms.join('\n'),
  translateTo: s.transcription.translateTo,
  kbps: String(s.recording.audioKbps),
  recordAll: s.recording.recordAllCalls,
  maxPerRoom: String(s.limits.maxPerRoom),
  maxTotal: String(s.limits.maxTotal),
});
const split = (value: string, by: RegExp) =>
  value
    .split(by)
    .map((v) => v.trim())
    .filter(Boolean);
const fromDraft = (d: Draft): RuntimeSettings => ({
  transcription: {
    enabled: d.enabled,
    languageHints: split(d.hints, /[,\s]+/),
    terms: split(d.terms, /[\n,]+/),
    translateTo: d.translateTo.trim(),
  },
  recording: { audioKbps: Number(d.kbps), recordAllCalls: d.recordAll },
  limits: { maxPerRoom: Number(d.maxPerRoom), maxTotal: Number(d.maxTotal) },
});
const list = (items: string[]) => (items.length ? items.join(', ') : 'none');

const RESTART_WAIT_MS = 120_000;
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export function SettingsPanel({
  system,
  peopleInCalls,
  recordingsRunning,
  onError,
  flash,
}: {
  system: SystemSnapshot | null;
  peopleInCalls: number;
  recordingsRunning: number;
  /** Logs out on an expired session; returns the message to show. */
  onError: (err: unknown) => string;
  flash: (message: string, error?: boolean) => void;
}) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [app, setApp] = useState<AppConfig | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<'save' | 'reset' | 'restart' | null>(null);
  const alive = useRef(true);

  const apply = useCallback((next: SettingsView) => {
    setView(next);
    setDraft(toDraft(next.settings));
  }, []);

  const load = useCallback(async () => {
    try {
      const [settings, config] = await Promise.all([
        api<SettingsView>('GET', '/settings'),
        fetch('/admin/config', { cache: 'no-store' }).then(async (res) => {
          if (res.status === 401) throw new SessionExpired('Session expired, please log in again.');
          if (!res.ok) throw new Error(`Call app settings failed (${res.status})`);
          return (await res.json()) as AppConfig;
        }),
      ]);
      if (!alive.current) return;
      apply(settings);
      setApp(config);
      setLoadError('');
    } catch (err) {
      if (alive.current) setLoadError(onError(err));
    }
  }, [apply, onError]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  if (!view || !draft) {
    return <p className="empty">{loadError ? `Settings unavailable: ${loadError}` : 'Loading settings…'}</p>;
  }

  const next = fromDraft(draft);
  const dirty = JSON.stringify(next) !== JSON.stringify(view.settings);
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const { defaults, info, limits } = view;
  const noKey = !info.secrets.sonioxApiKey;

  const save = async () => {
    setBusy('save');
    try {
      apply(await api<SettingsView>('POST', '/settings', next));
      flash('Settings saved. They apply to the next recording or join.');
    } catch (err) {
      flash(onError(err), true);
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    if (!window.confirm('Go back to the values in token-service/.env on the droplet?')) return;
    setBusy('reset');
    try {
      apply(await api<SettingsView>('POST', '/settings/reset', {}));
      flash('Back to the .env values.');
    } catch (err) {
      flash(onError(err), true);
    } finally {
      setBusy(null);
    }
  };

  const restart = async () => {
    const text =
      'Restart Spaces now?\n\nLiveKit, token-service, Redis and the recording worker restart together. ' +
      'It takes about 15 seconds, and nobody can join a call until it is back.';
    if (!window.confirm(text)) return;
    setBusy('restart');
    try {
      await api('POST', '/restart', {});
    } catch (err) {
      flash(onError(err), true);
      setBusy(null);
      return;
    }
    flash('Restarting Spaces…');
    // Back once /health answers again after having gone away (or after 30 s, in case the restart
    // was quicker than a poll).
    const started = Date.now();
    let wentDown = false;
    let back = false;
    while (alive.current && Date.now() - started < RESTART_WAIT_MS) {
      await sleep(3000);
      try {
        await api('GET', '/health');
        if (wentDown || Date.now() - started > 30_000) {
          back = true;
          break;
        }
      } catch (err) {
        if (err instanceof SessionExpired) {
          onError(err);
          return;
        }
        wentDown = true;
      }
    }
    if (!alive.current) return;
    setBusy(null);
    if (back) {
      flash('Spaces restarted.');
      void load();
    } else {
      flash("Spaces hasn't come back after 2 minutes. Check journalctl -u spaces on the droplet.", true);
    }
  };

  const restartBlock = !info.restart.available
    ? info.restart.reason
    : peopleInCalls > 0
      ? `${peopleInCalls} ${peopleInCalls === 1 ? 'person is' : 'people are'} in a call. Restart once the rooms are empty.`
      : recordingsRunning > 0
        ? 'A recording is still running. Restart once it has finished.'
        : null;

  return (
    <div className="settings">
      <section aria-labelledby="h-settings-calls">
        <h2 id="h-settings-calls" className="section-title">
          Recording and transcripts
          <span className="section-meta">{view.saved ? 'Saved here, overrides .env' : 'From token-service/.env'}</span>
        </h2>
        <form
          className="settings-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) void save();
          }}
        >
          <div className="settings-group">
            <h3 className="settings-group-title">Transcription</h3>
            <SwitchRow
              label="Transcribe recordings"
              hint={
                noKey
                  ? 'Set SONIOX_API_KEY in token-service/.env on the droplet first.'
                  : draft.enabled
                    ? 'Every finished recording goes to Soniox.'
                    : "Off: new recordings aren't sent to Soniox. Recordings made while off are transcribed at the next restart, or from their row."
              }
              checked={draft.enabled && !noKey}
              disabled={noKey}
              onChange={(enabled) => set({ enabled })}
            />
            <div className="settings-fields">
              <label className="settings-field">
                <span className="field-label">Language hints</span>
                <input
                  className="field mono"
                  value={draft.hints}
                  onChange={(e) => set({ hints: e.target.value })}
                  placeholder="en, ur, ar"
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="note">Languages the calls are likely in. .env: {list(defaults.transcription.languageHints)}</span>
              </label>
              <label className="settings-field">
                <span className="field-label">Translate to</span>
                <input
                  className="field mono"
                  value={draft.translateTo}
                  onChange={(e) => set({ translateTo: e.target.value })}
                  placeholder="none"
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="note">
                  Language code, e.g. en. Empty: no translation. Translated text is billed as extra output. .env:{' '}
                  {defaults.transcription.translateTo || 'none'}
                </span>
              </label>
              <label className="settings-field settings-field-wide">
                <span className="field-label">Special terms</span>
                <textarea
                  className="field settings-textarea"
                  value={draft.terms}
                  onChange={(e) => set({ terms: e.target.value })}
                  placeholder={'USCIS\nNIW'}
                  rows={4}
                  spellCheck={false}
                />
                <span className="note">
                  Names and acronyms Soniox should expect, one per line or comma-separated. .env: {list(defaults.transcription.terms)}
                </span>
              </label>
            </div>
          </div>

          <div className="settings-group">
            <h3 className="settings-group-title">Recording</h3>
            <SwitchRow
              label="Record every call"
              hint={
                draft.recordAll
                  ? 'Every call is recorded from its first join.'
                  : 'Off: only calls a consumer app asks to record, and calls someone presses Record in.'
              }
              checked={draft.recordAll}
              onChange={(recordAll) => set({ recordAll })}
            />
            <div className="settings-fields">
              <label className="settings-field">
                <span className="field-label">Audio bitrate (kbps)</span>
                <input
                  className="field mono"
                  type="number"
                  inputMode="numeric"
                  min={limits.kbpsMin}
                  max={limits.kbpsMax}
                  step={1}
                  value={draft.kbps}
                  onChange={(e) => set({ kbps: e.target.value })}
                />
                <span className="note">
                  Opus, {limits.kbpsMin}–{limits.kbpsMax}. 24 is plenty for speech and transcripts. .env: {defaults.recording.audioKbps}
                </span>
              </label>
            </div>
          </div>

          <div className="settings-group">
            <h3 className="settings-group-title">Limits</h3>
            <div className="settings-fields">
              <label className="settings-field">
                <span className="field-label">People per call</span>
                <input
                  className="field mono"
                  type="number"
                  inputMode="numeric"
                  min={limits.peopleMin}
                  max={limits.peopleMax}
                  step={1}
                  value={draft.maxPerRoom}
                  onChange={(e) => set({ maxPerRoom: e.target.value })}
                />
                <span className="note">
                  {limits.peopleMin}–{limits.peopleMax}.
                  {info.room?.maxParticipants
                    ? ` LiveKit refuses more than ${info.room.maxParticipants} in one room whatever this says; going above that means room.max_participants in livekit/config.yaml and a restart.`
                    : ''}{' '}
                  .env: {defaults.limits.maxPerRoom}
                </span>
              </label>
              <label className="settings-field">
                <span className="field-label">People across all calls</span>
                <input
                  className="field mono"
                  type="number"
                  inputMode="numeric"
                  min={limits.peopleMin}
                  max={limits.peopleMax}
                  step={1}
                  value={draft.maxTotal}
                  onChange={(e) => set({ maxTotal: e.target.value })}
                />
                <span className="note">
                  Everyone on this server at once. Past it a new call is refused with &ldquo;All calls on this server are full&rdquo;;
                  people already in a call are never turned away. .env: {defaults.limits.maxTotal}
                </span>
              </label>
            </div>
          </div>

          <div className="settings-foot">
            <span className="note">Recording and transcription changes apply to the next recording; limits apply to the next join. No restart, no dropped calls.</span>
            {view.saved && (
              <button type="button" className="key key-quiet" disabled={busy !== null} onClick={reset}>
                <RotateCcw aria-hidden="true" />
                Reset to .env
              </button>
            )}
            <button type="button" className="key" disabled={!dirty || busy !== null} onClick={() => setDraft(toDraft(view.settings))}>
              Discard
            </button>
            <button type="submit" className="key key-go" disabled={!dirty || busy !== null} aria-busy={busy === 'save'}>
              <Save aria-hidden="true" />
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="h-settings-deploy">
        <h2 id="h-settings-deploy" className="section-title">
          Deployment
          <span className="section-meta">Read-only. Secrets show only whether they are set.</span>
        </h2>
        <div className="settings-info">
          <div className="settings-card">
            <h3 className="settings-group-title">Droplet</h3>
            <dl className="info-list">
              <Row label="Public URL">{info.publicUrl ?? `not set (browsers get ${info.livekitUrl ?? '?'})`}</Row>
              <Row label="TURN">{info.turnDomain ? `turns:${info.turnDomain}:443` : 'off'}</Row>
              <Row label="Soniox region">{info.sonioxRegion}</Row>
              {info.room && (
                <>
                  <Row label="Room closes">
                    {info.room.departureTimeout}s after the last person leaves · {info.room.emptyTimeout / 60} min if nobody ever joins
                  </Row>
                  <Row label="LiveKit call limit">
                    {info.room.maxParticipants ? `${info.room.maxParticipants} people per room` : 'none'}
                  </Row>
                </>
              )}
              <Row label="LiveKit key pair">
                <SecretState set={info.secrets.livekitApiKey} />
              </Row>
              <Row label="Consumer secret">
                <SecretState set={info.secrets.consumerSecret} />
              </Row>
              <Row label="Admin secret">
                <SecretState set={info.secrets.adminSecret} />
              </Row>
              <Row label="Soniox API key">
                <SecretState set={info.secrets.sonioxApiKey} />
              </Row>
              <Row label="Deployed">
                {system?.deploy ? `${system.deploy.commit} · ${system.deploy.subject}` : 'unknown'}
              </Row>
              {system?.processes
                .filter((p) => p.version)
                .map((p) => (
                  <Row key={p.name} label={p.name}>
                    {p.version}
                  </Row>
                ))}
            </dl>
            <p className="note">Change these in ~/space/token-service/.env over SSH, then restart below.</p>
          </div>
          <div className="settings-card">
            <h3 className="settings-group-title">Call app (Railway)</h3>
            {app ? (
              <dl className="info-list">
                <Row label="Token service">{app.tokenServiceUrl}</Row>
                <Row label="Embed allowed from">{app.embedAllowedOrigins.length ? app.embedAllowedOrigins.join(', ') : 'only Spaces itself'}</Row>
                <Row label="Trust proxy">{app.trustProxy ? 'on (login limit per client IP)' : 'off (one shared login limit)'}</Row>
                <Row label="Consumer secret">
                  <SecretState set={app.secrets.consumerSecret} />
                </Row>
                <Row label="Admin secret">
                  <SecretState set={app.secrets.adminSecret} />
                </Row>
                <Row label="Admin password">
                  <SecretState set={app.secrets.adminPassword} />
                </Row>
                <Row label="Deployed">{app.commit ?? 'unknown'}</Row>
              </dl>
            ) : (
              <p className="note">Unavailable.</p>
            )}
            <p className="note">
              Change these (including the admin password, ADMIN_PASSWORD) in the service&apos;s Railway variables. Railway redeploys
              on save.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="h-settings-restart">
        <h2 id="h-settings-restart" className="section-title">
          Restart
        </h2>
        <div className="settings-card settings-restart">
          <div className="settings-restart-text">
            <strong>Restart Spaces</strong>
            <span className="note">
              Restarts LiveKit, token-service, Redis and the recording worker on the droplet (about 15 seconds). Needed after
              changing token-service/.env, livekit/config.yaml or egress/config.yaml. It drops every call, so it&apos;s blocked
              while anyone is in one.
            </span>
            {restartBlock && busy !== 'restart' && <span className="note note-alert">{restartBlock}</span>}
          </div>
          <button
            type="button"
            className="key key-danger"
            disabled={!!restartBlock || busy !== null}
            aria-busy={busy === 'restart'}
            onClick={restart}
          >
            <RotateCw aria-hidden="true" className={busy === 'restart' ? 'spin' : undefined} />
            {busy === 'restart' ? 'Restarting…' : 'Restart Spaces'}
          </button>
        </div>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="info-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function SecretState({ set }: { set: boolean }) {
  return (
    <span className="secret-state">
      <Led signal={set ? 'live' : 'alert'} />
      {set ? 'Set' : 'Not set'}
    </span>
  );
}
