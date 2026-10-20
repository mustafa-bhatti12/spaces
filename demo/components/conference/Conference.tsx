'use client';

import type { LocalUserChoices } from '@livekit/components-react';
import { RoomContext, useSequentialRoomConnectDisconnect } from '@livekit/components-react';
import type { ReconnectPolicy, RemoteParticipant, RoomConnectOptions } from 'livekit-client';
import {
  AudioPresets,
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
import { DEFAULT_CALL_SETTINGS } from '@/lib/callSettings';
import { useEmbed } from '../embed/EmbedContext';
import { ConferenceLayout } from './ConferenceLayout';
import type { ConnectionDetails, LeaveReason } from './types';
import type { CallStats } from './callStats';
import { type CallLog, useCallLog } from './useCallLog';
import { useAdaptiveMedia, type AdaptiveMediaStatsHandler } from './useAdaptiveMedia';

const DUPLICATE_CHECK_EVERY_MS = 5000;
/** How long we keep rejoining after LiveKit's own reconnect gives up (see RESUME_POLICY). */
const REJOIN_FOR_MS = 5 * 60_000;
const REJOIN_MAX_DELAY_MS = 10_000;

/**
 * LiveKit asks this policy after each failed resume and cannot cancel one already in progress.
 * Start no new attempts after the first 10s; the SDK's 15s peer-connection timeout can finish the
 * last attempt, so its own reconnect gives up within about 25s and our overlay/rejoin loop takes over.
 * The default policy (10 tries, up to ~45 s) let a caller sit in `signalReconnecting` for minutes
 * (a Firefox client: 2.5 min) behind no overlay; the rejoin loop shows one, is woken by `online`,
 * and can switch to relay.
 */
const RESUME_RETRY_WINDOW_MS = 10_000;
const RESUME_DELAYS_MS = [0, 300, 1200, 2700, 4800, 7000, 7000];
const RESUME_POLICY: ReconnectPolicy = {
  nextRetryDelayInMs: ({ retryCount, elapsedMs }) => {
    const delay = RESUME_DELAYS_MS[retryCount];
    return delay === undefined || elapsedMs + delay > RESUME_RETRY_WINDOW_MS ? null : delay;
  },
};

/**
 * Relay-only rejoin. Mobile carriers in the UAE (du, Etisalat) were seen stalling UDP for seconds
 * at a time (RTT spikes of 2–13 s, then drops), which TURN over TLS on 443 rides out: to the
 * carrier it looks like HTTPS. Configured repeated-drop and RTT thresholds switch later rejoins
 * to `iceTransportPolicy: 'relay'`; LiveKit supplies its own TURN servers, including
 * turn.hof-global.com:443 TLS. A slow-but-alive call is not dropped on purpose; the next natural
 * drop uses relay.
 */
const RELAY_DROP_WINDOW_MS = 5 * 60_000;
const RELAY_CONNECT: RoomConnectOptions = { rtcConfig: { iceTransportPolicy: 'relay' } };
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

// Audio first: the SDK sends the mic at priority 'high'; marking camera layers 'very-low' makes
// browser bitrate allocators shed video before audio. Normal capture is h540; adaptive mode scales
// the sender's top layer to the configured low height.
const audioFirst = (p: VideoPreset) => new VideoPreset(p.width, p.height, p.encoding.maxBitrate, p.encoding.maxFramerate, 'very-low');
const CAMERA_TOP = audioFirst(VideoPresets.h540);
const CAMERA_LAYERS = [audioFirst(VideoPresets.h180), audioFirst(VideoPresets.h360)];

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
  const callSettings = details.callSettings ?? DEFAULT_CALL_SETTINGS;
  const [room] = useState(
    () =>
      new Room({
        adaptiveStream: true,
        dynacast: true,
        reconnectPolicy: RESUME_POLICY,
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
          audioPreset: AudioPresets[callSettings.micPreset],
          dtx: true,
          red: callSettings.red,
          simulcast: true,
          videoEncoding: CAMERA_TOP.encoding,
          videoSimulcastLayers: CAMERA_LAYERS,
        },
      }),
  );
  const { connect, disconnect } = useSequentialRoomConnectDisconnect(room);
  const adaptiveStats = useRef<AdaptiveMediaStatsHandler | undefined>(undefined);
  const relayOnly = useRef(false);
  const highRttSamples = useRef(0);
  const rejoinStarts = useRef<number[]>([]);
  const enableRelay = useCallback((reason: string, log: CallLog) => {
    if (!callSettings.relayFallback || relayOnly.current) return;
    relayOnly.current = true;
    log('relay', { reason });
  }, [callSettings.relayFallback]);
  const onStats = useCallback((stats: CallStats, log: CallLog) => {
    if ((stats.path === 'udp' || stats.path === 'tcp') && stats.rttMs !== null && stats.rttMs > callSettings.relayRttMs) {
      highRttSamples.current += 1;
      if (highRttSamples.current >= 2) enableRelay('high-rtt', log);
    } else {
      highRttSamples.current = 0;
    }
    adaptiveStats.current?.(stats);
  }, [callSettings.relayRttMs, enableRelay]);
  const log = useCallLog(
    room,
    roomName,
    details.participantToken,
    useEmbed() !== null,
    onStats,
    callSettings.statsIntervalSec,
  );
  useAdaptiveMedia(room, log, adaptiveStats, callSettings);
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
      const now = Date.now();
      const recent = rejoinStarts.current.filter((at) => now - at < RELAY_DROP_WINDOW_MS);
      recent.push(now);
      rejoinStarts.current = recent;
      if (recent.length >= callSettings.relayDrops) enableRelay('repeated-rejoins', log);
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
          await connect(details.serverUrl, token, relayOnly.current ? RELAY_CONNECT : undefined);
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
    const resetHighRttSamples = () => {
      highRttSamples.current = 0;
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
    room
      .on(RoomEvent.Disconnected, handleDisconnected)
      .on(RoomEvent.Connected, resetHighRttSamples)
      .on(RoomEvent.Reconnected, resetHighRttSamples)
      .on(RoomEvent.ParticipantConnected, handleJoined)
      .on(RoomEvent.SignalConnected, followEngine);
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
      room
        .off(RoomEvent.Disconnected, handleDisconnected)
        .off(RoomEvent.Connected, resetHighRttSamples)
        .off(RoomEvent.Reconnected, resetHighRttSamples)
        .off(RoomEvent.ParticipantConnected, handleJoined)
        .off(RoomEvent.SignalConnected, followEngine);
      lp.off(ParticipantEvent.TrackMuted, trackMedia)
        .off(ParticipantEvent.TrackUnmuted, trackMedia)
        .off(ParticipantEvent.LocalTrackPublished, trackMedia);
      window.removeEventListener('pagehide', handlePageHide);
      disconnect();
    };
  }, [room, connect, disconnect, details, choices, identity, onLeave, log, enableRelay, callSettings.relayDrops]);

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
