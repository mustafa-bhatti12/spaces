import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Reserved rooms: a room an app created through the Rooms API (or that /token recorded implicitly for
 * an app allowed to create rooms). A reservation is owned by one app, has an unguessable name and a
 * window in which guests may join. Stored in the app registry's SQLite file.
 */

export class ReservationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const HOUR_MS = 3_600_000;
/** Without an `expiresAt`, a reservation lasts this long after it starts. */
export const DEFAULT_DURATION_MS = 12 * HOUR_MS;
/** A reservation can't last longer than this from its start. */
export const MAX_DURATION_MS = 90 * 24 * HOUR_MS;
/** Guests may join from this long before `startsAt`. */
export const EARLY_JOIN_MS = 15 * 60_000;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const ROOM_SUFFIX_CHARS = 26;

/** 26 lowercase base32 characters from 128 random bits (the last character carries 3). */
export function randomSuffix(bytes: Buffer = randomBytes(16)): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export const newRoomName = (appSlug: string): string => `${appSlug}-${randomSuffix()}`;

export interface Reservation {
  id: string;
  appId: number;
  roomName: string;
  title: string;
  startsAt: string;
  expiresAt: string;
  waitingRoom: boolean;
  record: boolean;
  externalRef: string | null;
  createdAt: string;
  endedAt: string | null;
  /** Recorded by /token, not created through the Rooms API. Its window is not enforced on guests. */
  implicit: boolean;
}

/** What a guest sees: open (join now), early (before the join window), expired (past expiresAt), ended (the owner ended it). */
export type GuestState = 'open' | 'early' | 'expired' | 'ended';

export function guestState(r: Pick<Reservation, 'startsAt' | 'expiresAt' | 'endedAt'>, now: number): GuestState {
  if (r.endedAt) return 'ended';
  if (now >= Date.parse(r.expiresAt)) return 'expired';
  if (now < Date.parse(r.startsAt) - EARLY_JOIN_MS) return 'early';
  return 'open';
}

export interface CreateInput {
  title?: unknown;
  startsAt?: unknown;
  expiresAt?: unknown;
  waitingRoom?: unknown;
  record?: unknown;
  externalRef?: unknown;
}

const TITLE_MAX = 200;
const REF_MAX = 200;

function parseTime(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ReservationError(400, `${field} must be an ISO 8601 timestamp.`);
  }
  return Date.parse(value);
}

/** Validates a create request into the stored fields. `expiresAt` defaults to start + 12 h. */
export function parseCreate(body: CreateInput, now: number): Omit<Reservation, 'id' | 'appId' | 'roomName' | 'createdAt' | 'endedAt' | 'implicit'> {
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > TITLE_MAX) {
    throw new ReservationError(400, `title is required (up to ${TITLE_MAX} characters).`);
  }
  if (typeof body.externalRef !== 'string' || !body.externalRef.trim() || body.externalRef.length > REF_MAX) {
    throw new ReservationError(400, `externalRef is required (up to ${REF_MAX} characters).`);
  }
  for (const f of ['waitingRoom', 'record'] as const) {
    if (body[f] !== undefined && typeof body[f] !== 'boolean') throw new ReservationError(400, `${f} must be a boolean.`);
  }
  const starts = parseTime(body.startsAt, 'startsAt') ?? now;
  const expires = parseTime(body.expiresAt, 'expiresAt') ?? starts + DEFAULT_DURATION_MS;
  if (expires <= starts) throw new ReservationError(400, 'expiresAt must be after startsAt.');
  if (expires <= now) throw new ReservationError(400, 'expiresAt must be in the future.');
  if (expires - starts > MAX_DURATION_MS) throw new ReservationError(400, 'A room can last at most 90 days from startsAt.');
  return {
    title: body.title.trim(),
    startsAt: new Date(starts).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    waitingRoom: body.waitingRoom === true,
    record: body.record === true,
    externalRef: body.externalRef.trim(),
  };
}

interface Row {
  id: string;
  app_id: number;
  room_name: string;
  title: string;
  starts_at: string;
  expires_at: string;
  waiting_room: number;
  record: number;
  external_ref: string | null;
  created_at: string;
  ended_at: string | null;
  implicit: number;
}

