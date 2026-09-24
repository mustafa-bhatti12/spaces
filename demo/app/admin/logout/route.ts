import type { NextRequest } from 'next/server';
import { sessionCookie } from '@/lib/server/adminSession';

export async function POST(request: NextRequest) {
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': sessionCookie(request, 0) } });
}
