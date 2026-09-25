import type { NextRequest } from 'next/server';
import { normalizeRoomName } from '@/lib/room';
import { jsonBody, relayJson } from '@/lib/server/tokenService';

// Host's "End call for everyone". The host's own join token is the proof; token-service verifies it.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const room = normalizeRoomName(body.room);
  const token = typeof body.token === 'string' ? body.token : '';
  if (!room || !token) return Response.json({ error: 'room and token are required.' }, { status: 400 });
  return relayJson('/room/end', jsonBody({ room, token }));
}
