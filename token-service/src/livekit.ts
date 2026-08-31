import path from 'node:path';
import {
  AccessToken,
  EgressClient,
  EgressInfo,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  WebhookConfig,
} from 'livekit-server-sdk';

export interface CallConnectionDetails {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
}

/**
 * Mints a LiveKit join token. Deliberately knows nothing about any consuming app's users, cases,
 * or authorization rules — the caller (e.g. Petition Studio's calls module) decides who is allowed
 * to join which room and what their identity/display name is; this only turns that decision into a
 * signed token. Keeping this generic is what lets a second consumer reuse the same service later.
 */
export async function mintToken(params: {
  room: string;
  identity: string;
  name: string;
}): Promise<CallConnectionDetails> {
  const { apiKey, apiSecret, serverUrl } = requireLiveKitEnv();

  const at = new AccessToken(apiKey, apiSecret, {
    identity: params.identity,
    name: params.name,
  });
  at.ttl = '2h';
  at.addGrant({
    room: params.room,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });

  return {
    serverUrl,
    roomName: params.room,
    participantName: params.name,
    participantToken: await at.toJwt(),
  };
}

export interface ActiveRoom {
  name: string;
  numParticipants: number;
}

/**
 * Lists rooms that currently have at least one connection. Used only by the throwaway test-call
 * site's room picker so a second person can see what the first person already started instead of
 * having to type an exact room name. Never expose this over an unauthenticated endpoint — it's
 * gated by the same shared secret as /token.
 */
export async function listActiveRooms(): Promise<ActiveRoom[]> {
  const { apiKey, apiSecret, serverUrl } = requireLiveKitEnv();

  const svc = new RoomServiceClient(serverUrl, apiKey, apiSecret);
  const rooms = await svc.listRooms();
  return rooms.map((room) => ({ name: room.name, numParticipants: room.numParticipants }));
}

/**
 * Looks up the SID (connection id) LiveKit currently has on file for an identity in a room, or
 * null if that identity isn't present at all. Used by the throwaway test-call site as a pull-based
 * heartbeat: LiveKit's own push-based "you were disconnected" signal to the losing side of a
 * duplicate-identity join wasn't observed firing promptly in local testing, so the losing client
 * instead polls this and self-disconnects the moment its own sid no longer matches the current
 * one -- this admin API reflects the true state immediately, verified separately.
 */
export async function getParticipantSid(room: string, identity: string): Promise<string | null> {
  const { apiKey, apiSecret, serverUrl } = requireLiveKitEnv();
  const svc = new RoomServiceClient(serverUrl, apiKey, apiSecret);
  try {
    const participant = await svc.getParticipant(room, identity);
    return participant.sid;
  } catch {
    return null;
  }
}

export interface RecordingInfo {
  egressId: string;
  roomName: string;
  startedAt: string;
  // Display name of whoever pressed "record", for transparency (shown in the REC badge/toast to
  // every participant once their client syncs status). In-memory only, keyed by egressId --
  // there's no auth/role model anywhere in this app to *gate* who's allowed to start a
  // recording, so this is purely an audit hint, not an authorization check. Lost on a
  // token-service restart, which just means already-running recordings lose the hint.
  startedBy?: string;
}

const recordingStartedBy = new Map<string, string>();

function toRecordingInfo(info: EgressInfo): RecordingInfo {
  return {
    egressId: info.egressId,
    roomName: info.roomName,
    startedAt: info.startedAt.toString(),
    startedBy: recordingStartedBy.get(info.egressId),
  };
}

// LiveKit Egress runs in its own Docker container (see ../egress/) and writes the raw recording
// under the path *as that container sees it* -- /out/raw/<file>, from ../egress mounted at /out.
// Everything server-side (this process, the compressor) needs the real host path instead; this is
// the one place that mapping is defined.
const EGRESS_CONTAINER_RAW_DIR = '/out/raw';
const EGRESS_HOST_RAW_DIR = process.env.EGRESS_RAW_DIR ?? path.join(__dirname, '..', '..', 'egress', 'raw');

