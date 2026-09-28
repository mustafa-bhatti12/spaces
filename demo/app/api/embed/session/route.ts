import type { NextRequest } from 'next/server';
import { jsonBody, relayJson } from '@/lib/server/tokenService';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) return Response.json({ error: 'token is required.' }, { status: 400 });
  return relayJson('/embed/session', jsonBody({ token }));
}
