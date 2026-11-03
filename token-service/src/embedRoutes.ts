import type { FastifyInstance } from 'fastify';
import { requireApp } from './auth';
import { getRegistry } from './apps';
import { guestState } from './reservations';
import { inspectJoinToken } from './livekit';
import { getSettings } from './settings';

/** Embedding support (needs tokens:mint): turns a join token handed to /embed into a verified session. */
export async function embedRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireApp('tokens:mint'));

  app.post<{ Body: { token?: unknown } }>('/session', async (req, reply) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || !token) return reply.code(400).send({ error: 'token is required.' });
    const session = await inspectJoinToken(token);
    if (!session) return reply.code(401).send({ error: 'This call link is invalid or has expired.' });
    // A token minted for a reserved room stops working when the reservation ends or expires.
    const reserved = getRegistry().reservations.getByRoom(session.room);
    if (reserved && !reserved.implicit) {
      const state = guestState(reserved, Date.now());
      if (state === 'ended' || state === 'expired') return reply.code(410).send({ error: 'This meeting link is no longer active. Ask the person who invited you for a new link.', reservation: state });
    }
    return { ...session, callSettings: getSettings().calls };
  });
}
