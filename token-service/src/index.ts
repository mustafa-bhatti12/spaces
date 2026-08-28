import 'dotenv/config';
import Fastify from 'fastify';
import { mintToken, listActiveRooms, getParticipantSid } from './livekit';
import { requireSharedSecret } from './auth';

const fastify = Fastify();

fastify.get('/health', async () => ({ ok: true }));

fastify.get('/rooms', { preHandler: requireSharedSecret }, async (_req, reply) => {
  try {
    reply.send(await listActiveRooms());
  } catch (err) {
    console.error('Failed to list LiveKit rooms:', err);
    reply.code(500).send({ error: 'Could not list rooms.' });
  }
});

fastify.get<{ Querystring: { room?: string; identity?: string } }>(
  '/participant',
  { preHandler: requireSharedSecret },
  async (req, reply) => {
    const room = String(req.query.room ?? '');
    const identity = String(req.query.identity ?? '');
    if (!room || !identity) {
      reply.code(400).send({ error: 'room and identity query params are required.' });
      return;
    }
    try {
      reply.send({ sid: await getParticipantSid(room, identity) });
    } catch (err) {
      console.error('Failed to look up LiveKit participant:', err);
      reply.code(500).send({ error: 'Could not look up participant.' });
    }
  },
);

fastify.post<{ Body: { room?: string; identity?: string; name?: string } }>(
  '/token',
  { preHandler: requireSharedSecret },
  async (req, reply) => {
    const { room, identity, name } = req.body ?? {};
    if (
      typeof room !== 'string' ||
      !room ||
      typeof identity !== 'string' ||
      !identity ||
      typeof name !== 'string' ||
      !name
    ) {
      reply.code(400).send({ error: 'room, identity and name are required strings.' });
      return;
    }

    try {
      reply.send(await mintToken({ room, identity, name }));
    } catch (err) {
      console.error('Failed to mint LiveKit token:', err);
      reply.code(500).send({ error: 'Could not mint a token.' });
    }
  },
);

const port = Number(process.env.PORT ?? 8880);
fastify
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`token-service listening on :${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
