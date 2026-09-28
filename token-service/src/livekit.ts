import path from 'node:path';
import {
  AccessToken,
  AudioCodec,
  DataPacket_Kind,
  EgressClient,
  EgressInfo,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptions,
  ParticipantInfo_State,
  RoomServiceClient,
  TrackSource,
  TrackType,
  TokenVerifier,
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
  /** The caller decided this participant hosts the room: they may end it for everyone. */
  host?: boolean;
}): Promise<CallConnectionDetails> {
  const { apiKey, apiSecret, serverUrl } = requireLiveKitEnv();

  const at = new AccessToken(apiKey, apiSecret, {
    identity: params.identity,
    name: params.name,
    // Lets every client show who hosts (display only; ending a room checks roomAdmin below).
    attributes: params.host ? { [HOST_ATTRIBUTE]: 'true' } : undefined,
  });
  at.ttl = '2h';
  at.addGrant({
    room: params.room,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
    // Lets the client set its own participant attributes (the demo's raised hand). Scoped to the
    // participant's own metadata/attributes only, never anyone else's.
    canUpdateOwnMetadata: true,
    // A host's token doubles as its proof of hosting for endRoomAsHost.
    roomAdmin: params.host === true,
  });

  return {
    // The browser connects to this, so it must be the public wss:// URL on a real deployment;
    // LIVEKIT_URL is how this process itself reaches LiveKit (usually ws://localhost:7880).
    serverUrl: process.env.LIVEKIT_PUBLIC_URL || serverUrl,
    roomName: params.room,
    participantName: params.name,
    participantToken: await at.toJwt(),
  };
}

export const HOST_ATTRIBUTE = 'space.host';

/** What this service keeps in LiveKit's room metadata. It lives and dies with the room. */
export interface RoomSettings {
  /** Identity recorded by recordRoomHost, or null. */
  host: string | null;
  /** New joiners who aren't the host wait for the host to admit them (see lobby.ts). */
  waitingRoom: boolean;
}

function parseRoomSettings(metadata: string | undefined): RoomSettings {
  try {
    const m = JSON.parse(metadata || '{}');
    return { host: typeof m.host === 'string' && m.host ? m.host : null, waitingRoom: m.waitingRoom === true };
  } catch {
    return { host: null, waitingRoom: false };
  }
}

/** The room's settings, or null when the room doesn't exist (nobody has joined or hosted it yet). */
export async function getRoomSettings(room: string): Promise<RoomSettings | null> {
  const [existing] = await roomService().listRooms([room]);
  return existing ? parseRoomSettings(existing.metadata) : null;
}

/**
 * Records `identity` as the room's host in LiveKit's room metadata (creating the room if nobody has
 * joined yet), so a consumer can later ask who hosts it via listActiveRooms. Which identity hosts is
 * the consumer's decision; this only stores it where it lives and dies with the room. `waitingRoom`,
 * when given, sets the room's waiting room at the same time (the host chose it before joining).
 */
export async function recordRoomHost(room: string, identity: string, waitingRoom?: boolean): Promise<void> {
  const svc = roomService();
  const [existing] = await svc.listRooms([room]);
  const current = existing ? parseRoomSettings(existing.metadata) : { host: null, waitingRoom: false };
  const next: RoomSettings = { host: identity, waitingRoom: waitingRoom ?? current.waitingRoom };
  const metadata = JSON.stringify(next);
  if (!existing) {
    await svc.createRoom({ name: room, metadata });
  } else if (current.host !== next.host || current.waitingRoom !== next.waitingRoom) {
    await svc.updateRoomMetadata(room, metadata);
  }
}

/** Turns the room's waiting room on or off. Every client sees the change as a metadata update. */
export async function setWaitingRoom(room: string, enabled: boolean): Promise<void> {
  const settings = await getRoomSettings(room);
  if (!settings || settings.waitingRoom === enabled) return;
  await roomService().updateRoomMetadata(room, JSON.stringify({ ...settings, waitingRoom: enabled }));
}

/** Tells every client in the room something changed on `topic` (a hint to refetch; the byte is a placeholder). */
export async function notifyRoom(room: string, topic: string): Promise<void> {
  await roomService().sendData(room, new Uint8Array([1]), DataPacket_Kind.RELIABLE, { topic });
}

/**
 * True if `token` is a join token this service minted for a host of `room` (host tokens carry
 * roomAdmin). Expired tokens are still accepted for a day: a long call outlives the 2h join TTL, and
 * the signature alone proves who it was issued to.
 */
export async function isHostToken(room: string, token: string): Promise<boolean> {
  const { apiKey, apiSecret } = requireLiveKitEnv();
  try {
    const grants = await new TokenVerifier(apiKey, apiSecret).verify(token, '24h');
    return grants.video?.room === room && grants.video.roomAdmin === true;
  } catch {
    return false;
  }
}

/** Ends `room` for everyone if `token` is a host's join token for it (see isHostToken). */
export async function endRoomAsHost(room: string, token: string): Promise<'ended' | 'forbidden'> {
  if (!(await isHostToken(room, token))) return 'forbidden';
  await closeRoom(room);
  return 'ended';
}

export interface ActiveRoom extends RoomSettings {
  name: string;
  numParticipants: number;
}

