import type { FastifyInstance } from 'fastify';
import { requireSharedSecret } from './auth';
import { inspectJoinToken } from './livekit';

/** Embedding support (consumer secret): turns a join token handed to /embed into a verified session. */
export async function embedRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSharedSecret);

  app.post<{ Body: { token?: unknown } }>('/session', async (req, reply) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || !token) return reply.code(400).send({ error: 'token is required.' });
    const session = await inspectJoinToken(token);
    if (!session) return reply.code(401).send({ error: 'This call link is invalid or has expired.' });
    return session;
  });
}
