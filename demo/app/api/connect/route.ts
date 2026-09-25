import type { NextRequest } from 'next/server';
import { normalizeRoomName } from '@/lib/room';
import { jsonBody, relayJson, tokenServiceFetch } from '@/lib/server/tokenService';

/**
 * The demo's hosting rule: whoever starts a room hosts it. A room with no recorded host is being
 * started, so the joiner becomes host; the recorded host keeps hosting when they rejoin. The record
 * lives in the room itself, so it goes away when the room does.
 */
async function isHost(room: string, identity: string): Promise<boolean> {
  const res = await tokenServiceFetch('/rooms');
  if (!res.ok) throw new Error(`token-service /rooms returned ${res.status}`);
  const rooms: { name: string; host: string | null }[] = await res.json();
  const host = rooms.find((r) => r.name === room)?.host ?? null;
  return host === null || host === identity;
}

// Mints a join token for (room, display name, per-browser identity) via token-service's consumer
// route — the exact call Petition Studio's API will make, with its own "who may join / who hosts" check.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const room = normalizeRoomName(body.room);
  const name = String(body.name ?? '').trim().slice(0, 64);
  const identity = String(body.identity ?? '').trim().slice(0, 64);
  if (!room || !name || !identity) {
    return Response.json({ error: 'room, name and identity are required.' }, { status: 400 });
  }
  let host: boolean;
  try {
    host = await isHost(room, identity);
  } catch (err) {
    console.error('Could not look up the room host:', err);
    return Response.json({ error: 'Could not reach the call service. Try again shortly.' }, { status: 502 });
  }
  // token-service returns the public wss:// URL when LIVEKIT_PUBLIC_URL is set (droplet), or its
  // internal ws://localhost:7880 locally — which a browser on the same machine can reach directly.
  const res = await relayJson('/token', jsonBody({ room, identity, name, host }));
  if (!res.ok) return res;
  return Response.json({ ...(await res.json()), host });
}