const toReservation = (r: Row): Reservation => ({
  id: r.id,
  appId: r.app_id,
  roomName: r.room_name,
  title: r.title,
  startsAt: r.starts_at,
  expiresAt: r.expires_at,
  waitingRoom: r.waiting_room === 1,
  record: r.record === 1,
  externalRef: r.external_ref,
  createdAt: r.created_at,
  endedAt: r.ended_at,
  implicit: r.implicit === 1,
});

/** Schema for the registry's migration list. */
export const RESERVATION_SCHEMA = `CREATE TABLE reservation (
  id TEXT PRIMARY KEY,
  app_id INTEGER NOT NULL REFERENCES app(id),
  room_name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  waiting_room INTEGER NOT NULL DEFAULT 0,
  record INTEGER NOT NULL DEFAULT 0,
  external_ref TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  implicit INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX reservation_app ON reservation(app_id);`;

export class ReservationStore {
  constructor(private readonly db: DatabaseSync) {}

  create(appId: number, appSlug: string, input: CreateInput, now = Date.now()): Reservation {
    const fields = parseCreate(input, now);
    const id = `rm_${randomBytes(12).toString('hex')}`;
    const roomName = newRoomName(appSlug);
    this.db
      .prepare(
        'INSERT INTO reservation (id, app_id, room_name, title, starts_at, expires_at, waiting_room, record, external_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, appId, roomName, fields.title, fields.startsAt, fields.expiresAt, fields.waitingRoom ? 1 : 0, fields.record ? 1 : 0, fields.externalRef, new Date(now).toISOString());
    return this.get(id)!;
  }

  get(id: string): Reservation | null {
    const row = this.db.prepare('SELECT * FROM reservation WHERE id = ?').get(id) as Row | undefined;
    return row ? toReservation(row) : null;
  }

  /** The reservation only if `appId` owns it: other apps get null, exactly as for a missing id. */
  getOwned(id: string, appId: number): Reservation | null {
    const r = this.get(id);
    return r && r.appId === appId ? r : null;
  }

  getByRoom(roomName: string): Reservation | null {
    const row = this.db.prepare('SELECT * FROM reservation WHERE room_name = ?').get(roomName) as Row | undefined;
    return row ? toReservation(row) : null;
  }

  /** Marks it ended (keeps the first end time if it already was). */
  end(id: string, now = Date.now()): void {
    this.db.prepare('UPDATE reservation SET ended_at = COALESCE(ended_at, ?) WHERE id = ?').run(new Date(now).toISOString(), id);
  }

  /**
   * Tracks a room /token minted for an app that may create rooms, if no reservation holds that name
   * yet. The window (now, +12 h) is bookkeeping only: it is never enforced on anyone.
   */
  recordImplicit(appId: number, roomName: string, now = Date.now()): void {
    if (this.getByRoom(roomName)) return;
    const at = new Date(now).toISOString();
    this.db
      .prepare(
        'INSERT OR IGNORE INTO reservation (id, app_id, room_name, title, starts_at, expires_at, created_at, implicit) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
      )
      .run(`rm_${randomBytes(12).toString('hex')}`, appId, roomName, roomName, at, new Date(now + DEFAULT_DURATION_MS).toISOString(), at);
  }
}

export type TokenGuard = { ok: true } | { ok: false; status: 403; error: string; reservation?: GuestState };

/**
 * May `callerAppId` mint a join token for `host` on a room? An unreserved room, or the owner's own,
 * always yes. Another app never gets a host token for a reserved room, and gets a guest token only
 * while the reservation is open (a guest link is public by design; its window is not).
 */
export function guardTokenRequest(r: Reservation | null, callerAppId: number, host: boolean, now: number): TokenGuard {
  if (!r || r.appId === callerAppId) return { ok: true };
  if (host) return { ok: false, status: 403, error: 'This room belongs to another app.' };
  if (r.implicit) return { ok: true };
  const state = guestState(r, now);
  if (state === 'open') return { ok: true };
  return { ok: false, status: 403, error: state === 'early' ? 'This meeting has not started yet.' : 'This meeting link is no longer active.', reservation: state };
}
