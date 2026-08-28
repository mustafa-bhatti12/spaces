import type { FastifyReply, FastifyRequest } from 'fastify';

/** Service-to-service auth: the caller must present the shared secret this instance was configured with. */
export async function requireSharedSecret(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = process.env.TOKEN_SERVICE_SHARED_SECRET;
  if (!expected) {
    reply.code(500).send({ error: 'TOKEN_SERVICE_SHARED_SECRET is not configured.' });
    return;
  }
  if (req.headers.authorization !== `Bearer ${expected}`) {
    reply.code(401).send({ error: 'Invalid or missing service credentials.' });
    return;
  }
}
