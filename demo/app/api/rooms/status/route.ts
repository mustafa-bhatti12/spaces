import type { NextRequest } from 'next/server';
import { normalizeRoomName } from '@/lib/room';
import { getReservation } from '@/lib/server/reservation';
import { relayJson } from '@/lib/server/tokenService';

/**
 * What the pre-join screen needs about one room: how many are in it, whether this browser would host
 * it (same rule as /api/connect: never in a reserved room), and whether its waiting room is on. The host's identity stays here.
 */
export async function GET(request: NextRequest) {
  const room = normalizeRoomName(request.nextUrl.searchParams.get('room'));
  const identity = String(request.nextUrl.searchParams.get('identity') ?? '').trim();
  if (!room || !identity) return Response.json({ error: 'room and identity are required.' }, { status: 400 });
  const res = await relayJson('/rooms');
  if (!res.ok) return res;
  let reserved: boolean;
  try {
    reserved = (await getReservation(room)).reserved;
  } catch (err) {
    console.error('Could not look up the reservation:', err);
    return Response.json({ error: 'Could not reach the call service. Try again shortly.' }, { status: 502 });
  }
  const rooms: { name: string; numParticipants: number; hosts: string[]; waitingRoom: boolean }[] = await res.json();
  const found = rooms.find((r) => r.name === room);
  return Response.json({
    numParticipants: found?.numParticipants ?? 0,
    // Nobody hosts a reserved room from here: its host joins with a token.
    youHost: !reserved && (!found?.hosts.length || found.hosts.includes(identity)),
    waitingRoom: found?.waitingRoom ?? false,
  });
}
