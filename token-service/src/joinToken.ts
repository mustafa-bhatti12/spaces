import * as livekit from './livekit';
import type { CallConnectionDetails } from './livekit';
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
  /** The room's non-implicit reservation: its settings apply to every token minted for the room. */
  reserved?: { record: boolean; waitingRoom: boolean };
}

/** The LiveKit calls issueJoinToken makes; tests swap them. */
export type LiveKitOps = Pick<typeof livekit, 'capacityFor' | 'getRoomSettings' | 'markRoomRecorded' | 'mintToken' | 'recordRoomHost' | 'ensureRoom'>;

export type JoinTokenResult =
  | { ok: true; details: CallConnectionDetails & { callSettings: CallSettings } }
  | { ok: false; status: 403 | 409 | 503; body: Record<string, unknown> };

/**
 * The one way a join token is minted, for POST /token and POST /v1/rooms/:id/join-tokens: removal and
 * capacity checks, the host/waiting-room bookkeeping in the room's metadata, and the required-
 * recording mark. Creates the LiveKit room if it isn't live, so callers must have decided that this
 * room may exist (reservations.ts `gateTokenMint`). Throws when LiveKit is unreachable.
 */
export async function issueJoinToken(req: JoinTokenRequest, lk: LiveKitOps = livekit): Promise<JoinTokenResult> {
  const { room, identity, name, host, reserved } = req;
  const waitingRoom = req.waitingRoom ?? reserved?.waitingRoom;
  const record = req.record === true || reserved?.record === true;
  if (!host && lobby.isRemoved(room, identity)) {
    // A host removed them; they stay out until the room ends.
    return { ok: false, status: 403, body: { error: 'A host removed you from this call.', removed: true } };
  }
  const capacity = await lk.capacityFor(room);
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
  // LiveKit doesn't create rooms by itself (auto_create is off): bring it into existence now, before
  // the token goes out. Whoever arrives first seeds it, from the reservation and the host flag, so a
  // guest who beats the host still lands in the waiting room and the recording is required.
  await lk.ensureRoom(room, { hosts: host ? [identity] : [], record, waitingRoom: waitingRoom === true });
  if (host) {
    // The caller decides who hosts; recording it lets GET /rooms report it on the next join.
    // A host may also set the waiting room as they join.
    await lk.recordRoomHost(room, identity, waitingRoom);
  } else if ((await lk.getRoomSettings(room))?.waitingRoom && !lobby.isAdmitted(room, identity)) {
    // Enforced here, not left to each consumer: a guest gets in only through /lobby/ask.
    return { ok: false, status: 409, body: { error: 'This call has a waiting room. Ask to join.', waitingRoom: true } };
  }
  // The consumer requires this call to be recorded (autoRecord.ts).
  if (record) await lk.markRoomRecorded(room);
  const details = await lk.mintToken({ room, identity, name, host, record, waitingRoom: waitingRoom === true });
  return { ok: true, details: { ...details, callSettings: getSettings().calls } };
}
