import type { FastifyPluginAsync } from 'fastify';
import { getRegistry } from './apps';
import { auditCaller, mayCreateRooms, requireApp } from './auth';
import { issueJoinToken, type JoinTokenRequest, type JoinTokenResult } from './joinToken';
import { gateTokenMint, guardTokenRequest } from './reservations';

export interface TokenRouteDeps {
  issueJoinToken(req: JoinTokenRequest): Promise<JoinTokenResult>;
  now(): number;
}

const realDeps: TokenRouteDeps = { issueJoinToken, now: Date.now };

/**
 * POST /token (tokens:mint): the consumer route that mints a join token and, through issueJoinToken,
 * brings the LiveKit room into existence. Only registered apps create rooms (ERP-72): Petition Studio
 * (the shared secret, which has `rooms:create`) keeps today's behaviour, including the implicit
 * reservation it leaves; every other caller (the call website, erp's key: it reserves rooms through
 * POST /v1/rooms, not here) gets a token only for a room with an active reservation, else 404
 * `room_not_reserved`.
 */
export const tokenRoute = (deps: TokenRouteDeps = realDeps): FastifyPluginAsync => async (app) => {
  app.post<{ Body: { room?: string; identity?: string; name?: string; host?: boolean; waitingRoom?: boolean; record?: boolean } }>(
    '/token',
    { preHandler: requireApp('tokens:mint') },
    async (req, reply) => {
      const { room, identity, name, host, waitingRoom, record } = req.body ?? {};
      if (typeof room !== 'string' || !room || typeof identity !== 'string' || !identity || typeof name !== 'string' || !name) {
        reply.code(400).send({ error: 'room, identity and name are required strings.' });
        return;
      }

      try {
        const caller = req.caller!;
        const canCreateRooms = mayCreateRooms(caller);
        const reservation = getRegistry().reservations.getByRoom(room);
        const guard = guardTokenRequest(reservation, caller.app.id, host === true, deps.now());
        if (!guard.ok) {
          if (host === true) auditCaller(req, 'host_token.mint', { room, result: 'denied', detail: guard.error });
          if (!canCreateRooms) auditCaller(req, 'room.refused', { room, result: 'denied', detail: guard.error });
          reply.code(guard.status).send({ error: guard.error, ...(guard.reservation && { reservation: guard.reservation }) });
          return;
        }
        if (!canCreateRooms) {
          const gate = gateTokenMint(reservation, host === true, deps.now());
          if (!gate.ok) {
            auditCaller(req, 'room.refused', { room, result: 'denied', detail: gate.code ?? gate.error });
            reply.code(gate.status).send({ error: gate.error, ...(gate.code && { code: gate.code }), ...(gate.reservation && { reservation: gate.reservation }) });
            return;
          }
        }
        const result = await deps.issueJoinToken({
          room,
          identity,
          name,
          host: host === true,
          waitingRoom: host === true && typeof waitingRoom === 'boolean' ? waitingRoom : undefined,
          record: record === true,
          // A reservation's settings apply to every token for the room, whoever joins first.
          reserved: reservation && !reservation.implicit ? { record: reservation.record, waitingRoom: reservation.waitingRoom } : undefined,
        });
        if (!result.ok) {
          reply.code(result.status).send(result.body);
          return;
        }
        if (host === true) auditCaller(req, 'host_token.mint', { room });
        // Petition Studio's rooms (`case-…`) are tracked as its own reservations, kept active while it keeps minting.
        if (canCreateRooms) getRegistry().reservations.recordImplicit(caller.app.id, room, deps.now());
        reply.send(result.details);
      } catch (err) {
        console.error('Failed to mint LiveKit token:', err);
        reply.code(500).send({ error: 'Could not mint a token.' });
      }
    },
  );
};
