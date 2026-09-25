'use client';

import { useConnectionQualityIndicator, useLocalParticipant } from '@livekit/components-react';
import type { TrackPublication } from 'livekit-client';
import { ConnectionQuality, ParticipantEvent, Track } from 'livekit-client';
import { useEffect, useRef } from 'react';

/** How long the link must stay weak before the camera pauses, and good before it comes back. */
const PAUSE_AFTER_MS = 10_000;
const RESUME_AFTER_MS = 10_000;

/**
 * Audio first on a weak uplink. Under bandwidth pressure the browser already drops the camera's
 * higher simulcast layers (they're marked 'very-low' priority, the mic 'high'), but it never stops
 * the lowest one, which keeps competing with the mic. So once LiveKit rates this participant's
 * connection Poor (or Lost) for PAUSE_AFTER_MS, the camera pauses; once it's back to Good for
 * RESUME_AFTER_MS, the camera resumes, if we were the ones who paused it.
 *
 * Turning the camera back on by hand while still weak wins: it isn't paused again until the link
 * has recovered once. The subscriber side needs nothing here; the SFU's congestion control
 * (allow_pause, livekit/config.yaml) pauses video for a struggling viewer on its own.
 */
export function useAudioFirst(notify: (message: string) => void) {
  const { localParticipant } = useLocalParticipant();
  const { quality } = useConnectionQualityIndicator({ participant: localParticipant });
  const pausedByUs = useRef(false);
  const userOverride = useRef(false);

  useEffect(() => {
    const onUnmuted = (publication: TrackPublication) => {
      if (publication.source !== Track.Source.Camera || !pausedByUs.current) return;
      pausedByUs.current = false;
      userOverride.current = true;
    };
    localParticipant.on(ParticipantEvent.TrackUnmuted, onUnmuted);
    return () => {
      localParticipant.off(ParticipantEvent.TrackUnmuted, onUnmuted);
    };
  }, [localParticipant]);

  useEffect(() => {
    const weak = quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost;
    const good = quality === ConnectionQuality.Good || quality === ConnectionQuality.Excellent;

    if (weak && !pausedByUs.current && !userOverride.current) {
      const timer = setTimeout(async () => {
        if (!localParticipant.isCameraEnabled) return;
        pausedByUs.current = true;
        try {
          await localParticipant.setCameraEnabled(false);
          notify('Weak connection. Your video is paused to keep your audio clear.');
        } catch {
          pausedByUs.current = false;
        }
      }, PAUSE_AFTER_MS);
      return () => clearTimeout(timer);
    }

    if (good && (pausedByUs.current || userOverride.current)) {
      const timer = setTimeout(async () => {
        userOverride.current = false;
        if (!pausedByUs.current) return;
        pausedByUs.current = false;
        if (localParticipant.isCameraEnabled) return;
        try {
          await localParticipant.setCameraEnabled(true);
          notify('Connection recovered. Your video is back on.');
        } catch {
          // camera unavailable now; the user can turn it on from the dock
        }
      }, RESUME_AFTER_MS);
      return () => clearTimeout(timer);
    }
  }, [quality, localParticipant, notify]);
}
