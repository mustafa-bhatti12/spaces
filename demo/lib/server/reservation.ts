import 'server-only';
import { tokenServiceFetch } from './tokenService';

/** What token-service says about a room's reservation (GET /room/reservation). Carries no owner or title. */
export type Reservation =
  | { reserved: false }
  | { reserved: true; state: 'open' | 'early' | 'expired' | 'ended'; startsAt: string; expiresAt: string };

export const INACTIVE_LINK = 'This meeting link is no longer active. Ask the person who invited you for a new link.';

/** Throws when token-service can't be reached or answers an error: callers answer 502, never "unreserved". */
export async function getReservation(room: string): Promise<Reservation> {
  const res = await tokenServiceFetch(`/room/reservation?room=${encodeURIComponent(room)}`);
  if (!res.ok) throw new Error(`token-service /room/reservation returned ${res.status}`);
  return res.json();
}
