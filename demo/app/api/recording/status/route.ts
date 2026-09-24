import type { NextRequest } from 'next/server';
import { normalizeRoomName } from '@/lib/room';
import { relayJson } from '@/lib/server/tokenService';

export async function GET(request: NextRequest) {
  const room = normalizeRoomName(request.nextUrl.searchParams.get('room'));
  if (!room) return Response.json({ error: 'room is required.' }, { status: 400 });
  return relayJson(`/recording/status?room=${encodeURIComponent(room)}`);
}
