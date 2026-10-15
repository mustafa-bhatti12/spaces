'use client';

import { ConnectionQuality, DisconnectReason, ParticipantEvent, type Room, RoomEvent } from 'livekit-client';
import { useCallback, useEffect, useRef } from 'react';

/** What a browser reports about its side of a call; token-service writes it to `logs/calls-<day>.jsonl`. */
export type CallLog = (event: string, detail?: unknown) => void;

interface CallEvent {
  t: number;
  e: string;
  d?: unknown;
}

const FLUSH_EVERY_MS = 15_000;
const BATCH = 100;
/** Kept while offline; the oldest go first past this. */
const MAX_QUEUED = 500;

type NetworkInformation = EventTarget & { type?: string; effectiveType?: string; rtt?: number; downlink?: number; saveData?: boolean };
const network = () => (navigator as Navigator & { connection?: NetworkInformation }).connection;
const networkInfo = (n = network()) => n && { type: n.type, effectiveType: n.effectiveType, rtt: n.rtt, downlink: n.downlink, saveData: n.saveData };

/**
 * Records this browser's connection events for the call (connection state, disconnect reasons,
 * audio blocked, tab hidden/frozen, offline, network type) and posts them to `/api/call-log` in
 * batches; events from an outage are sent once the network is back. Returns `log` for the caller's
 * own events (the auto-rejoin). The browser console is muted in production, so this is the only
 * record of what a caller's device went through.
 */
export function useCallLog(room: Room, roomName: string, token: string, embedded: boolean): CallLog {
  const queue = useRef<CallEvent[]>([]);
  const log = useCallback<CallLog>((e, d) => {
    queue.current.push(d === undefined ? { t: Date.now(), e } : { t: Date.now(), e, d });
    if (queue.current.length > MAX_QUEUED) queue.current.splice(0, queue.current.length - MAX_QUEUED);
  }, []);

  useEffect(() => {
    let sending = false;
    const flush = (leaving: boolean) => {
      if (queue.current.length === 0) return;
      const events = queue.current.splice(0, BATCH);
      const body = JSON.stringify({ room: roomName, token, events });
      // The page may be going away: a beacon survives that, a fetch may not.
      if (leaving) {
        if (!navigator.sendBeacon?.('/api/call-log', new Blob([body], { type: 'application/json' }))) queue.current.unshift(...events);
        return;
      }
      if (sending) {
        queue.current.unshift(...events);
        return;
      }
      sending = true;
      fetch('/api/call-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
        .then((res) => {
          // A 4xx won't get better by resending; anything else (offline, 5xx) is tried again.
          if (!res.ok && res.status >= 500) queue.current.unshift(...events);
        })
        .catch(() => queue.current.unshift(...events))
        .finally(() => {
          sending = false;
        });
    };

    log('session', {
      ua: navigator.userAgent,
      embedded,
      visibility: document.visibilityState,
      online: navigator.onLine,
      network: networkInfo(),
    });

    const onState = (state: string) => log('state', state);
    const onConnected = () => log('joined', { sid: room.localParticipant.sid });
    const onDisconnected = (reason?: DisconnectReason) => log('disconnected', reason === undefined ? 'none' : DisconnectReason[reason]);
    const onPlayback = () => log('audio-playback', room.canPlaybackAudio ? 'allowed' : 'blocked');
    const onDeviceError = (err: Error) => log('media-error', err.message);
    const onQuality = (quality: ConnectionQuality) => log('quality', quality);
    room
      .on(RoomEvent.ConnectionStateChanged, onState)
      .on(RoomEvent.Connected, onConnected)
      .on(RoomEvent.Disconnected, onDisconnected)
      .on(RoomEvent.AudioPlaybackStatusChanged, onPlayback)
      .on(RoomEvent.MediaDevicesError, onDeviceError);
    room.localParticipant.on(ParticipantEvent.ConnectionQualityChanged, onQuality);

    const onVisibility = () => {
      log('visibility', document.visibilityState);
      if (document.visibilityState === 'hidden') flush(true);
    };
    const onFreeze = () => log('freeze');
    const onResume = () => log('resume');
    const onOnline = () => {
      log('online');
      flush(false);
    };
    const onOffline = () => log('offline');
    const onPageHide = (e: PageTransitionEvent) => {
      log('pagehide', { persisted: e.persisted });
      flush(true);
    };
    const onNetwork = () => log('network', networkInfo());
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('freeze', onFreeze);
    document.addEventListener('resume', onResume);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('pagehide', onPageHide);
    network()?.addEventListener('change', onNetwork);
    const timer = setInterval(() => flush(false), FLUSH_EVERY_MS);

    return () => {
      room
        .off(RoomEvent.ConnectionStateChanged, onState)
        .off(RoomEvent.Connected, onConnected)
        .off(RoomEvent.Disconnected, onDisconnected)
        .off(RoomEvent.AudioPlaybackStatusChanged, onPlayback)
        .off(RoomEvent.MediaDevicesError, onDeviceError);
      room.localParticipant.off(ParticipantEvent.ConnectionQualityChanged, onQuality);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('freeze', onFreeze);
      document.removeEventListener('resume', onResume);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('pagehide', onPageHide);
      network()?.removeEventListener('change', onNetwork);
      clearInterval(timer);
      log('ended');
      flush(true);
    };
  }, [room, roomName, token, embedded, log]);

  return log;
}
