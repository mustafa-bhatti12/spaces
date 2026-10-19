import { listActiveRooms, listAllActiveRecordings, parseRoomSettings, startRoomAudioRecording } from './livekit';
import { getSettings } from './settings';

/**
 * Records a call from its first join (LiveKit's participant_joined webhook) when "record every call"
 * is on (settings.ts: RECORD_ALL_CALLS=1 or /admin; off by default) or when a consumer requires it
 * on /token (`record: true`, kept in the room's metadata). A "record every call" recording can be
 * stopped from the call; after that it stays off for the rest of that room's life instead of
 * restarting on the next join. A required one can't (/recording/stop refuses), and
 * checkRequiredRecordings restarts it whenever it's missing; only /admin can stop it.
 * In memory: a restart forgets which rooms were stopped by hand.
 */
const stoppedByHand = new Set<string>();

// livekit.ParticipantInfo.Kind.EGRESS (livekit-server-sdk doesn't re-export the enum). The recorder
// joining its own room must not count as someone joining.
const EGRESS_KIND = 2;

export function shouldAutoRecord(room: string, kind: number | undefined, roomMetadata: string | undefined): boolean {
  if (kind === EGRESS_KIND || stoppedByHand.has(room)) return false;
  return getSettings().recording.recordAllCalls || parseRoomSettings(roomMetadata).record;
}

export function onParticipantJoined(room: string, kind: number | undefined, roomMetadata: string | undefined): void {
  if (!shouldAutoRecord(room, kind, roomMetadata)) return;
  // Idempotent: returns the room's active recording if one is already running or starting.
  startRoomAudioRecording(room).catch((err) => console.error(`Could not auto-start recording for ${room}:`, err));
}

export function onRecordingStoppedByHand(room: string): void {
  if (room) stoppedByHand.add(room);
}

export function forgetRoom(room: string): void {
  stoppedByHand.delete(room);
}

/** Rooms that must be recorded, have someone in them, and have no recording running or starting. */
export function roomsMissingRecording(
  rooms: { name: string; numParticipants: number; record: boolean }[],
  recordingRooms: ReadonlySet<string>,
): string[] {
  return rooms
    .filter((r) => r.record && r.numParticipants > 0 && !recordingRooms.has(r.name) && !stoppedByHand.has(r.name))
    .map((r) => r.name);
}

/**
 * The guarantee behind `record: true`: the join webhook only starts a recording once, so anything
 * that ends one early (the egress worker failing or restarting, a start refused while it was down, a
 * missed webhook, this service restarting) would otherwise leave the rest of the call unrecorded.
 */
export async function checkRequiredRecordings(): Promise<void> {
  const [rooms, recordings] = await Promise.all([listActiveRooms(), listAllActiveRecordings()]);
  for (const room of roomsMissingRecording(rooms, new Set(recordings.map((r) => r.roomName)))) {
    console.warn(`${room} must be recorded but isn't; starting a recording.`);
    await startRoomAudioRecording(room).catch((err) => console.error(`Could not start the required recording for ${room}:`, err));
  }
}

const CHECK_EVERY_MS = 10_000;

export function watchRequiredRecordings(): void {
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    checkRequiredRecordings()
      .catch((err) => console.error('Could not check required recordings:', err))
      .finally(() => (running = false));
  }, CHECK_EVERY_MS).unref();
}
