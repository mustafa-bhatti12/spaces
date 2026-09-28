import type { NextRequest } from 'next/server';
import { normalizeRoomName } from '@/lib/room';
import { relayJson } from '@/lib/server/tokenService';

/**
 * What the pre-join screen needs about one room: how many are in it, whether this browser would host
 * it (same rule as /api/connect), and whether its waiting room is on. The host's identity stays here.
 */
export async function GET(request: NextRequest) {
  const room = normalizeRoomName(request.nextUrl.searchParams.get('room'));
  const identity = String(request.nextUrl.searchParams.get('identity') ?? '').trim();
  if (!room || !identity) return Response.json({ error: 'room and identity are required.' }, { status: 400 });
  const res = await relayJson('/rooms');
  if (!res.ok) return res;
  const rooms: { name: string; numParticipants: number; host: string | null; waitingRoom: boolean }[] = await res.json();
  const found = rooms.find((r) => r.name === room);
  return Response.json({
    numParticipants: found?.numParticipants ?? 0,
    youHost: !found?.host || found.host === identity,
    waitingRoom: found?.waitingRoom ?? false,
  });
}
