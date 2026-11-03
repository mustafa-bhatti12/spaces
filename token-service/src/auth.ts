import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { type AppRecord, type AppRegistry, getRegistry, LEGACY_APP, SCOPES, type Scope } from './apps';
import { RateLimiter } from './rateLimit';

// Service-to-service auth. Two kinds of credential, kept apart so a consumer app's credential can
// mint tokens and drive recording for its own calls but can't reach the operator-only /admin routes
// (removing people, closing rooms, deleting recordings): only the /admin control center holds that one.
//
// Consumer routes (requireApp): a registered app presents either its own key
// (`Authorization: Bearer hsk_<keyId>_<secret>`, issued in /admin -> Apps) or the legacy
// TOKEN_SERVICE_SHARED_SECRET, which is Petition Studio's credential and resolves
// to the `petition-studio` app. Both end up as a registered app with scopes, a rate limit and audit.

export interface Caller {
  app: AppRecord;
  /** Null for the legacy shared secret. */
  keyId: string | null;
  via: 'key' | 'shared-secret';
  scopes: ReadonlySet<Scope>;
}

declare module 'fastify' {
  interface FastifyRequest {
    caller?: Caller;
  }
}

/**
 * May this caller bring a room into existence through /token (with the implicit reservation that
 * leaves)? Only Petition Studio's legacy shared secret: it keeps minting tokens for rooms nobody
 * reserved first. Every app key, even one with `rooms:create` like erp's, reserves rooms through
 * POST /v1/rooms and may only mint tokens for rooms that have an active reservation.
 */
export const mayCreateRooms = (caller: Caller): boolean => caller.via === 'shared-secret' && caller.scopes.has('rooms:create');

export type AuthResult =
  | { ok: true; caller: Caller }
  | { ok: false; status: 401 | 403 | 429 | 500; error: string; retryAfterSec?: number };

const sameSecret = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const limiter = new RateLimiter();

/**
 * Who is calling and may they do `scope`. Order: credential (401), app status and scope (403), rate
 * limit (429). `scope` null means any valid credential. Pure over its inputs so tests can drive it without a server.
 */
export function authorize(
  registry: AppRegistry,
  rateLimiter: RateLimiter,
  authorization: string | undefined,
  sharedSecret: string | undefined,
  scope: Scope | null,
  now = Date.now(),
): AuthResult {
  const header = authorization ?? '';
  let caller: Caller;
  if (header.startsWith('Bearer hsk_')) {
    const found = registry.authenticateKey(header.slice('Bearer '.length), now);
    if (found === 'invalid') return { ok: false, status: 401, error: 'Invalid or missing service credentials.' };
    caller = { app: found.app, keyId: found.keyId, via: 'key', scopes: new Set(found.app.scopes) };
  } else {
    if (!sharedSecret) return { ok: false, status: 500, error: 'TOKEN_SERVICE_SHARED_SECRET is not configured.' };
    if (!sameSecret(header, `Bearer ${sharedSecret}`)) return { ok: false, status: 401, error: 'Invalid or missing service credentials.' };
    const app = registry.getApp(LEGACY_APP);
    if (!app) return { ok: false, status: 500, error: `App ${LEGACY_APP} is not registered.` };
    // The shared secret has always reached every consumer route (the demo's call UI uses it for
    // /room/end, /recording/*, /lobby/*, ...), so it keeps every scope: nothing that works today stops.
    // Its status and rate limits are still petition-studio's.
    caller = { app, keyId: null, via: 'shared-secret', scopes: new Set(SCOPES) };
    registry.touchApp(app, now);
  }
  if (caller.app.status !== 'active') return { ok: false, status: 403, error: `App ${caller.app.slug} is disabled.` };
  if (scope && !caller.scopes.has(scope)) return { ok: false, status: 403, error: `This credential lacks the ${scope} scope.` };
  const limit = (scope ? caller.app.rateLimits[scope] : undefined) ?? caller.app.rateLimits['*'] ?? 300;
  const hit = rateLimiter.hit(`${caller.app.slug}:${scope ?? '*'}`, limit, now);
  if (!hit.allowed) return { ok: false, status: 429, error: 'Rate limit exceeded.', retryAfterSec: hit.retryAfterSec };
  return { ok: true, caller };
}

/** preHandler for a consumer route: authenticates the app and requires `scope` (null: any valid credential). Sets `req.caller`. */
export function requireApp(scope: Scope | null): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const result = authorize(getRegistry(), limiter, req.headers.authorization, process.env.TOKEN_SERVICE_SHARED_SECRET, scope);
    if (result.ok) {
      req.caller = result.caller;
      return;
    }
    if (result.retryAfterSec) reply.header('Retry-After', result.retryAfterSec);
    reply.code(result.status).send({ error: result.error });
  };
}

/** Audit an action by the authenticated caller of this request. */
export function auditCaller(
  req: FastifyRequest,
  action: string,
  fields: { room?: string; externalRef?: string; result?: 'ok' | 'denied' | 'error'; detail?: string } = {},
): void {
  const c = req.caller;
  getRegistry().audit({
    actor: 'app',
    appSlug: c?.app.slug ?? null,
    keyId: c?.keyId ?? null,
    action,
    room: fields.room ?? null,
    externalRef: fields.externalRef ?? null,
    ip: req.ip,
    result: fields.result ?? 'ok',
    detail: fields.detail ?? null,
  });
}

// Operator-only /admin routes: the one bearer secret the /admin control center holds.
export const requireAdminSecret: preHandlerAsyncHookHandler = async (req, reply) => {
  const expected = process.env.ADMIN_SHARED_SECRET;
  if (!expected) {
    reply.code(500).send({ error: 'ADMIN_SHARED_SECRET is not configured.' });
    return;
  }
  if (!sameSecret(req.headers.authorization ?? '', `Bearer ${expected}`)) {
    reply.code(401).send({ error: 'Invalid or missing service credentials.' });
  }
};
