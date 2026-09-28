'use client';

import type { LocalUserChoices } from '@livekit/components-react';
import { RoomContext, useSequentialRoomConnectDisconnect } from '@livekit/components-react';
import type { RemoteParticipant } from 'livekit-client';
import { DisconnectReason, Room, RoomEvent, VideoPreset, VideoPresets } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConferenceLayout } from './ConferenceLayout';
import type { ConnectionDetails, LeaveReason } from './types';

const DUPLICATE_CHECK_EVERY_MS = 5000;

// Audio first: the SDK already sends the mic at RTCRtpEncodingParameters priority 'high'; marking the
// camera 'very-low' makes the browser's bitrate allocator starve video before audio (Chrome reads a
// sender's priority from its first encoding, which the SDK sets; Firefox honours it per layer). The top
// layer is 540p (not 720p) so a weak uplink has less to shed. Screen share keeps its own encoding.
const audioFirst = (p: VideoPreset) => new VideoPreset(p.width, p.height, p.encoding.maxBitrate, p.encoding.maxFramerate, 'very-low');
const CAMERA_TOP = audioFirst(VideoPresets.h540);
const CAMERA_LAYERS = [VideoPresets.h180, VideoPresets.h360].map(audioFirst);

function leaveReasonFor(reason: DisconnectReason | undefined): LeaveReason {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
      return { kind: 'left' };
    case DisconnectReason.DUPLICATE_IDENTITY:
      return { kind: 'duplicate' };
    case DisconnectReason.PARTICIPANT_REMOVED:
      return { kind: 'removed' };
    case DisconnectReason.ROOM_DELETED:
      return { kind: 'room-closed' };
    default:
      return { kind: 'error', message: reason === undefined ? undefined : `Reason: ${DisconnectReason[reason]}` };
  }
}

interface ConferenceProps {
  roomName: string;
  details: ConnectionDetails;
  choices: LocalUserChoices;
  identity: string;
  onLeave: (reason: LeaveReason) => void;
}

/**
 * Owns the Room for one join. The Room is created once (useState initializer) and connected through
 * useSequentialRoomConnectDisconnect, so re-renders never reconnect — LiveKit's "don't remount
 * LiveKitRoom" guidance, applied to the RoomContext pattern.
 */
export function Conference({ roomName, details, choices, identity, onLeave }: ConferenceProps) {
  const [room] = useState(
    () =>
      new Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
          deviceId: choices.videoDeviceId || undefined,
          resolution: CAMERA_TOP.resolution,
        },
        audioCaptureDefaults: { deviceId: choices.audioDeviceId || undefined },
        publishDefaults: {
          simulcast: true,
          red: true,
          videoEncoding: CAMERA_TOP.encoding,
          videoSimulcastLayers: CAMERA_LAYERS,
        },
      }),
  );
  const { connect, disconnect } = useSequentialRoomConnectDisconnect(room);
  // Set just before we disconnect ourselves (duplicate identity) or end the room for everyone, so
  // the Disconnected event (CLIENT_INITIATED / ROOM_DELETED) is reported as what actually happened.
  const leavingAs = useRef<LeaveReason | null>(null);

  useEffect(() => {
    // For the end screen: how long we were in, and everyone we saw (us included).
    let connectedAt: number | null = null;
    const seen = new Set<string>([identity]);
    const handleJoined = (p: RemoteParticipant) => seen.add(p.identity);
    const handleDisconnected = (reason?: DisconnectReason) => {
      const leave = leavingAs.current ?? leaveReasonFor(reason);
      onLeave(connectedAt === null ? leave : { ...leave, summary: { durationMs: Date.now() - connectedAt, people: seen.size } });
    };
    room.on(RoomEvent.Disconnected, handleDisconnected);
    room.on(RoomEvent.ParticipantConnected, handleJoined);

    connect(details.serverUrl, details.participantToken)
      .then(async () => {
        connectedAt = Date.now();
        room.remoteParticipants.forEach((p) => seen.add(p.identity));
        // Each is best-effort: a denied camera shouldn't keep someone out of the call.
        await Promise.allSettled([
          choices.audioEnabled ? room.localParticipant.setMicrophoneEnabled(true) : undefined,
          choices.videoEnabled ? room.localParticipant.setCameraEnabled(true) : undefined,
        ]);
      })
      .catch((err: Error) => onLeave({ kind: 'error', message: err.message }));

    return () => {
      room.off(RoomEvent.Disconnected, handleDisconnected);
      room.off(RoomEvent.ParticipantConnected, handleJoined);
      disconnect();
    };
  }, [room, connect, disconnect, details, choices, identity, onLeave]);

  // Joining again from this browser (same identity) replaces the earlier connection; LiveKit's push
  // to the losing side wasn't observed arriving promptly, so poll who LiveKit thinks we are.
  useEffect(() => {
    const timer = setInterval(async () => {
      if (room.state !== 'connected') return;
      try {
        const res = await fetch(
          `/api/whoami?room=${encodeURIComponent(roomName)}&identity=${encodeURIComponent(identity)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const { sid } = (await res.json()) as { sid: string | null };
        if (sid && room.localParticipant.sid && sid !== room.localParticipant.sid) {
          leavingAs.current = { kind: 'duplicate' };
          await room.disconnect();
        }
      } catch {
        // transient network error: try again next tick
      }
    }, DUPLICATE_CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [room, roomName, identity, onLeave]);

  // Hosts only: token-service deletes the room, and LiveKit disconnects everyone (us included).
  const endForAll = useCallback(async () => {
    leavingAs.current = { kind: 'ended' };
    try {
      const res = await fetch('/api/rooms/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: roomName, token: details.participantToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Could not end the call (HTTP ${res.status}).`);
    } catch (err) {
      leavingAs.current = null;
      throw err;
    }
  }, [roomName, details.participantToken]);

  return (
    <RoomContext.Provider value={room}>
      <ConferenceLayout roomName={roomName} joinToken={details.participantToken} onEndForAll={endForAll} />
    </RoomContext.Provider>
  );
}
