import { startRoomAudioRecording } from './livekit';

/**
 * Off by default; RECORD_ALL_CALLS=1 records every call: the first participant to join a room starts
 * its recording (LiveKit's participant_joined webhook). Someone can still stop it; after that it
 * stays off for the rest of that room's life instead of restarting on the next join.
 * In memory: a restart forgets which rooms were stopped by hand.
 */
const enabled = process.env.RECORD_ALL_CALLS === '1';
const stoppedByHand = new Set<string>();

// livekit.ParticipantInfo.Kind.EGRESS (livekit-server-sdk doesn't re-export the enum). The recorder
// joining its own room must not count as someone joining.
const EGRESS_KIND = 2;

export function onParticipantJoined(room: string, kind: number | undefined): void {
  if (!enabled || kind === EGRESS_KIND || stoppedByHand.has(room)) return;
  // Idempotent: returns the room's active recording if one is already running or starting.
  startRoomAudioRecording(room).catch((err) => console.error(`Could not auto-start recording for ${room}:`, err));
}

export function onRecordingStoppedByHand(room: string): void {
  if (room) stoppedByHand.add(room);
}

export function forgetRoom(room: string): void {
  stoppedByHand.delete(room);
}
