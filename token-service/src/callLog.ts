import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireSharedSecret } from './auth';
import { tokenIdentity } from './livekit';

/**
 * What browsers report about their own side of a call (reconnects, disconnect reasons, blocked audio,
 * the tab being hidden or frozen, going offline), so a "the call kept dropping" report can be told
 * apart from the server's side in livekit.log. One JSON line per event in `logs/calls-<UTC day>.jsonl`,
 * kept for KEEP_DAYS.
 */
export const CALL_LOG_DIR = process.env.CALL_LOG_DIR ?? path.join(__dirname, '..', 'logs');
/** A day's call log file name; anything else in CALL_LOG_DIR is not ours. */
export const CALL_LOG_NAME = /^calls-\d{4}-\d{2}-\d{2}\.jsonl$/;
const DIR = CALL_LOG_DIR;
const KEEP_DAYS = 30;
const MAX_EVENTS = 100;
const MAX_NAME = 40;
const MAX_DETAIL = 500;

interface CallEvent {
  /** Browser clock, ms since epoch. */
  t: number;
  e: string;
  d?: unknown;
}

/** The well-formed events in `raw` (at most MAX_EVENTS); anything malformed or oversized is dropped. */
export function parseCallEvents(raw: unknown): CallEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: CallEvent[] = [];
  for (const item of raw.slice(0, MAX_EVENTS)) {
    if (!item || typeof item !== 'object') continue;
    const { t, e, d } = item as Record<string, unknown>;
    if (typeof t !== 'number' || !Number.isFinite(t) || typeof e !== 'string' || !e || e.length > MAX_NAME) continue;
    if (d !== undefined && JSON.stringify(d).length > MAX_DETAIL) continue;
    events.push(d === undefined ? { t, e } : { t, e, d });
  }
  return events;
}

const fileFor = (at: Date) => path.join(DIR, `calls-${at.toISOString().slice(0, 10)}.jsonl`);

function prune(): void {
  const cutoff = fileFor(new Date(Date.now() - KEEP_DAYS * 86_400_000));
  let names: string[];
  try {
    names = fs.readdirSync(DIR);
  } catch {
    return;
  }
  // Names sort by date, so anything before the cutoff day's name is older.
  for (const name of names) {
    if (CALL_LOG_NAME.test(name) && path.join(DIR, name) < cutoff) fs.rmSync(path.join(DIR, name), { force: true });
  }
}

export async function callLogRoutes(app: FastifyInstance): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true });
  prune();
  setInterval(prune, 86_400_000).unref();

  app.addHook('preHandler', requireSharedSecret);

  // The caller's own join token is the proof of who's reporting; room and identity come from it.
  app.post<{ Body: { room?: unknown; token?: unknown; events?: unknown } }>('/', async (req, reply) => {
    const { room, token } = req.body ?? {};
    if (typeof room !== 'string' || !room || typeof token !== 'string' || !token) {
      return reply.code(400).send({ error: 'room and token are required.' });
    }
    const identity = await tokenIdentity(room, token);
    if (!identity) return reply.code(401).send({ error: 'Invalid token.' });
    const events = parseCallEvents(req.body.events);
    if (events.length > 0) {
      const at = new Date();
      const lines = events.map((ev) => JSON.stringify({ at: at.toISOString(), room, identity, ...ev })).join('\n');
      await fs.promises.appendFile(fileFor(at), `${lines}\n`);
    }
    return { logged: events.length };
  });
}
