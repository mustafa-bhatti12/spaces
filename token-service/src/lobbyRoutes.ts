import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireSharedSecret } from './auth';
import { hostIdentity, mintToken, notifyRoom, setWaitingRoom } from './livekit';
import { lobby } from './lobby';

/** Data-message topic telling a room's clients the waiting list changed (the host refetches it). */
export const LOBBY_TOPIC = 'space.lobby';

function tellRoom(room: string): void {
  notifyRoom(room, LOBBY_TOPIC).catch((err) => console.error(`Could not notify ${room} of a lobby change:`, err));
}

/**
 * Waiting-room API (consumer secret). An asker gets a request id from /lobby/ask and polls
 * /lobby/status; once the host admits them, the status response carries their join token. Host
 * actions carry the host's own join token as proof, the same way /room/end does.
 */
export async function lobbyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSharedSecret);

  // Abandoned askers drop out and unanswered ones time out between polls, so hosts hear about it.
  const sweeper = setInterval(() => lobby.sweep().forEach(tellRoom), 5000);
  sweeper.unref();
  app.addHook('onClose', async () => clearInterval(sweeper));

  /** The room when `token` belongs to one of its hosts; otherwise replies 400/403 and returns null. */
  const hostRoom = async (room: unknown, token: unknown, reply: FastifyReply): Promise<string | null> => {
    if (typeof room !== 'string' || !room || typeof token !== 'string' || !token) {
      reply.code(400).send({ error: 'room and token are required.' });
      return null;
    }
    if (!(await hostIdentity(room, token))) {
      reply.code(403).send({ error: 'Only the host can do this.' });
      return null;
    }
    return room;
  };

  app.post<{ Body: { room?: string; identity?: string; name?: string } }>('/ask', async (req, reply) => {
    const { room, identity, name } = req.body ?? {};
    if (typeof room !== 'string' || !room || typeof identity !== 'string' || !identity || typeof name !== 'string' || !name) {
      return reply.code(400).send({ error: 'room, identity and name are required strings.' });
    }
    if (lobby.isRemoved(room, identity)) return reply.code(403).send({ error: 'A host removed you from this call.', removed: true });
    const request = lobby.ask(room, identity, name);
    tellRoom(room);
    return { requestId: request.id };
  });

  // unknown: this service no longer has the request (restart, or it went stale); ask again.
  app.get<{ Querystring: { id?: string } }>('/status', async (req, reply) => {
    const id = String(req.query.id ?? '');
    if (!id) return reply.code(400).send({ error: 'id is required.' });
    const request = lobby.poll(id);
    if (!request) return { status: 'unknown' };
    if (request.status !== 'admitted') return { status: request.status };
    const details = await mintToken({ room: request.room, identity: request.identity, name: request.name });
    return { status: 'admitted', ...details };
  });

  app.post<{ Body: { room?: string; token?: string } }>('/pending', async (req, reply) => {
    const room = await hostRoom(req.body?.room, req.body?.token, reply);
    if (!room) return reply;
    return lobby.pending(room);
  });

  app.post<{ Body: { room?: string; token?: string; ids?: string[] | 'all'; admit?: boolean } }>('/answer', async (req, reply) => {
    const { ids, admit } = req.body ?? {};
    const validIds = ids === 'all' || (Array.isArray(ids) && ids.every((id) => typeof id === 'string'));
    if (!validIds || typeof admit !== 'boolean') {
      return reply.code(400).send({ error: "ids (array or 'all') and admit (boolean) are required." });
    }
    const room = await hostRoom(req.body?.room, req.body?.token, reply);
    if (!room) return reply;
    const answered = lobby.answer(room, ids, admit);
    if (answered) tellRoom(room);
    return { answered };
  });

  // Turning the waiting room off lets everyone who is waiting in, like Zoom and Meet.
  app.post<{ Body: { room?: string; token?: string; waitingRoom?: boolean } }>('/settings', async (req, reply) => {
    const { waitingRoom } = req.body ?? {};
    if (typeof waitingRoom !== 'boolean') return reply.code(400).send({ error: 'waitingRoom (boolean) is required.' });
    const room = await hostRoom(req.body?.room, req.body?.token, reply);
    if (!room) return reply;
    await setWaitingRoom(room, waitingRoom);
    if (!waitingRoom && lobby.answer(room, 'all', true)) tellRoom(room);
    return { waitingRoom };
  });
}
