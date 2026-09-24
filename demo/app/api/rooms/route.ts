import { relayJson } from '@/lib/server/tokenService';

// Active rooms for the lobby's "join an active room" list.
export async function GET() {
  return relayJson('/rooms');
}
