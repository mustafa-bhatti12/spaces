import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RESERVATION_SCHEMA, ReservationStore } from './reservations';

/**
 * App registry: which registered apps may call token-service, what they may do, and an append-only
 * audit log. SQLite through Node's built-in `node:sqlite` (no dependency), one file on the droplet
 * (SPACES_DB_FILE, default token-service/data/spaces.db, gitignored). Keys are stored only as
 * sha256 hashes; the secret is shown once when issued.
 */

export const SCOPES = ['rooms:create', 'rooms:end', 'rooms:read', 'tokens:mint', 'recordings:read', 'events:read'] as const;
export type Scope = (typeof SCOPES)[number];

export const MAX_ACTIVE_KEYS = 2;
/** The app the legacy TOKEN_SERVICE_SHARED_SECRET resolves to. */
export const LEGACY_APP = 'petition-studio';

/** Requests per minute. `*` covers every scope without its own entry. */
export type RateLimits = Record<string, number>;
export const DEFAULT_RATE_LIMITS: RateLimits = { 'rooms:create': 30, '*': 300 };

interface SeedApp {
  slug: string;
  name: string;
  scopes: Scope[];
  rateLimits: RateLimits;
}

// The shared-secret app also carries the demo's call traffic (lobby polling, host actions), so its
// limits are far above the per-app defaults.
const SEED_APPS: SeedApp[] = [
  { slug: 'erp', name: 'HOF ERP', scopes: ['rooms:create', 'rooms:end', 'rooms:read', 'tokens:mint'], rateLimits: DEFAULT_RATE_LIMITS },
  { slug: LEGACY_APP, name: 'Petition Studio', scopes: ['rooms:create', 'tokens:mint', 'recordings:read'], rateLimits: { 'rooms:create': 600, '*': 6000 } },
  { slug: 'spaces-web', name: 'Spaces web (demo)', scopes: ['tokens:mint'], rateLimits: DEFAULT_RATE_LIMITS },
];

export class RegistryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- keys: hsk_<keyId>_<secret> -----------------------------------------------------------------

const KEY_PATTERN = /^hsk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

/** The key id and secret of a well-formed `hsk_<keyId>_<secret>` key, else null. */
export function parseKey(key: string): { keyId: string; secret: string } | null {
  const m = KEY_PATTERN.exec(key);
  return m ? { keyId: m[1], secret: m[2] } : null;
}

export const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex');

