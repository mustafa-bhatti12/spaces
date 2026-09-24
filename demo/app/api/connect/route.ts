import type { NextRequest } from 'next/server';
import { normalizeRoomName } from '@/lib/room';
import { jsonBody, relayJson } from '@/lib/server/tokenService';

// Mints a join token for (room, display name, per-browser identity) via token-service's consumer
// route — the exact call Petition Studio's API will make, minus its own "who may join" check.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const room = normalizeRoomName(body.room);
  const name = String(body.name ?? '').trim().slice(0, 64);
  const identity = String(body.identity ?? '').trim().slice(0, 64);
  if (!room || !name || !identity) {
    return Response.json({ error: 'room, name and identity are required.' }, { status: 400 });
  }
  // token-service returns the public wss:// URL when LIVEKIT_PUBLIC_URL is set (droplet), or its
  // internal ws://localhost:7880 locally — which a browser on the same machine can reach directly.
  return relayJson('/token', jsonBody({ room, identity, name }));
}
