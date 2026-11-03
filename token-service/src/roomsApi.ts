import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { auditCaller, requireApp } from './auth';
import { getRegistry } from './apps';
import { issueJoinToken, type JoinTokenRequest, type JoinTokenResult } from './joinToken';
import { closeRoomIfLive } from './livekit';
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