export function containerPathToHostPath(containerPath: string): string {
  // path.posix (not the bare string) so a sibling directory that merely shares the prefix --
  // e.g. /out/raw-evil/x -- can't slip past a naive `.startsWith(EGRESS_CONTAINER_RAW_DIR)`
  // check, and so `..` segments can't walk the result outside EGRESS_HOST_RAW_DIR. containerPath
  // always uses posix separators: it's a path inside the (Linux) egress container regardless of
  // what OS this process itself runs on.
  const relative = path.posix.relative(EGRESS_CONTAINER_RAW_DIR, containerPath);
  if (relative.startsWith('..') || path.posix.isAbsolute(relative)) {
    throw new Error(`Unexpected egress file path outside ${EGRESS_CONTAINER_RAW_DIR}: ${containerPath}`);
  }
  return path.join(EGRESS_HOST_RAW_DIR, relative);
}

// Serializes concurrent start requests for the same room onto one in-flight attempt, so two
// participants clicking "record" within the same tick can't each mint a separate egress session
// for the same room (the second would otherwise double-record and orphan itself -- nothing in
// the UI tracks more than one egressId per room).
const pendingStarts = new Map<string, Promise<RecordingInfo>>();

/**
 * Starts a single mixed-audio recording of every participant currently in the room. Tied to the
 * room's lifecycle -- LiveKit stops it automatically once the room empties, same as if /stop had
 * been called. The webhook lets us know the moment the file is finalized so it can be handed to
 * the compressor without polling or guessing when Egress is done writing it.
 *
 * Idempotent: if a recording is already active for this room, returns that one instead of
 * starting a second.
 */
export async function startRoomAudioRecording(room: string, startedByName?: string): Promise<RecordingInfo> {
  const inFlight = pendingStarts.get(room);
  if (inFlight) return inFlight;

  const attempt = (async (): Promise<RecordingInfo> => {
    const { apiKey, apiSecret, serverUrl } = requireLiveKitEnv();
    const egress = new EgressClient(serverUrl, apiKey, apiSecret);

    const active = await egress.listEgress({ roomName: room, active: true });
    if (active.length > 0) {
      return toRecordingInfo(active[0]);
    }

    const filename = `${room}-${Date.now()}.ogg`;
    const info = await egress.startRoomCompositeEgress(
      room,
      new EncodedFileOutput({ fileType: EncodedFileType.OGG, filepath: path.posix.join(EGRESS_CONTAINER_RAW_DIR, filename) }),
      {
        audioOnly: true, // leaving layout/customBaseUrl unset is what keeps this on the audio-only billing rate
        webhooks: [new WebhookConfig({ url: process.env.RECORDING_WEBHOOK_URL ?? 'http://localhost:8880/recording/webhook' })],
      },
    );
    if (startedByName) recordingStartedBy.set(info.egressId, startedByName);
    return toRecordingInfo(info);
  })();

  pendingStarts.set(room, attempt);
  try {
    return await attempt;
  } finally {
    pendingStarts.delete(room);
  }
}

export async function stopRecording(egressId: string): Promise<void> {
  const { apiKey, apiSecret, serverUrl } = requireLiveKitEnv();
  const egress = new EgressClient(serverUrl, apiKey, apiSecret);
  await egress.stopEgress(egressId);
  recordingStartedBy.delete(egressId);
}

/** Recordings currently in progress for a room (starting, active, or wrapping up). */
export async function getActiveRecordings(room: string): Promise<RecordingInfo[]> {
  const { apiKey, apiSecret, serverUrl } = requireLiveKitEnv();
  const egress = new EgressClient(serverUrl, apiKey, apiSecret);
  const active = await egress.listEgress({ roomName: room, active: true });
  return active.map(toRecordingInfo);
}

// Defensive belt-and-braces for the (rare) case LiveKit's own room-lifecycle coupling doesn't
// tear an egress down cleanly: called from the room_finished webhook once a room has genuinely
// closed, so a recording can't outlive every participant having left. See index.ts's webhook
// handler.
export async function stopAllActiveRecordings(room: string): Promise<void> {
  const active = await getActiveRecordings(room);
  await Promise.all(active.map((r) => stopRecording(r.egressId)));
}

function requireLiveKitEnv() {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const serverUrl = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !serverUrl) {
    throw new Error('LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_URL must be set.');
  }
  return { apiKey, apiSecret, serverUrl };
}
