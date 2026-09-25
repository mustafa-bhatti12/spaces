import { relayJson } from '@/lib/server/tokenService';

// Active rooms for the lobby's "join an active room" list. Host identities stay server-side, and
// rooms nobody is in yet (a host's token was just minted) aren't worth listing.
export async function GET() {
  const res = await relayJson('/rooms');
  if (!res.ok) return res;
  const rooms: { name: string; numParticipants: number }[] = await res.json();
  return Response.json(
    rooms.filter((r) => r.numParticipants > 0).map(({ name, numParticipants }) => ({ name, numParticipants })),
  );
}
