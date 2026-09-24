'use client';

import type { LocalUserChoices } from '@livekit/components-react';
import { RoomContext, useSequentialRoomConnectDisconnect } from '@livekit/components-react';
import { DisconnectReason, Room, RoomEvent, VideoPresets } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { ConferenceLayout } from './ConferenceLayout';
import type { ConnectionDetails, LeaveReason } from './types';

const DUPLICATE_CHECK_EVERY_MS = 5000;

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
          resolution: VideoPresets.h720.resolution,
        },
        audioCaptureDefaults: { deviceId: choices.audioDeviceId || undefined },
        publishDefaults: { simulcast: true, red: true },
      }),
  );
  const { connect, disconnect } = useSequentialRoomConnectDisconnect(room);
  // Set just before we disconnect ourselves for a duplicate identity, so the Disconnected event
  // (reason CLIENT_INITIATED) is reported as what actually happened.
  const leavingAsDuplicate = useRef(false);

  useEffect(() => {
    const handleDisconnected = (reason?: DisconnectReason) =>
      onLeave(leavingAsDuplicate.current ? { kind: 'duplicate' } : leaveReasonFor(reason));
    room.on(RoomEvent.Disconnected, handleDisconnected);

    connect(details.serverUrl, details.participantToken)
      .then(async () => {
        // Each is best-effort: a denied camera shouldn't keep someone out of the call.
        await Promise.allSettled([
          choices.audioEnabled ? room.localParticipant.setMicrophoneEnabled(true) : undefined,
          choices.videoEnabled ? room.localParticipant.setCameraEnabled(true) : undefined,
        ]);
      })
      .catch((err: Error) => onLeave({ kind: 'error', message: err.message }));

    return () => {
      room.off(RoomEvent.Disconnected, handleDisconnected);
      disconnect();
    };
  }, [room, connect, disconnect, details, choices, onLeave]);

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
          leavingAsDuplicate.current = true;
          await room.disconnect();
        }
      } catch {
        // transient network error: try again next tick
      }
    }, DUPLICATE_CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [room, roomName, identity, onLeave]);

  return (
    <RoomContext.Provider value={room}>
      <ConferenceLayout roomName={roomName} />
    </RoomContext.Provider>
  );
}
