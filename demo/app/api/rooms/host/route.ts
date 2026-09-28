import type { NextRequest } from 'next/server';
import { normalizeRoomName } from '@/lib/room';
import { jsonBody, relayJson } from '@/lib/server/tokenService';

// A host makes someone a host, or stops them hosting. The caller's own join token is the proof;
// token-service checks it against the room's hosts list.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const room = normalizeRoomName(body.room);
  const token = typeof body.token === 'string' ? body.token : '';
  const identity = typeof body.identity === 'string' ? body.identity : '';
  if (!room || !token || !identity || typeof body.host !== 'boolean') {
    return Response.json({ error: 'room, token, identity and host are required.' }, { status: 400 });
  }
  return relayJson('/room/host', jsonBody({ room, token, identity, host: body.host }));
}
