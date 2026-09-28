import type { NextRequest } from 'next/server';
import { normalizeRoomName } from '@/lib/room';
import { jsonBody, relayJson } from '@/lib/server/tokenService';

const ACTIONS = new Set(['pending', 'answer', 'settings']);

/**
 * Host's waiting-room actions: list who is waiting, admit/deny, turn the waiting room on or off.
 * The host's own join token is the proof; token-service verifies it (same as /api/rooms/end).
 */
export async function POST(request: NextRequest, ctx: RouteContext<'/api/lobby/[action]'>) {
  const { action } = await ctx.params;
  if (!ACTIONS.has(action)) return Response.json({ error: 'Unknown action.' }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  const room = normalizeRoomName(body.room);
  const token = typeof body.token === 'string' ? body.token : '';
  if (!room || !token) return Response.json({ error: 'room and token are required.' }, { status: 400 });
  return relayJson(`/lobby/${action}`, jsonBody({ room, token, ids: body.ids, admit: body.admit, waitingRoom: body.waitingRoom }));
}
