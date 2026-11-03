import type { FastifyInstance } from 'fastify';
import { getRegistry } from './apps';
import { gateRoomRevival, guestState, } from './reservations';
import { auditCaller, mayCreateRooms, requireApp } from './auth';
import { ensureRoom, inspectJoinToken } from './livekit';
import { getSettings } from './settings';

/** Embedding support (needs tokens:mint): turns a join token handed to /embed into a verified session. */
export async function embedRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireApp('tokens:mint'));

  app.post<{ Body: { token?: unknown } }>('/session', async (req, reply) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || !token) return reply.code(400).send({ error: 'token is required.' });
    const inspected = await inspectJoinToken(token);
    if (!inspected) return reply.code(401).send({ error: 'This call link is invalid or has expired.' });
    // A token minted for a reserved room stops working when the reservation ends or expires.
    const reserved = getRegistry().reservations.getByRoom(inspected.room);
    if (reserved && !reserved.implicit) {
      const state = guestState(reserved, Date.now());
      if (state === 'ended' || state === 'expired') return reply.code(410).send({ error: 'This meeting link is no longer active. Ask the person who invited you for a new link.', reservation: state });
    }
    // The browser connects right after this, and a room that emptied since the token was minted
    // (LiveKit no longer recreates it on join) must exist again: bring it back before answering. Anyone but
    // Petition Studio only gets that for a room with an active reservation.
    const caller = req.caller!;
    if (!mayCreateRooms(caller)) {
      const gate = gateRoomRevival(reserved, Date.now());
      if (!gate.ok) {
        auditCaller(req, 'room.refused', { room: inspected.room, result: 'denied', detail: gate.code ?? gate.error });
        return reply.code(gate.status).send({ error: gate.error, code: gate.code, ...(gate.reservation && { reservation: gate.reservation }) });
      }
    }
    const { seed, ...session } = inspected;
    await ensureRoom(session.room, { hosts: seed.hosts, record: seed.record || reserved?.record, waitingRoom: seed.waitingRoom || reserved?.waitingRoom });
    return { ...session, callSettings: getSettings().calls };
  });
}
