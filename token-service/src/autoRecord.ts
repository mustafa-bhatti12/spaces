import { parseRoomSettings, startRoomAudioRecording } from './livekit';

/**
 * Records a call from its first join (LiveKit's participant_joined webhook) when RECORD_ALL_CALLS=1
 * (every call; off by default) or when a consumer asked for it on /token (`record: true`, kept in
 * the room's metadata). Someone can still stop it; after that it stays off for the rest of that
 * room's life instead of restarting on the next join.
 * In memory: a restart forgets which rooms were stopped by hand.
 */
const recordAll = process.env.RECORD_ALL_CALLS === '1';
const stoppedByHand = new Set<string>();

// livekit.ParticipantInfo.Kind.EGRESS (livekit-server-sdk doesn't re-export the enum). The recorder
// joining its own room must not count as someone joining.
const EGRESS_KIND = 2;

export function shouldAutoRecord(room: string, kind: number | undefined, roomMetadata: string | undefined): boolean {
  if (kind === EGRESS_KIND || stoppedByHand.has(room)) return false;
  return recordAll || parseRoomSettings(roomMetadata).record;
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