export function verifySecret(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function generateKey(): { keyId: string; key: string; hash: string } {
  const keyId = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { keyId, key: `hsk_${keyId}_${secret}`, hash: hashSecret(secret) };
}

const SLUG = /^[a-z][a-z0-9-]{1,30}$/;
const isScope = (s: unknown): s is Scope => (SCOPES as readonly unknown[]).includes(s);

// --- registry -----------------------------------------------------------------------------------

export interface AppRecord {
  id: number;
  slug: string;
  name: string;
  scopes: Scope[];
  status: 'active' | 'disabled';
  rateLimits: RateLimits;
  createdAt: string;
  lastUsedAt: string | null;
}
export interface KeyRecord {
  keyId: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface AuditInput {
  actor: 'admin' | 'app';
  appSlug?: string | null;
  keyId?: string | null;
  action: string;
  room?: string | null;
  externalRef?: string | null;
  ip?: string | null;
  result: 'ok' | 'denied' | 'error';
  detail?: string | null;
}
export interface AuditEvent extends Required<AuditInput> {
  id: number;
  at: string;
  appId: number | null;
}

interface AppRow {
  id: number;
  slug: string;
  name: string;
  scopes: string;
  status: 'active' | 'disabled';
  rate_limits: string;
  created_at: string;
  last_used_at: string | null;
}
const toApp = (r: AppRow): AppRecord => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  scopes: JSON.parse(r.scopes) as Scope[],
  status: r.status,
  rateLimits: JSON.parse(r.rate_limits) as RateLimits,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

/** Last-used timestamps are written at most this often per key/app, so reads stay cheap. */
const TOUCH_EVERY_MS = 30_000;

export class AppRegistry {
  private readonly db: DatabaseSync;
  private readonly touched = new Map<string, number>();
  readonly reservations: ReservationStore;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    this.seed();
    this.reservations = new ReservationStore(this.db);
  }

  // Forward-only: each entry runs once, in order; `user_version` is how many have run.
  private migrate(): void {
    const steps = [
      `CREATE TABLE app (
         id INTEGER PRIMARY KEY,
         slug TEXT NOT NULL UNIQUE,
         name TEXT NOT NULL,
         scopes TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
         rate_limits TEXT NOT NULL,
         created_at TEXT NOT NULL,
         last_used_at TEXT
       );
       CREATE TABLE app_key (
         key_id TEXT PRIMARY KEY,
         app_id INTEGER NOT NULL REFERENCES app(id),
         hash TEXT NOT NULL,
         created_at TEXT NOT NULL,
         last_used_at TEXT,
         revoked_at TEXT
       );
       CREATE INDEX app_key_app ON app_key(app_id);
       CREATE TABLE audit_event (
         id INTEGER PRIMARY KEY,
         at TEXT NOT NULL,
         actor TEXT NOT NULL,
         app_id INTEGER,
         app_slug TEXT,
         key_id TEXT,
         action TEXT NOT NULL,
         room TEXT,
         external_ref TEXT,
         ip TEXT,
         result TEXT NOT NULL,
         detail TEXT
       );
       CREATE INDEX audit_event_at ON audit_event(id DESC);`,
      RESERVATION_SCHEMA,
    ];
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let i = version; i < steps.length; i++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(steps[i]);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /** First start: register the known apps if absent. No keys are issued; /admin does that. */
  private seed(): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO app (slug, name, scopes, rate_limits, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const now = new Date().toISOString();
    for (const a of SEED_APPS) insert.run(a.slug, a.name, JSON.stringify(a.scopes), JSON.stringify(a.rateLimits), now);
  }

  close(): void {
    this.db.close();
  }

  // --- apps ---

  getApp(slug: string): AppRecord | null {
    const row = this.db.prepare('SELECT * FROM app WHERE slug = ?').get(slug) as AppRow | undefined;
    return row ? toApp(row) : null;
  }

  listApps(): (AppRecord & { activeKeys: number; keys: KeyRecord[]; lastUsedAt: string | null })[] {
    return (this.db.prepare('SELECT * FROM app ORDER BY id').all() as unknown as AppRow[]).map((row) => {
      const app = toApp(row);
      const keys = this.listKeys(app.id);
      const lastUsed = [app.lastUsedAt, ...keys.map((k) => k.lastUsedAt)].filter((t): t is string => !!t).sort().pop() ?? null;
      return { ...app, lastUsedAt: lastUsed, keys, activeKeys: keys.filter((k) => !k.revokedAt).length };
    });
  }

  createApp(input: { slug: unknown; name: unknown; scopes: unknown }): AppRecord {
    const { slug, name, scopes } = input;
    if (typeof slug !== 'string' || !SLUG.test(slug)) {
      throw new RegistryError(400, 'slug must be 2-31 characters: lowercase letters, digits and dashes, starting with a letter.');
    }
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new RegistryError(400, 'name is required (up to 80 characters).');
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(isScope)) {
      throw new RegistryError(400, `scopes must be a non-empty list of: ${SCOPES.join(', ')}.`);
    }
    if (this.getApp(slug)) throw new RegistryError(409, `App "${slug}" already exists.`);
    this.db
      .prepare('INSERT INTO app (slug, name, scopes, rate_limits, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(slug, name.trim(), JSON.stringify([...new Set(scopes)]), JSON.stringify(DEFAULT_RATE_LIMITS), new Date().toISOString());
    return this.getApp(slug)!;
  }

  // --- keys ---

  private listKeys(appId: number): KeyRecord[] {
    return (
      this.db.prepare('SELECT key_id, created_at, last_used_at, revoked_at FROM app_key WHERE app_id = ? ORDER BY created_at DESC, rowid DESC').all(appId) as unknown as {
        key_id: string;
        created_at: string;
        last_used_at: string | null;
        revoked_at: string | null;
      }[]
    ).map((k) => ({ keyId: k.key_id, createdAt: k.created_at, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at }));
  }

  /** Issues a key for an app: the returned `key` is the only time the secret exists in clear. */
  issueKey(slug: string): { keyId: string; key: string; app: AppRecord } {
    const app = this.getApp(slug);
    if (!app) throw new RegistryError(404, 'Unknown app.');
    const active = this.listKeys(app.id).filter((k) => !k.revokedAt).length;
    if (active >= MAX_ACTIVE_KEYS) {
      throw new RegistryError(409, `${app.name} already has ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`);
    }
    const { keyId, key, hash } = generateKey();
    this.db.prepare('INSERT INTO app_key (key_id, app_id, hash, created_at) VALUES (?, ?, ?, ?)').run(keyId, app.id, hash, new Date().toISOString());
    return { keyId, key, app };
  }

  revokeKey(slug: string, keyId: string): AppRecord {
    const app = this.getApp(slug);
    if (!app) throw new RegistryError(404, 'Unknown app.');
    const res = this.db
      .prepare('UPDATE app_key SET revoked_at = ? WHERE key_id = ? AND app_id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), keyId, app.id);
    if (res.changes === 0) throw new RegistryError(404, 'No active key with that id for this app.');
    return app;
  }

  /**
   * The app a presented `hsk_` key belongs to. 'invalid' covers malformed, unknown, wrong-secret and
   * revoked keys alike (one answer, so a caller learns nothing about which part was wrong).
   */
  authenticateKey(presented: string, now = Date.now()): { app: AppRecord; keyId: string } | 'invalid' {
    const parsed = parseKey(presented);
    if (!parsed) return 'invalid';
    const row = this.db
      .prepare('SELECT key_id, app_id, hash, revoked_at FROM app_key WHERE key_id = ?')
      .get(parsed.keyId) as { key_id: string; app_id: number; hash: string; revoked_at: string | null } | undefined;
    // Compare against a dummy hash for unknown ids so the work is the same either way.
    const ok = verifySecret(parsed.secret, row?.hash ?? '0'.repeat(64));
    if (!row || !ok || row.revoked_at) return 'invalid';
    const app = toApp(this.db.prepare('SELECT * FROM app WHERE id = ?').get(row.app_id) as unknown as AppRow);
    this.touch('app_key', 'key_id', row.key_id, now);
    return { app, keyId: row.key_id };
  }

  /** Records that the app was used (the legacy shared secret has no key row to mark). */
  touchApp(app: AppRecord, now = Date.now()): void {
    this.touch('app', 'slug', app.slug, now);
  }

  private touch(table: 'app' | 'app_key', column: 'slug' | 'key_id', id: string, now: number): void {
    const k = `${table}:${id}`;
    if (now - (this.touched.get(k) ?? 0) < TOUCH_EVERY_MS) return;
    this.touched.set(k, now);
    this.db.prepare(`UPDATE ${table} SET last_used_at = ? WHERE ${column} = ?`).run(new Date(now).toISOString(), id);
  }

  // --- audit ---

  /** Append one event. Never throws: an audit failure must not take a call down with it. */
  audit(e: AuditInput): void {
    try {
      const app = e.appSlug ? this.getApp(e.appSlug) : null;
      this.db
        .prepare(
          'INSERT INTO audit_event (at, actor, app_id, app_slug, key_id, action, room, external_ref, ip, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(new Date().toISOString(), e.actor, app?.id ?? null, e.appSlug ?? null, e.keyId ?? null, e.action, e.room ?? null, e.externalRef ?? null, e.ip ?? null, e.result, e.detail ?? null);
    } catch (err) {
      console.error('Could not write an audit event:', err);
    }
  }

  /** Newest first. `before` is an event id, for paging. */
  listAudit(limit = 100, before?: number): AuditEvent[] {
    const n = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
    const rows = (
      before
        ? this.db.prepare('SELECT * FROM audit_event WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, n)
        : this.db.prepare('SELECT * FROM audit_event ORDER BY id DESC LIMIT ?').all(n)
    ) as unknown as Record<string, string | number | null>[];
    return rows.map((r) => ({
      id: r.id as number,
      at: r.at as string,
      actor: r.actor as AuditEvent['actor'],
      appId: r.app_id as number | null,
      appSlug: r.app_slug as string | null,
      keyId: r.key_id as string | null,
      action: r.action as string,
      room: r.room as string | null,
      externalRef: r.external_ref as string | null,
      ip: r.ip as string | null,
      result: r.result as AuditEvent['result'],
      detail: r.detail as string | null,
    }));
  }

  /** Consistent copy of the database (VACUUM INTO), keeping the newest `keep` daily files. */
  backup(dir: string, keep = 14, now = new Date()): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `spaces-${now.toISOString().slice(0, 10)}.db`);
    fs.rmSync(file, { force: true });
    this.db.prepare('VACUUM INTO ?').run(file);
    const old = fs.readdirSync(dir).filter((f) => /^spaces-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -keep);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    return file;
  }
}

let registry: AppRegistry | null = null;

export const dbFile = (): string => process.env.SPACES_DB_FILE ?? path.join(__dirname, '..', 'data', 'spaces.db');
export const backupDir = (): string => path.join(path.dirname(dbFile()), 'backups');

/** The process-wide registry, opened (and migrated, seeded) on first use. */
export function getRegistry(): AppRegistry {
  return (registry ??= new AppRegistry(dbFile()));
}
