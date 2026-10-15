'use client';

import type { LocalUserChoices } from '@livekit/components-react';
import { RoomContext, useSequentialRoomConnectDisconnect } from '@livekit/components-react';
import type { RemoteParticipant } from 'livekit-client';
import {
  ConnectionError,
  ConnectionErrorReason,
  ConnectionState,
  DisconnectReason,
  EngineEvent,
  ParticipantEvent,
  Room,
  RoomEvent,
  VideoPreset,
  VideoPresets,
} from 'livekit-client';
import { WifiOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { MIC_PROCESSING } from '@/lib/client/mic';
import { useEmbed } from '../embed/EmbedContext';
import { ConferenceLayout } from './ConferenceLayout';
import type { ConnectionDetails, LeaveReason } from './types';
import { useCallLog } from './useCallLog';

const DUPLICATE_CHECK_EVERY_MS = 5000;
/** How long we keep rejoining after LiveKit's own reconnect gives up (it tries for about 45 s first). */
const REJOIN_FOR_MS = 5 * 60_000;
const REJOIN_MAX_DELAY_MS = 10_000;
/**
 * Disconnects that mean the network or the server dropped us, not a person: LiveKit's reconnect
 * running out of attempts (no reason), the signal socket closing, a timeout, a server restart.
 */
const LOST_CONNECTION = new Set<DisconnectReason | undefined>([
  undefined,
  DisconnectReason.UNKNOWN_REASON,
  DisconnectReason.SERVER_SHUTDOWN,
  DisconnectReason.STATE_MISMATCH,
  DisconnectReason.JOIN_FAILURE,
  DisconnectReason.MIGRATION,
  DisconnectReason.SIGNAL_CLOSE,
  DisconnectReason.CONNECTION_TIMEOUT,
  DisconnectReason.MEDIA_FAILURE,
]);

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
  /** Rendered inside the RoomContext, next to the layout (the embed bridge). */
  children?: ReactNode;
}

/**
 * Owns the Room for one join. The Room is created once (useState initializer) and connected through
 * useSequentialRoomConnectDisconnect, so re-renders never reconnect — LiveKit's "don't remount
 * LiveKitRoom" guidance, applied to the RoomContext pattern.
 *
 * A dropped connection is rejoined on the same Room for up to REJOIN_FOR_MS (mic and camera as they
 * were), the way Meet keeps trying, instead of ending on the "disconnected" screen.
 */
