'use client';

import { Copy, KeyRound, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Led } from '../ui/Device';
import { api } from './api';
import { since } from './format';

// Registered apps and their API keys (token-service's app registry), plus the audit log. A new
// key's secret is shown once, in the dialog that issued it; after that only its id is known.

interface AppKey {
  keyId: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
interface RegisteredApp {
  slug: string;
  name: string;
  scopes: string[];
  status: 'active' | 'disabled';
  activeKeys: number;
  keys: AppKey[];
  lastUsedAt: string | null;
  /** Petition Studio's shared secret is in use (it has no key row). */
  legacySecret: boolean;
}
interface AppsView {
  scopes: string[];
  apps: RegisteredApp[];
}
interface AuditEvent {
  id: number;
  at: string;
  actor: 'admin' | 'app';
  appSlug: string | null;
  keyId: string | null;
  action: string;
  room: string | null;
  ip: string | null;
  result: string;
  detail: string | null;
}

const MAX_ACTIVE_KEYS = 2;

export function AppsPanel({
  onError,
  flash,
}: {
  onError: (err: unknown) => string;
  flash: (message: string, error?: boolean) => void;
}) {
  const [view, setView] = useState<AppsView | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ app: RegisteredApp; key: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const [apps, log] = await Promise.all([api<AppsView>('GET', '/apps'), api<{ events: AuditEvent[] }>('GET', '/audit?limit=100')]);
      if (!alive.current) return;
      setView(apps);
      setAudit(log.events);
      setLoadError('');
    } catch (err) {
      if (alive.current) setLoadError(onError(err));
    }
  }, [onError]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const newKey = async (app: RegisteredApp) => {
    setBusy(`key:${app.slug}`);
    try {
      const { key } = await api<{ keyId: string; key: string }>('POST', `/apps/${encodeURIComponent(app.slug)}/keys`, {});
      setIssued({ app, key });
      void load();
    } catch (err) {
      flash(onError(err), true);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (app: RegisteredApp, key: AppKey) => {
    if (!window.confirm(`Revoke key ${key.keyId} of ${app.name}?\n\nCalls made with it start failing right away.`)) return;
    setBusy(`revoke:${key.keyId}`);
    try {
      await api('DELETE', `/apps/${encodeURIComponent(app.slug)}/keys/${encodeURIComponent(key.keyId)}`);
      flash(`Key ${key.keyId} revoked.`);
      await load();
    } catch (err) {
      flash(onError(err), true);
    } finally {
      setBusy(null);
    }
  };

  if (!view) return <p className="empty">{loadError ? `Apps unavailable: ${loadError}` : 'Loading apps…'}</p>;

  return (
    <div className="settings">
      <section aria-labelledby="h-apps">
        <h2 id="h-apps" className="section-title">
          Apps
          <span className="section-meta">{view.apps.length} registered</span>
          <button type="button" className="key apps-add" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            New app
          </button>
        </h2>
        <div className="table-wrap">
          <table className="rec-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Scopes</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Active keys
                </th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {view.apps.map((a) => (
                <tr key={a.slug}>
                  <td>
                    {a.name}
                    <br />
                    <span className="mono note">{a.slug}</span>
                  </td>
                  <td>
                    <span className="apps-scopes">
                      {a.scopes.map((s) => (
                        <span key={s} className="kind kind-compressed mono">
                          {s}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td>
                    <span className="transcript-state">
                      <Led signal={a.status === 'active' ? 'live' : 'idle'} />
                      {a.status === 'active' ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td className="num mono">
                    {a.activeKeys}/{MAX_ACTIVE_KEYS}
                    {a.legacySecret && (
                      <>
                        <br />
                        <span className="note" title="TOKEN_SERVICE_SHARED_SECRET maps to this app and keeps working">
                          + shared secret
                        </span>
                      </>
                    )}
                  </td>
                  <td title={a.lastUsedAt ? new Date(a.lastUsedAt).toLocaleString() : undefined}>{a.lastUsedAt ? since(a.lastUsedAt) : 'Never'}</td>
                  <td>
                    <span className="apps-actions">
                      {a.keys
                        .filter((k) => !k.revokedAt)
                        .map((k) => (
                          <button
                            key={k.keyId}
                            type="button"
                            className="key key-quiet mono"
                            disabled={busy !== null}
                            onClick={() => revoke(a, k)}
                            title={`Revoke key ${k.keyId}${k.lastUsedAt ? ` (last used ${since(k.lastUsedAt)})` : ' (never used)'}`}
                          >
                            <X aria-hidden="true" />
                            {k.keyId}
                          </button>
                        ))}
                      <button
                        type="button"
                        className="key"
                        disabled={busy !== null || a.activeKeys >= MAX_ACTIVE_KEYS}
                        title={a.activeKeys >= MAX_ACTIVE_KEYS ? 'Revoke a key first: at most two are active at once.' : undefined}
                        onClick={() => newKey(a)}
                      >
                        <KeyRound aria-hidden="true" />
                        New key
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="h-audit">
        <h2 id="h-audit" className="section-title">
          Audit log
          <span className="section-meta">latest {audit.length}</span>
        </h2>
        {audit.length === 0 ? (
          <p className="empty">Nothing recorded yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="rec-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">App</th>
                  <th scope="col">Action</th>
                  <th scope="col">Room</th>
                  <th scope="col">Result</th>
                  <th scope="col">From</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((e) => (
                  <tr key={e.id}>
                    <td title={new Date(e.at).toLocaleString()}>{since(e.at)}</td>
                    <td>
                      <span className="mono">{e.appSlug ?? '—'}</span>
                      {e.keyId && <span className="note mono"> · {e.keyId}</span>}
                      {e.actor === 'admin' && <span className="note"> · operator</span>}
                    </td>
                    <td className="mono" title={e.detail ?? undefined}>
                      {e.action}
                    </td>
                    <td className="mono">{e.room ?? '—'}</td>
                    <td>{e.result}</td>
                    <td className="mono">{e.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {issued && <NewKeyDialog app={issued.app} secret={issued.key} onClose={() => setIssued(null)} flash={flash} />}
      {creating && (
        <NewAppDialog
          scopes={view.scopes}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

/** Native <dialog> (focus trap, Escape), portaled to body like the call page's leave dialog. */
function Modal({ title, labelId, children, onCancel }: { title: string; labelId: string; children: React.ReactNode; onCancel?: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="face leave-dialog"
      aria-labelledby={labelId}
      onCancel={(e) => {
        e.preventDefault();
        onCancel?.();
      }}
    >
      <h2 id={labelId} className="leave-title">
        {title}
      </h2>
      {children}
    </dialog>,
    document.body,
  );
}

/** Shows the key once. It can't be closed until the operator confirms it is stored. */
function NewKeyDialog({
  app,
  secret,
  onClose,
  flash,
}: {
  app: RegisteredApp;
  secret: string;
  onClose: () => void;
  flash: (message: string, error?: boolean) => void;
}) {
  const [stored, setStored] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      flash('Key copied.');
    } catch {
      flash('Could not copy. Select the key and copy it by hand.', true);
    }
  };
  return (
    <Modal title={`New key for ${app.name}`} labelId="new-key-title">
      <p className="leave-body">This is the only time the key is shown. Spaces keeps just a hash, so a lost key can only be replaced.</p>
      <div className="field-row">
        <input className="field mono" readOnly value={secret} aria-label="API key" onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
        <button type="button" className="key" onClick={copy}>
          <Copy aria-hidden="true" />
          Copy
        </button>
      </div>
      <label className="apps-confirm">
        <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} />
        I&rsquo;ve stored it
      </label>
      <div className="leave-actions">
        <button type="button" className="key" disabled={!stored} onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

function NewAppDialog({
  scopes,
  onClose,
  onCreated,
  onError,
}: {
  scopes: string[];
  onClose: () => void;
  onCreated: () => void;
  onError: (err: unknown) => string;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('POST', '/apps', { name, slug, scopes: [...picked] });
      onCreated();
    } catch (err) {
      setError(onError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="New app" labelId="new-app-title" onCancel={busy ? undefined : onClose}>
      <form className="settings-group" onSubmit={submit}>
        <label className="settings-field">
          <span className="field-label">Name</span>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus />
        </label>
        <label className="settings-field">
          <span className="field-label">Slug</span>
          <input
            className="field mono"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            pattern="[a-z][a-z0-9\-]{1,30}"
            required
            spellCheck={false}
          />
          <span className="note">Lowercase letters, digits and dashes. It can&rsquo;t change later.</span>
        </label>
        <fieldset className="apps-scope-set">
          <legend className="field-label">Scopes</legend>
          {scopes.map((s) => (
            <label key={s} className="apps-confirm mono">
              <input
                type="checkbox"
                checked={picked.has(s)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(s);
                  else next.delete(s);
                  setPicked(next);
                }}
              />
              {s}
            </label>
          ))}
        </fieldset>
        {error && (
          <p className="leave-error" role="alert">
            {error}
          </p>
        )}
        <div className="leave-actions">
          <button type="button" className="key key-quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="key" disabled={busy || picked.size === 0 || !name.trim() || !slug}>
            {busy ? 'Creating…' : 'Create app'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
