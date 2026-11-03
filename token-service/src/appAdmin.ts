import type { FastifyInstance, FastifyReply } from 'fastify';
import { getRegistry, LEGACY_APP, RegistryError, SCOPES } from './apps';

/**
 * Operator API for the app registry (/admin/apps, /admin/audit), mounted inside adminRoutes so
 * ADMIN_SHARED_SECRET gates it. A key's secret is in the response of POST /admin/apps/:slug/keys
 * once and nowhere else; only its hash is stored.
 */
export function appAdminRoutes(app: FastifyInstance): void {
  const registry = getRegistry();
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof RegistryError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  app.get('/apps', async () => ({
    scopes: SCOPES,
    // The legacy shared secret is Petition Studio's credential: shown so operators know it's in use.
    apps: registry.listApps().map((a) => ({ ...a, legacySecret: a.slug === LEGACY_APP && !!process.env.TOKEN_SERVICE_SHARED_SECRET })),
  }));

  app.post<{ Body: { slug?: unknown; name?: unknown; scopes?: unknown } }>('/apps', async (req, reply) => {
    try {
      const created = registry.createApp({ slug: req.body?.slug, name: req.body?.name, scopes: req.body?.scopes });
      registry.audit({ actor: 'admin', appSlug: created.slug, action: 'app.create', ip: req.ip, result: 'ok', detail: `scopes: ${created.scopes.join(', ')}` });
      return created;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { slug: string } }>('/apps/:slug/keys', async (req, reply) => {
    try {
      const issued = registry.issueKey(req.params.slug);
      registry.audit({ actor: 'admin', appSlug: issued.app.slug, keyId: issued.keyId, action: 'key.issue', ip: req.ip, result: 'ok' });
      return { keyId: issued.keyId, key: issued.key };
    } catch (err) {
      if (err instanceof RegistryError && req.params.slug) {
        registry.audit({ actor: 'admin', appSlug: req.params.slug, action: 'key.issue', ip: req.ip, result: 'denied', detail: err.message });
      }
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { slug: string; keyId: string } }>('/apps/:slug/keys/:keyId', async (req, reply) => {
    try {
      const target = registry.revokeKey(req.params.slug, req.params.keyId);
      registry.audit({ actor: 'admin', appSlug: target.slug, keyId: req.params.keyId, action: 'key.revoke', ip: req.ip, result: 'ok' });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Querystring: { limit?: string; before?: string } }>('/audit', async (req) => {
    const before = Number(req.query.before);
    return { events: registry.listAudit(Number(req.query.limit) || 100, Number.isInteger(before) && before > 0 ? before : undefined) };
  });
}
