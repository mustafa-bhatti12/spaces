import type { NextRequest } from 'next/server';
import { normalizeRoomName } from '@/lib/room';
import { jsonBody, relayJson } from '@/lib/server/tokenService';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const room = normalizeRoomName(body.room);
  if (!room) return Response.json({ error: 'room is required.' }, { status: 400 });
  const startedBy = String(body.startedBy ?? '').trim().slice(0, 64) || undefined;
  return relayJson('/recording/start', jsonBody({ room, startedBy }));
}
