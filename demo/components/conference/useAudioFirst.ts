'use client';

import { useConnectionQualityIndicator, useLocalParticipant } from '@livekit/components-react';
import { ConnectionQuality, Track } from 'livekit-client';
import { useEffect, useRef } from 'react';

/** How long the link must stay weak before the camera pauses, and good before it comes back. */
const PAUSE_AFTER_MS = 10_000;
const RESUME_AFTER_MS = 10_000;

/**
 * Audio first on a weak uplink. Under bandwidth pressure the browser already drops the camera's
 * higher simulcast layers (they're marked 'very-low' priority, the mic 'high'), but it never stops
 * the lowest one, which keeps competing with the mic. So once LiveKit rates this participant's
 * connection Poor (or Lost) for PAUSE_AFTER_MS, sending pauses; once it's back to Good for
 * RESUME_AFTER_MS, sending resumes. pauseUpstream deliberately keeps the camera track alive:
 * recreating an iOS camera track after recovery can retain stale portrait/landscape metadata and
 * display a sideways, stretched frame.
 *
 * The subscriber side needs nothing here; the SFU's congestion control (allow_pause,
 * livekit/config.yaml) pauses video for a struggling viewer on its own.
 */
export function useAudioFirst(notify: (message: string) => void) {
  const { localParticipant } = useLocalParticipant();
  const { quality } = useConnectionQualityIndicator({ participant: localParticipant });
  const pausedByUs = useRef(false);

  useEffect(() => {
    const weak = quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost;
    const good = quality === ConnectionQuality.Good || quality === ConnectionQuality.Excellent;

    if (weak && !pausedByUs.current) {
      const timer = setTimeout(async () => {
        const camera = localParticipant.getTrackPublication(Track.Source.Camera);
        if (!localParticipant.isCameraEnabled || !camera || camera.isMuted || camera.isUpstreamPaused) return;
        try {
          await camera.pauseUpstream();
          pausedByUs.current = true;
          notify('Weak connection. Sending video is paused to keep your audio clear.');
        } catch {
          pausedByUs.current = false;
        }
      }, PAUSE_AFTER_MS);
      return () => clearTimeout(timer);
    }

    if (good && pausedByUs.current) {
      const timer = setTimeout(async () => {
        if (!pausedByUs.current) return;
        const camera = localParticipant.getTrackPublication(Track.Source.Camera);
        if (!camera) {
          pausedByUs.current = false;
          return;
        }
        try {
          await camera.resumeUpstream();
          pausedByUs.current = false;
          if (localParticipant.isCameraEnabled && !camera.isMuted) {
            notify('Connection recovered. Your video is back on.');
          }
        } catch {
          // Keep the flag so a later quality update can retry without recreating the camera track.
        }
      }, RESUME_AFTER_MS);
      return () => clearTimeout(timer);
    }
  }, [quality, localParticipant, notify]);
}
