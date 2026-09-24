import 'server-only';

// The only place the demo talks to token-service. Both bearer secrets stay in this server process:
// TOKEN_SERVICE_SHARED_SECRET for the consumer routes the call page needs (/token, /rooms,
// /participant, /recording/*) — the same routes and secret Petition Studio's API will use — and
// ADMIN_SHARED_SECRET only for the /admin control center's proxy.
const TOKEN_SERVICE_URL = (process.env.TOKEN_SERVICE_URL ?? 'http://localhost:8880').replace(/\/$/, '');

export type SecretKind = 'consumer' | 'admin';

export function tokenServiceFetch(path: string, init: RequestInit = {}, kind: SecretKind = 'consumer') {
  const secret = kind === 'admin' ? process.env.ADMIN_SHARED_SECRET : process.env.TOKEN_SERVICE_SHARED_SECRET;
  if (!secret) {
    throw new Error(`${kind === 'admin' ? 'ADMIN_SHARED_SECRET' : 'TOKEN_SERVICE_SHARED_SECRET'} is not set.`);
  }
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${secret}`);
  return fetch(`${TOKEN_SERVICE_URL}${path}`, { ...init, headers, cache: 'no-store' });
}

/**
 * Forwards a JSON call to token-service and relays its status + body, mapping "couldn't reach it"
 * to 502 so the browser can tell a droplet outage from a bad request.
 */
export async function relayJson(path: string, init: RequestInit = {}): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await tokenServiceFetch(path, init);
  } catch (err) {
    console.error(`token-service ${path} unreachable:`, err);
    return Response.json({ error: 'Could not reach the call service. Try again shortly.' }, { status: 502 });
  }
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}

export function jsonBody(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
