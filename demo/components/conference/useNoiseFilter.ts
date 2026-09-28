'use client';

import { useLocalParticipant } from '@livekit/components-react';
import { LocalAudioTrack } from 'livekit-client';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

const PREF_KEY = 'spaces-noise-filter';
const CHANGE_EVENT = 'spaces-noise-filter-change';

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

// Off until someone turns it on. An explicit choice is remembered per browser.
function read(): boolean {
  return localStorage.getItem(PREF_KEY) === 'on';
}

export interface NoiseFilterControls {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  applying: boolean;
  error: string;
  supported: boolean;
}

/**
 * Noise cancellation on the local mic: Chrome's Voice isolation constraint, off until Settings
 * → Microphone → Noise cancellation is on. Echo cancellation and ordinary noiseSuppression stay
 * on either way. No AudioWorklet processor — DeepFilterNet3 added delay and chewed speech.
 */
export function useNoiseFilter(): NoiseFilterControls {
  const { microphoneTrack } = useLocalParticipant();
  const enabled = useSyncExternalStore(subscribe, read, () => false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [supported] = useState(
    () => 'voiceIsolation' in (navigator.mediaDevices?.getSupportedConstraints?.() ?? {}),
  );
  const track = microphoneTrack?.track instanceof LocalAudioTrack ? microphoneTrack.track : undefined;

  const setEnabled = useCallback((next: boolean) => {
    localStorage.setItem(PREF_KEY, next ? 'on' : 'off');
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  useEffect(() => {
    if (!supported || !track) return;
    // A leftover DeepFilterNet3 processor (from before we dropped it) would still delay the mic.
    if (track.getProcessor()) void track.stopProcessor().catch(() => {});
    let cancelled = false;
    setApplying(true);
    setError('');
    void track
      .applyConstraints({ voiceIsolation: enabled })
      .catch((err: Error) => {
        if (!cancelled) setError(`Noise cancellation couldn't start: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setApplying(false);
      });
    return () => {
      cancelled = true;
    };
  }, [supported, track, enabled]);

  return { enabled, setEnabled, applying, error, supported };
}
