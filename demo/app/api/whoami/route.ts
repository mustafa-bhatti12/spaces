import type { NextRequest } from 'next/server';
import { normalizeRoomName } from '@/lib/room';
import { relayJson } from '@/lib/server/tokenService';

// Duplicate-identity heartbeat: the client polls this while connected and leaves as soon as the
// sid LiveKit has on file for its identity isn't its own (another tab of the same browser joined).
// LiveKit's own push-based eviction wasn't observed arriving promptly, hence the poll.
export async function GET(request: NextRequest) {
  const room = normalizeRoomName(request.nextUrl.searchParams.get('room'));
  const identity = request.nextUrl.searchParams.get('identity')?.trim() ?? '';
  if (!room || !identity) {
    return Response.json({ error: 'room and identity are required.' }, { status: 400 });
  }
  return relayJson(`/participant?room=${encodeURIComponent(room)}&identity=${encodeURIComponent(identity)}`);
}
