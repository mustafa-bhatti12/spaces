import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

// The only login in the repo: the /admin control center's operator password. Disabled unless both
// ADMIN_PASSWORD (the login) and ADMIN_SHARED_SECRET (what it spends on token-service) are set.
export const SESSION_COOKIE = 'space_admin';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MAX_FAILED_LOGINS = 5;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;

// Derived rather than random-per-process: Next bundles each route separately, so a module-level
// random key would differ between the login route and the API proxy. Changing either secret logs
// every operator out, which is the behavior you want after a rotation.
function signingKey(): Buffer | null {
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SHARED_SECRET;
  if (!password || !secret) return null;
  return createHmac('sha256', secret).update(`space-admin-session\0${password}`).digest();
}

export function adminEnabled(): boolean {
  return signingKey() !== null;
}

function sign(key: Buffer, expiresAt: string): string {
  return createHmac('sha256', key).update(expiresAt).digest('base64url');
}

export function hasValidSession(request: NextRequest): boolean {
  const key = signingKey();
  const value = request.cookies.get(SESSION_COOKIE)?.value;
  if (!key || !value) return false;
  const [expiresAt, signature] = value.split('.');
  if (!expiresAt || !signature || Number(expiresAt) < Date.now()) return false;
  const expected = Buffer.from(sign(key, expiresAt));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function passwordMatches(attempt: string): boolean {
  const password = process.env.ADMIN_PASSWORD ?? '';
  const a = createHash('sha256').update(attempt).digest();
  const b = createHash('sha256').update(password).digest();
  return password.length > 0 && timingSafeEqual(a, b);
}

function isHttps(request: NextRequest): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0].trim();
  return (forwarded ?? request.nextUrl.protocol.replace(':', '')) === 'https';
}

export function sessionCookie(request: NextRequest, maxAgeSeconds = SESSION_TTL_SECONDS): string {
  const key = signingKey();
  let value = '';
  if (key && maxAgeSeconds > 0) {
    const expiresAt = String(Date.now() + maxAgeSeconds * 1000);
    value = `${expiresAt}.${sign(key, expiresAt)}`;
  }
  const secure = isHttps(request) ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

// Behind Railway's edge (TRUST_PROXY=1) the real client is the first X-Forwarded-For hop. Without a
// trusted proxy the header is client-controlled, so everyone shares one bucket instead of letting a
// client spoof its way past the limit.
function clientKey(request: NextRequest): string {
  if (process.env.TRUST_PROXY !== '1') return 'direct';
  return request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
}

type FailedLogins = Map<string, { count: number; since: number }>;
// globalThis, not module scope: shared by every route bundle in this process (see signingKey).
const globalStore = globalThis as typeof globalThis & { __spaceAdminFailedLogins?: FailedLogins };
const failedLogins: FailedLogins = (globalStore.__spaceAdminFailedLogins ??= new Map());

/** Returns false (and the caller answers 429) once this client has too many recent failures. */
export function loginAllowed(request: NextRequest): boolean {
  const key = clientKey(request);
  const record = failedLogins.get(key);
  if (record && Date.now() - record.since > FAILED_LOGIN_WINDOW_MS) failedLogins.delete(key);
  return (failedLogins.get(key)?.count ?? 0) < MAX_FAILED_LOGINS;
}

export function recordLoginResult(request: NextRequest, succeeded: boolean): void {
  const key = clientKey(request);
  if (succeeded) {
    failedLogins.delete(key);
    return;
  }
  const current = failedLogins.get(key) ?? { count: 0, since: Date.now() };
  failedLogins.set(key, { count: current.count + 1, since: current.since });
}
