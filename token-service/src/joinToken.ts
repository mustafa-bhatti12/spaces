import { capacityFor, getRoomSettings, markRoomRecorded, mintToken, recordRoomHost, type CallConnectionDetails } from './livekit';
import { lobby } from './lobby';
import { getSettings } from './settings';
import type { CallSettings } from './settings';

export interface JoinTokenRequest {
  room: string;
  identity: string;
  name: string;
  host: boolean;
  waitingRoom?: boolean;
  record?: boolean;
}

export type JoinTokenResult =
  | { ok: true; details: CallConnectionDetails & { callSettings: CallSettings } }
  | { ok: false; status: 403 | 409 | 503; body: Record<string, unknown> };

/**
 * The one way a join token is minted, for POST /token and POST /v1/rooms/:id/join-tokens: removal and
 * capacity checks, the host/waiting-room bookkeeping in the room's metadata, and the required-
 * recording mark. Throws when LiveKit is unreachable.
 */
export async function issueJoinToken(req: JoinTokenRequest): Promise<JoinTokenResult> {
  const { room, identity, name, host, waitingRoom, record } = req;
  if (!host && lobby.isRemoved(room, identity)) {
    // A host removed them; they stay out until the room ends.
    return { ok: false, status: 403, body: { error: 'A host removed you from this call.', removed: true } };
  }
  const capacity = await capacityFor(room);
  if (capacity !== 'ok') {
    return {
      ok: false,
      status: 503,
      body: {
        error:
          capacity === 'room-full'
            ? 'This call is full. Ask someone to leave, or start another call.'
            : 'All calls on this server are full right now. Try again in a few minutes.',
        full: true,
      },
    };
  }
  if (host) {
    // The caller decides who hosts; recording it lets GET /rooms report it on the next join.
    // A host may also set the waiting room as they join.
    await recordRoomHost(room, identity, waitingRoom);
  } else if ((await getRoomSettings(room))?.waitingRoom && !lobby.isAdmitted(room, identity)) {
    // Enforced here, not left to each consumer: a guest gets in only through /lobby/ask.
    return { ok: false, status: 409, body: { error: 'This call has a waiting room. Ask to join.', waitingRoom: true } };
  }
  // The consumer requires this call to be recorded (autoRecord.ts).
  if (record) await markRoomRecorded(room);
  const details = await mintToken({ room, identity, name, host, record });
  return { ok: true, details: { ...details, callSettings: getSettings().calls } };
}
