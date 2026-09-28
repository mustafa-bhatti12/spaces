import { randomUUID } from 'node:crypto';

/**
 * Waiting-room requests ("asks to join"), in memory. A request lives only while its asker keeps
 * polling for the answer, so a closed tab drops out on its own; a token-service restart forgets
 * everything, and a waiting client simply asks again. Which rooms have a waiting room is room state
 * (livekit.ts RoomSettings); this only tracks who is asking and who the host let in.
 */

/** Like Google Meet: a request nobody answers ends after this long. */
export const ASK_TIMEOUT_MS = 10 * 60_000;
/** An asker that stopped polling (tab closed, network gone) is dropped after this long. */
export const ASK_STALE_MS = 20_000;
/** How long an answered request stays readable, so the asker's next poll sees the answer. */
const ANSWERED_KEEP_MS = 60_000;

export type AskStatus = 'waiting' | 'admitted' | 'denied' | 'timeout';

export interface JoinRequest {
  id: string;
  room: string;
  identity: string;
  name: string;
  status: AskStatus;
  askedAt: number;
  lastSeen: number;
  answeredAt?: number;
}

export interface PendingRequest {
  id: string;
  identity: string;
  name: string;
  askedAt: string; // ISO timestamp
}

export class Lobby {
  private requests = new Map<string, JoinRequest>();
  /** Per room: identities the host let in. They rejoin (refresh, reconnect) without asking again. */
  private admitted = new Map<string, Set<string>>();

  constructor(private now: () => number = Date.now) {}

  /** Starts (or, for the same person asking again, refreshes) a request to join `room`. */
  ask(room: string, identity: string, name: string): JoinRequest {
    this.sweep();
    const now = this.now();
    for (const r of this.requests.values()) {
      if (r.room === room && r.identity === identity && r.status === 'waiting') {
        r.name = name;
        r.lastSeen = now;
        return r;
      }
    }
    const request: JoinRequest = { id: randomUUID(), room, identity, name, status: 'waiting', askedAt: now, lastSeen: now };
    this.requests.set(request.id, request);
    return request;
  }

  /** The asker's poll: the current answer, or null when the request is unknown (ask again). */
  poll(id: string): JoinRequest | null {
    this.sweep();
    const request = this.requests.get(id);
    if (!request) return null;
    request.lastSeen = this.now();
    return request;
  }

  /** Requests still waiting in `room`, oldest first. */
  pending(room: string): PendingRequest[] {
    this.sweep();
    return [...this.requests.values()]
      .filter((r) => r.room === room && r.status === 'waiting')
      .sort((a, b) => a.askedAt - b.askedAt)
      .map((r) => ({ id: r.id, identity: r.identity, name: r.name, askedAt: new Date(r.askedAt).toISOString() }));
  }

  /** Answers waiting requests in `room`: the given ids, or all of them. Returns how many changed. */
  answer(room: string, ids: string[] | 'all', admit: boolean): number {
    this.sweep();
    const now = this.now();
    let changed = 0;
    for (const r of this.requests.values()) {
      if (r.room !== room || r.status !== 'waiting' || (ids !== 'all' && !ids.includes(r.id))) continue;
      r.status = admit ? 'admitted' : 'denied';
      r.answeredAt = now;
      if (admit) this.admit(room, r.identity);
      changed++;
    }
    return changed;
  }

  admit(room: string, identity: string): void {
    let set = this.admitted.get(room);
    if (!set) this.admitted.set(room, (set = new Set()));
    set.add(identity);
  }

  isAdmitted(room: string, identity: string): boolean {
    return this.admitted.get(room)?.has(identity) ?? false;
  }

  /** Removed from the call: with the waiting room on, they have to ask again. */
  revoke(room: string, identity: string): void {
    this.admitted.get(room)?.delete(identity);
  }

  /** The room is gone: forget its requests and who was let in. */
  forgetRoom(room: string): void {
    this.admitted.delete(room);
    for (const [id, r] of this.requests) if (r.room === room) this.requests.delete(id);
  }

  /** Drops abandoned and long-answered requests, and times out unanswered ones. Returns rooms whose pending list changed. */
  sweep(): Set<string> {
    const now = this.now();
    const changed = new Set<string>();
    for (const [id, r] of this.requests) {
      if (r.status === 'waiting') {
        if (now - r.lastSeen > ASK_STALE_MS) {
          this.requests.delete(id);
          changed.add(r.room);
        } else if (now - r.askedAt > ASK_TIMEOUT_MS) {
          r.status = 'timeout';
          r.answeredAt = now;
          changed.add(r.room);
        }
      } else if (now - (r.answeredAt ?? now) > ANSWERED_KEEP_MS) {
        this.requests.delete(id);
      }
    }
    return changed;
  }
}

export const lobby = new Lobby();
