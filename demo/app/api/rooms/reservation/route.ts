import type { NextRequest } from 'next/server';
import { normalizeRoomName } from '@/lib/room';
import { getReservation } from '@/lib/server/reservation';

/** Whether a room is reserved and its guest window (open / early / expired / ended), for the room page. */
export async function GET(request: NextRequest) {
  const room = normalizeRoomName(request.nextUrl.searchParams.get('room'));
  if (!room) return Response.json({ error: 'room is required.' }, { status: 400 });
  try {
    return Response.json(await getReservation(room));
  } catch (err) {
    console.error('Could not look up the reservation:', err);
    return Response.json({ error: 'Could not reach the call service. Try again shortly.' }, { status: 502 });
  }
}