export function Conference({ roomName, details, choices, identity, onLeave, children }: ConferenceProps) {
  const [room] = useState(
    () =>
      new Room({
        adaptiveStream: true,
        dynacast: true,
        // LiveKit would also disconnect on `beforeunload` (even when the leave prompt is then
        // cancelled) and on Android's `freeze` of a background tab (shown as "You left"). We leave on
        // `pagehide` only; a frozen tab's connection drops and is rejoined on its own.
        disconnectOnPageLeave: false,
        videoCaptureDefaults: {
          deviceId: choices.videoDeviceId || undefined,
          resolution: CAMERA_TOP.resolution,
        },
        audioCaptureDefaults: {
          deviceId: choices.audioDeviceId || undefined,
          ...MIC_PROCESSING,
        },
        publishDefaults: {
          simulcast: true,
          red: true,
          videoEncoding: CAMERA_TOP.encoding,
          videoSimulcastLayers: CAMERA_LAYERS,
        },
      }),
  );
  const { connect, disconnect } = useSequentialRoomConnectDisconnect(room);
  const log = useCallLog(room, roomName, details.participantToken, useEmbed() !== null);
  // Set just before we disconnect ourselves (duplicate identity) or end the room for everyone, so
  // the Disconnected event (CLIENT_INITIATED / ROOM_DELETED) is reported as what actually happened.
  const leavingAs = useRef<LeaveReason | null>(null);
  /** Attempt number while rejoining after a dropped connection; null while connected. */
  const [rejoining, setRejoining] = useState<number | null>(null);
  const stopRejoining = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    // For the end screen: how long we were in, and everyone we saw (us included).
    let connectedAt: number | null = null;
    let rejoinActive = false;
    const seen = new Set<string>([identity]);
    // The server refreshes our token during the call; a rejoin after the 2 h join TTL needs the fresh one.
    let token = details.participantToken;
    // Mic and camera as the user left them, to put back after a rejoin. Updated only while connected:
    // a disconnect unpublishes everything first.
    const media = { mic: choices.audioEnabled, cam: choices.videoEnabled };
    const lp = room.localParticipant;
    const trackMedia = () => {
      if (room.state !== ConnectionState.Connected) return;
      media.mic = lp.isMicrophoneEnabled;
      media.cam = lp.isCameraEnabled;
    };
    const publishMedia = () =>
      // Each is best-effort: a denied camera shouldn't keep someone out of the call.
      Promise.allSettled([
        media.mic ? lp.setMicrophoneEnabled(true) : undefined,
        media.cam ? lp.setCameraEnabled(true) : undefined,
      ]);
    const finish = (leave: LeaveReason) => {
      onLeave(connectedAt === null ? leave : { ...leave, summary: { durationMs: Date.now() - connectedAt, people: seen.size } });
    };

    const rejoin = async () => {
      rejoinActive = true;
      let stopped = false;
      let wake = () => {};
      stopRejoining.current = () => {
        stopped = true;
        wake();
        // Abandon an attempt in flight; its rejection brings the loop round to `stopped`.
        if (room.state === ConnectionState.Connecting) void room.disconnect();
      };
      // Waits `ms`, or less when the network comes back or the user gives up.
      const pause = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(done, ms);
          window.addEventListener('online', done);
          function done() {
            clearTimeout(timer);
            window.removeEventListener('online', done);
            resolve();
          }
          wake = done;
        });
      const until = Date.now() + REJOIN_FOR_MS;
      const end = (leave: LeaveReason) => {
        rejoinActive = false;
        stopRejoining.current = null;
        setRejoining(null);
        if (!cancelled) finish(leave);
      };
      for (let attempt = 1; ; attempt++) {
        if (cancelled) return;
        if (stopped) return end({ kind: 'left' });
        setRejoining(attempt);
        // No point dialling out while the device says it's offline; `online` wakes us.
        if (!navigator.onLine) {
          await pause(Math.max(0, until - Date.now()));
          if (cancelled) return;
          if (stopped) return end({ kind: 'left' });
          if (!navigator.onLine) return end({ kind: 'error', message: 'No internet connection.' });
        }
        log('rejoin', { attempt });
        try {
          await connect(details.serverUrl, token);
          if (cancelled) return;
          if (stopped) {
            await room.disconnect();
            return end({ kind: 'left' });
          }
          rejoinActive = false;
          stopRejoining.current = null;
          setRejoining(null);
          log('rejoined', { attempt });
          room.remoteParticipants.forEach((p) => seen.add(p.identity));
          await publishMedia();
          return;
        } catch (err) {
          if (cancelled) return;
          log('rejoin-failed', { attempt, error: (err as Error).message });
          // Refused outright (bad or long-expired token, removed): retrying won't change that.
          if (err instanceof ConnectionError && err.reason === ConnectionErrorReason.NotAllowed) {
            return end({ kind: 'error', message: err.message });
          }
        }
        const delay = Math.min(1000 * 2 ** (attempt - 1), REJOIN_MAX_DELAY_MS);
        if (Date.now() + delay > until) return end({ kind: 'error', message: 'Could not reconnect for 5 minutes.' });
        await pause(delay);
      }
    };

    const handleJoined = (p: RemoteParticipant) => seen.add(p.identity);
    const handleDisconnected = (reason?: DisconnectReason) => {
      // A failed rejoin attempt disconnects too; the loop already handles it.
      if (rejoinActive || cancelled) return;
      if (!leavingAs.current && connectedAt !== null && LOST_CONNECTION.has(reason)) {
        void rejoin();
        return;
      }
      finish(leavingAs.current ?? leaveReasonFor(reason));
    };
    // The engine is replaced on every rejoin, so follow it to keep hearing about refreshed tokens.
    let engine = room.engine;
    const handleToken = (fresh: string) => {
      token = fresh;
    };
    const followEngine = () => {
      if (room.engine === engine) return;
      engine.off(EngineEvent.TokenRefreshed, handleToken);
      engine = room.engine;
      engine.on(EngineEvent.TokenRefreshed, handleToken);
    };
    // Closing or navigating away: leave properly so others see us go now, not after a timeout.
    const handlePageHide = (e: PageTransitionEvent) => {
      if (e.persisted) return;
      leavingAs.current = { kind: 'left' };
      void room.disconnect();
    };
    room.on(RoomEvent.Disconnected, handleDisconnected);
    room.on(RoomEvent.ParticipantConnected, handleJoined);
    room.on(RoomEvent.SignalConnected, followEngine);
    engine.on(EngineEvent.TokenRefreshed, handleToken);
    lp.on(ParticipantEvent.TrackMuted, trackMedia)
      .on(ParticipantEvent.TrackUnmuted, trackMedia)
      .on(ParticipantEvent.LocalTrackPublished, trackMedia);
    window.addEventListener('pagehide', handlePageHide);

    connect(details.serverUrl, details.participantToken)
      .then(async () => {
        connectedAt = Date.now();
        room.remoteParticipants.forEach((p) => seen.add(p.identity));
        await publishMedia();
      })
      .catch((err: Error) => onLeave({ kind: 'error', message: err.message }));

    return () => {
      cancelled = true;
      stopRejoining.current?.();
      room.off(RoomEvent.Disconnected, handleDisconnected);
      room.off(RoomEvent.ParticipantConnected, handleJoined);
      room.off(RoomEvent.SignalConnected, followEngine);
      engine.off(EngineEvent.TokenRefreshed, handleToken);
      lp.off(ParticipantEvent.TrackMuted, trackMedia)
        .off(ParticipantEvent.TrackUnmuted, trackMedia)
        .off(ParticipantEvent.LocalTrackPublished, trackMedia);
      window.removeEventListener('pagehide', handlePageHide);
      disconnect();
    };
  }, [room, connect, disconnect, details, choices, identity, onLeave, log]);

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
      {rejoining !== null && (
        // Over the whole call (dock included): while disconnected, Leave has to stop the retries.
        <div className="rejoin-overlay" role="alertdialog" aria-labelledby="rejoin-title" aria-describedby="rejoin-text">
          <section className="face end-face">
            <span className="end-icon end-icon-warn" aria-hidden="true">
              <WifiOff />
            </span>
            <h1 id="rejoin-title" className="title">Connection lost</h1>
            <p id="rejoin-text" className="lede">
              Reconnecting you to the call…{rejoining > 1 && <span className="mono"> (try {rejoining})</span>}
            </p>
            <div className="end-actions">
              <button type="button" className="key" onClick={() => stopRejoining.current?.()}>
                Leave call
              </button>
            </div>
          </section>
        </div>
      )}
      {children}
    </RoomContext.Provider>
  );
}
