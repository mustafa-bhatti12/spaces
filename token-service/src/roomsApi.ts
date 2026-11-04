import fs from 'node:fs';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { auditCaller, requireApp } from './auth';
import { getRegistry } from './apps';
import { issueJoinToken, type JoinTokenRequest, type JoinTokenResult } from './joinToken';
import { closeRoomIfLive } from './livekit';
import { listRecordingFiles, resolveRecordingFile } from './recordings';
import { parseRecordingName, readTranscript, transcriptStates } from './transcripts';
import { guestState, ReservationError, type Reservation } from './reservations';

/**
 * The Rooms API for registered apps (mounted at /v1): reserved rooms with unguessable names, owned by
 * the app that created them. Another app's room answers 404 exactly like a missing one, so existence
 * never leaks. Guests join at `joinUrl`; the owner mints host (or guest) tokens on demand.
 */

export interface RoomsDeps {
  /** Closes the live LiveKit room if there is one; true when it did. */
  closeRoom(room: string): Promise<boolean>;
  issueJoinToken(req: JoinTokenRequest): Promise<JoinTokenResult>;
  /** The origin guests open (the demo), no trailing slash. */
  publicWebUrl(): string;
  now(): number;
}

export const realDeps: RoomsDeps = {
  closeRoom: closeRoomIfLive,
  issueJoinToken,
  publicWebUrl: () => (process.env.SPACES_PUBLIC_WEB_URL || 'https://spaces.hof-global.com').replace(/\/$/, ''),
  now: () => Date.now(),
};

const NOT_FOUND = { error: 'Room not found.' };
const NAME_MAX = 64;

export const joinUrl = (deps: RoomsDeps, room: string): string => `${deps.publicWebUrl()}/rooms/${room}`;

function present(deps: RoomsDeps, r: Reservation) {
  return {
    roomId: r.id,
    roomName: r.roomName,
    title: r.title,
    joinUrl: joinUrl(deps, r.roomName),
    startsAt: r.startsAt,
    expiresAt: r.expiresAt,
    waitingRoom: r.waitingRoom,
    record: r.record,
    externalRef: r.externalRef,
    createdAt: r.createdAt,
    endedAt: r.endedAt,
    state: guestState(r, deps.now()),
  };
}

/**
 * A single `bytes=a-b`, `bytes=a-` or `bytes=-n` range against a file of `size` bytes. null when the
 * header isn't a single byte range (served whole, as RFC 9110 allows); 'unsatisfiable' for a 416.
 */
