// Operator console requests: /admin/api/* is session-checked, then forwarded to token-service's
// /admin/* with ADMIN_SHARED_SECRET.

export class SessionExpired extends Error {}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (res.status === 401) throw new SessionExpired('Session expired, please log in again.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status})`);
  return data as T;
}
