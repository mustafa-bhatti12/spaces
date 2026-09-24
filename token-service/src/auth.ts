import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

// Service-to-service auth: the caller must present the bearer secret this instance was configured
// with. Two separate secrets so a consumer app's credential (the demo, Petition Studio) can mint
// tokens and drive recording for its own calls, but can't reach the operator-only /admin routes
// (removing people, closing rooms, deleting recordings) — only the /admin control center holds that one.
function requireBearer(envName: string): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const expected = process.env[envName];
    if (!expected) {
      reply.code(500).send({ error: `${envName} is not configured.` });
      return;
    }
    const presented = Buffer.from(req.headers.authorization ?? '');
    const wanted = Buffer.from(`Bearer ${expected}`);
    if (presented.length !== wanted.length || !timingSafeEqual(presented, wanted)) {
      reply.code(401).send({ error: 'Invalid or missing service credentials.' });
    }
  };
}

export const requireSharedSecret = requireBearer('TOKEN_SERVICE_SHARED_SECRET');
export const requireAdminSecret = requireBearer('ADMIN_SHARED_SECRET');