export function parseRange(header: string, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

export function roomsApi(deps: RoomsDeps = realDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const store = () => getRegistry().reservations;

    app.get('/apps/me', { preHandler: requireApp(null) }, async (req) => {
      const { app: a } = req.caller!;
      return { slug: a.slug, name: a.name, scopes: a.scopes };
    });

    app.post<{ Body: Record<string, unknown> }>('/rooms', { preHandler: requireApp('rooms:create') }, async (req, reply) => {
      const caller = req.caller!;
      try {
        const r = store().create(caller.app.id, caller.app.slug, req.body ?? {}, deps.now());
        auditCaller(req, 'room.create', { room: r.roomName, externalRef: r.externalRef ?? undefined });
        reply.code(201).send({ roomId: r.id, roomName: r.roomName, joinUrl: joinUrl(deps, r.roomName), expiresAt: r.expiresAt });
      } catch (err) {
        if (err instanceof ReservationError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    });

    app.get<{ Params: { id: string } }>('/rooms/:id', { preHandler: requireApp('rooms:read') }, async (req, reply) => {
      const r = store().getOwned(req.params.id, req.caller!.app.id);
      if (!r) return reply.code(404).send(NOT_FOUND);
      return present(deps, r);
    });

    // A room's finished recordings with their transcripts, oldest first. Transcript text and segments
    // only once the status is `ready`.
    app.get<{ Params: { id: string } }>('/rooms/:id/recordings', { preHandler: requireApp('recordings:read') }, async (req, reply) => {
      const r = store().getOwned(req.params.id, req.caller!.app.id);
      if (!r) return reply.code(404).send(NOT_FOUND);
      try {
        const files = (await listRecordingFiles())
          .filter((f) => f.kind === 'compressed' && parseRecordingName(f.name)?.room === r.roomName)
          .sort((a, b) => (parseRecordingName(a.name)!.recordedAt < parseRecordingName(b.name)!.recordedAt ? -1 : 1));
        const states = await transcriptStates(files.map((f) => f.name));
        const recordings = await Promise.all(
          files.map(async (f) => {
            const status = states.get(f.name)!.status;
            const t = status === 'ready' ? await readTranscript(f.name) : null;
            return {
              file: f.name,
              recordedAt: parseRecordingName(f.name)?.recordedAt ?? null,
              durationMs: t?.durationMs ?? null,
              bytes: f.bytes,
              transcript: t
                ? { status, languages: t.languages, text: t.text, segments: t.segments }
                : { status: status === 'ready' ? 'none' : status },
            };
          }),
        );
        auditCaller(req, 'recording.read', { room: r.roomName, externalRef: r.externalRef ?? undefined });
        return { recordings };
      } catch (err) {
        console.error('Failed to list room recordings:', err);
        return reply.code(500).send({ error: 'Could not list recordings.' });
      }
    });

    // One recording's audio (Opus in Ogg). Single byte ranges are honoured so players can seek.
    app.get<{ Params: { id: string; file: string } }>(
      '/rooms/:id/recordings/:file',
      { preHandler: requireApp('recordings:read') },
      async (req, reply) => {
        const r = store().getOwned(req.params.id, req.caller!.app.id);
        if (!r || parseRecordingName(req.params.file)?.room !== r.roomName) return reply.code(404).send(NOT_FOUND);
        const path = resolveRecordingFile('compressed', req.params.file);
        let size: number;
        try {
          if (!path) throw new Error('unsafe name');
          size = (await fs.promises.stat(path)).size;
        } catch {
          return reply.code(404).send({ error: 'Recording not found.' });
        }
        reply.type('audio/ogg').header('Accept-Ranges', 'bytes');
        const header = req.headers.range;
        const range = header === undefined ? null : parseRange(header, size);
        if (range === 'unsatisfiable') {
          return reply.code(416).type('application/json').header('Content-Range', `bytes */${size}`).send({ error: 'Range not satisfiable.' });
        }
        // Audit the start of a playback, not every seek or chunk after it.
        if (!range || range.start === 0) auditCaller(req, 'recording.audio', { room: r.roomName, externalRef: r.externalRef ?? undefined, detail: req.params.file });
        if (!range) return reply.header('Content-Length', size).send(fs.createReadStream(path!));
        return reply
          .code(206)
          .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
          .header('Content-Length', range.end - range.start + 1)
          .send(fs.createReadStream(path!, { start: range.start, end: range.end }));
      },
    );

    // Ends the reservation first (nobody new joins), then closes the live room. If LiveKit can't be
    // reached the answer is 502 and a retry finishes the job.
    app.post<{ Params: { id: string } }>('/rooms/:id/end', { preHandler: requireApp('rooms:end') }, async (req, reply) => {
      const r = store().getOwned(req.params.id, req.caller!.app.id);
      if (!r) return reply.code(404).send(NOT_FOUND);
      store().end(r.id, deps.now());
      try {
        const liveRoomClosed = await deps.closeRoom(r.roomName);
        auditCaller(req, 'room.end', { room: r.roomName });
        return { roomId: r.id, ended: true, endedAt: store().get(r.id)!.endedAt, liveRoomClosed };
      } catch (err) {
        console.error(`Failed to close LiveKit room ${r.roomName}:`, err);
        auditCaller(req, 'room.end', { room: r.roomName, result: 'error', detail: 'reservation ended; live room not closed' });
        return reply.code(502).send({ error: 'The room is ended, but the live call could not be closed. Try again.', ended: true });
      }
    });

    app.post<{ Params: { id: string }; Body: { identity?: unknown; name?: unknown; host?: unknown } }>(
      '/rooms/:id/join-tokens',
      { preHandler: requireApp('tokens:mint') },
      async (req, reply) => {
        const r = store().getOwned(req.params.id, req.caller!.app.id);
        if (!r) return reply.code(404).send(NOT_FOUND);
        const { identity, name, host } = req.body ?? {};
        const text = (v: unknown) => (typeof v === 'string' && v.trim() && v.length <= NAME_MAX ? v.trim() : null);
        if (!text(identity) || !text(name) || (host !== undefined && typeof host !== 'boolean')) {
          return reply.code(400).send({ error: `identity and name are required strings (up to ${NAME_MAX} characters); host is a boolean.` });
        }
        const state = guestState(r, deps.now());
        if (state === 'ended' || state === 'expired') {
          return reply.code(410).send({ error: state === 'ended' ? 'This room has ended.' : 'This room has expired.', state });
        }
        try {
          const result = await deps.issueJoinToken({
            room: r.roomName,
            identity: text(identity)!,
            name: text(name)!,
            host: host === true,
            reserved: { record: r.record, waitingRoom: r.waitingRoom },
          });
          if (!result.ok) return reply.code(result.status).send(result.body);
          const token = result.details.participantToken;
          if (host === true) auditCaller(req, 'host_token.mint', { room: r.roomName, externalRef: r.externalRef ?? undefined });
          return { token, url: `${joinUrl(deps, r.roomName)}#t=${token}` };
        } catch (err) {
          console.error('Failed to mint a join token:', err);
          return reply.code(500).send({ error: 'Could not mint a token.' });
        }
      },
    );
  };
}

/**
 * What the demo asks (shared secret, tokens:mint) before letting a guest into a room: is it reserved,
 * and is its window open. Reservations /token recorded implicitly don't count: those rooms keep
 * working as they always did. Carries no title or owner.
 */
export const reservationLookupRoutes = (deps: RoomsDeps = realDeps): FastifyPluginAsync => async (app) => {
  app.get<{ Querystring: { room?: string } }>('/room/reservation', { preHandler: requireApp('tokens:mint') }, async (req, reply) => {
    const room = String(req.query.room ?? '');
    if (!room) return reply.code(400).send({ error: 'room is required.' });
    const r = getRegistry().reservations.getByRoom(room);
    if (!r || r.implicit) return { reserved: false };
    return { reserved: true, state: guestState(r, deps.now()), startsAt: r.startsAt, expiresAt: r.expiresAt };
  });
};
