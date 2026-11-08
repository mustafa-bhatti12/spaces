'use client';

import { ConnectionState, RoomEvent, Track, type LocalTrackPublication, type Room } from 'livekit-client';
import { useEffect } from 'react';
import type { CallLog } from './useCallLog';

/**
 * Phones and tablets end a call quietly when left alone: the screen locks (iOS after 30 s–2 min)
 * and takes the page, the mic and the socket with it; and coming back, iOS and Samsung Internet
 * often hand back a mic track that has `ended` or stays `muted`, so the others hear nothing.
 *
 * - Holds a screen wake lock while connected (Safari 16.4+, Chrome/Samsung). The browser drops it
 *   whenever the page hides, so it's requested again on every return.
 * - On every return (`visibilitychange` → visible, `pageshow` from the back/forward cache), restarts
 *   a mic or camera the user had on whose track is no longer live. LiveKit does this itself only when
 *   its `isMobile()` matches the user agent, which misses iPadOS (it reports a Mac).
 */
export function useCallKeepAlive(room: Room, log: CallLog): void {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let wanted = false;

    const acquireLock = async () => {
      if (!wanted || lock || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
      try {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => {
          lock = null;
        });
      } catch {
        // Low battery mode, a policy, or no user activation yet: the advice text still applies.
      }
    };
    const releaseLock = () => {
      wanted = false;
      void lock?.release().catch(() => {});
      lock = null;
    };

    const revive = (publication: LocalTrackPublication | undefined, source: 'mic' | 'camera') => {
      const track = publication?.track;
      // Only what the user had on: a muted publication is a choice, not a failure.
      if (!track || publication.isMuted) return;
      const media = track.mediaStreamTrack;
      if (media.readyState === 'live' && !media.muted) return;
      log('media-revive', { source, state: media.readyState, muted: media.muted });
      void track.restartTrack().catch((err: Error) => log('media-revive-failed', { source, error: err.message }));
    };
    const onReturn = () => {
      if (document.visibilityState !== 'visible' || room.state !== ConnectionState.Connected) return;
      void acquireLock();
      const lp = room.localParticipant;
      revive(lp.getTrackPublication(Track.Source.Microphone), 'mic');
      revive(lp.getTrackPublication(Track.Source.Camera), 'camera');
    };
    const onConnected = () => {
      wanted = true;
      void acquireLock();
    };

    room.on(RoomEvent.Connected, onConnected).on(RoomEvent.Reconnected, onConnected).on(RoomEvent.Disconnected, releaseLock);
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('pageshow', onReturn);
    if (room.state === ConnectionState.Connected) onConnected();
    return () => {
      room.off(RoomEvent.Connected, onConnected).off(RoomEvent.Reconnected, onConnected).off(RoomEvent.Disconnected, releaseLock);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('pageshow', onReturn);
      releaseLock();
    };
  }, [room, log]);
}
