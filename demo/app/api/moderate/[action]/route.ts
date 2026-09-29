import type { NextRequest } from 'next/server';
import { normalizeRoomName } from '@/lib/room';
import { jsonBody, relayJson } from '@/lib/server/tokenService';

const ACTIONS = new Set(['mute', 'remove', 'spotlight']);

/**
 * Host moderation: mute someone's mic, remove someone, pin someone for everyone (identity null
 * unpins). The host's own join token is the proof; token-service checks it against the hosts list.
 */
export async function POST(request: NextRequest, ctx: RouteContext<'/api/moderate/[action]'>) {
  const { action } = await ctx.params;
  if (!ACTIONS.has(action)) return Response.json({ error: 'Unknown action.' }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  const room = normalizeRoomName(body.room);
  const token = typeof body.token === 'string' ? body.token : '';
  const identity = typeof body.identity === 'string' && body.identity ? body.identity : null;
  if (!room || !token || (!identity && action !== 'spotlight')) {
    return Response.json({ error: 'room, token and identity are required.' }, { status: 400 });
  }
  return relayJson(`/room/${action}`, jsonBody({ room, token, identity }));
}