/**
 * Lists rooms that currently have at least one connection. Used only by the demo's lobby
 * room picker so a second person can see what the first person already started instead of
 * having to type an exact room name. Never expose this over an unauthenticated endpoint — it's
 * gated by the same shared secret as /token.
 */
export async function listActiveRooms(): Promise<ActiveRoom[]> {
  const rooms = await roomService().listRooms();
  return rooms.map((room) => ({ name: room.name, numParticipants: room.numParticipants, ...parseRoomSettings(room.metadata) }));
}

export interface AdminTrack {
  sid: string;
  kind: string; // AUDIO / VIDEO / DATA
  source: string; // CAMERA / MICROPHONE / SCREEN_SHARE / SCREEN_SHARE_AUDIO / UNKNOWN
  muted: boolean;
}

export interface AdminParticipant {
  identity: string;
  name: string;
  state: string; // JOINING / JOINED / ACTIVE / DISCONNECTED
  joinedAt: string; // ISO timestamp
  tracks: AdminTrack[];
}

export interface AdminRoom {
  name: string;
  createdAt: string; // ISO timestamp
  participants: AdminParticipant[];
}

/**
 * Every active room with its participants and their published tracks, for the operator's admin
 * page. Operator-only: exposed solely under token-service's shared-secret-gated /admin routes.
 */
export async function listRoomsWithParticipants(): Promise<AdminRoom[]> {
  const svc = roomService();
  const rooms = await svc.listRooms();
  return Promise.all(
    rooms.map(async (room) => ({
      name: room.name,
      createdAt: new Date(Number(room.creationTime) * 1000).toISOString(),
      participants: (await svc.listParticipants(room.name)).map((p) => ({
        identity: p.identity,
        name: p.name,
        state: ParticipantInfo_State[p.state] ?? 'UNKNOWN',
        joinedAt: new Date(Number(p.joinedAt) * 1000).toISOString(),
        tracks: p.tracks.map((t) => ({
          sid: t.sid,
          kind: TrackType[t.type] ?? 'UNKNOWN',
          source: TrackSource[t.source] ?? 'UNKNOWN',
          muted: t.muted,
        })),
      })),
    })),
  );
}

export async function removeParticipant(room: string, identity: string): Promise<void> {
  await roomService().removeParticipant(room, identity);
}

export async function setTrackMuted(room: string, identity: string, trackSid: string, muted: boolean): Promise<void> {
  await roomService().mutePublishedTrack(room, identity, trackSid, muted);
}

/** Disconnects everyone and ends the room (its recording, if any, stops with it). */
export async function closeRoom(room: string): Promise<void> {
  await roomService().deleteRoom(room);
}

function roomService(): RoomServiceClient {
  const { apiKey, apiSecret, serverUrl } = requireLiveKitEnv();
  return new RoomServiceClient(serverUrl, apiKey, apiSecret);
}

/**
 * Looks up the SID (connection id) LiveKit currently has on file for an identity in a room, or
 * null if that identity isn't present at all. Used by the demo's call page as a pull-based
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
// This process needs the real host path instead; this is the one place that mapping is defined.
const EGRESS_CONTAINER_RAW_DIR = '/out/raw';
export const EGRESS_HOST_RAW_DIR = process.env.EGRESS_RAW_DIR ?? path.join(__dirname, '..', '..', 'egress', 'raw');

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

// Speech for listening and transcription, not music: 24 kbps Opus is a fifth of egress's 128 kbps
// default. Egress encodes the mix anyway, so asking it for the final bitrate costs nothing extra
// (measured: same egress CPU at 24 as at 128) and leaves no second transcode to run afterwards.
const RECORDING_AUDIO_KBPS = Number(process.env.RECORDING_AUDIO_KBPS ?? 24);

// Serializes concurrent start requests for the same room onto one in-flight attempt, so two
// participants clicking "record" within the same tick can't each mint a separate egress session
// for the same room (the second would otherwise double-record and orphan itself -- nothing in
// the UI tracks more than one egressId per room).
const pendingStarts = new Map<string, Promise<RecordingInfo>>();

/**
 * Starts a single mixed-audio recording of every participant currently in the room. Tied to the
 * room's lifecycle -- LiveKit stops it automatically once the room empties, same as if /stop had
 * been called. The webhook lets us know the moment the file is finalized so it can be moved into
 * the finished-recordings directory without polling or guessing when Egress is done writing it.
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
      // disableManifest: otherwise egress also writes EG_<id>.json next to the audio, and it shows up
      // in the recordings list as a "raw" recording that can't be played.
      new EncodedFileOutput({
        fileType: EncodedFileType.OGG,
        filepath: path.posix.join(EGRESS_CONTAINER_RAW_DIR, filename),
        disableManifest: true,
      }),
      {
        // Leaving layout/customBaseUrl unset keeps this on egress's Chrome-free audio pipeline.
        audioOnly: true,
        encodingOptions: new EncodingOptions({ audioCodec: AudioCodec.OPUS, audioBitrate: RECORDING_AUDIO_KBPS }),
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

/** Every recording currently in progress, across all rooms. */
export async function listAllActiveRecordings(): Promise<RecordingInfo[]> {
  const { apiKey, apiSecret, serverUrl } = requireLiveKitEnv();
  const egress = new EgressClient(serverUrl, apiKey, apiSecret);
  const active = await egress.listEgress({ active: true });
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
