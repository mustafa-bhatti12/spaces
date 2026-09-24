import type { NextRequest } from 'next/server';
import { adminEnabled, loginAllowed, passwordMatches, recordLoginResult, sessionCookie } from '@/lib/server/adminSession';

export async function POST(request: NextRequest) {
  if (!adminEnabled()) return Response.json({ error: 'Admin is disabled.' }, { status: 404 });
  if (!loginAllowed(request)) {
    return Response.json({ error: 'Too many failed attempts. Try again in 15 minutes.' }, { status: 429 });
  }
  const body = await request.json().catch(() => ({}));
  const ok = passwordMatches(String(body.password ?? ''));
  recordLoginResult(request, ok);
  if (!ok) return Response.json({ error: 'Wrong password.' }, { status: 401 });
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': sessionCookie(request) } });
}
