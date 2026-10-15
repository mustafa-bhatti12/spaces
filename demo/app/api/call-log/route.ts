import type { NextRequest } from 'next/server';
import { jsonBody, relayJson } from '@/lib/server/tokenService';

// The call page's own connection events (lib/client/callLog.ts) → token-service, which checks the join
// token and writes them next to LiveKit's logs. Sent with sendBeacon too, so the body can arrive as text.
export async function POST(request: NextRequest) {
  const body = await request
    .text()
    .then((text) => JSON.parse(text))
    .catch(() => ({}));
  const { room, token, events } = body ?? {};
  if (typeof room !== 'string' || typeof token !== 'string' || !Array.isArray(events)) {
    return Response.json({ error: 'room, token and events are required.' }, { status: 400 });
  }
  return relayJson('/call-log', jsonBody({ room, token, events }));
}
