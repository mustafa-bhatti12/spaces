'use client';

import { useLocalParticipant } from '@livekit/components-react';
import { DeepFilterNoiseFilter, DeepFilterNoiseFilterProcessor } from 'deepfilternet3-noise-filter';
import { LocalAudioTrack } from 'livekit-client';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

const PREF_KEY = 'spaces-noise-filter';
const CHANGE_EVENT = 'spaces-noise-filter-change';
/** 0–100; how hard DeepFilterNet3 attenuates what it classes as noise. */
const SUPPRESSION_LEVEL = 80;
// Served from our own origin (the package defaults to the author's CDN): pinned, and reachable on
// networks and embedding pages that block third-party hosts. The package appends v3/pkg/df_bg.wasm
// and v3/models/DeepFilterNet3_onnx.tar.gz; both are committed under public/deepfilternet3/.
const ASSETS = { cdnUrl: '/deepfilternet3' };

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
 * Noise cancellation on the local mic: DeepFilterNet3 (WebAssembly in an AudioWorklet, via
 * deepfilternet3-noise-filter) as the mic track's LiveKit processor, so everyone hears, and the
 * recording captures, the filtered audio. Runs in each browser; no server cost. Lives at the
 * conference level so it survives closing Settings; LiveKit keeps the processor across device
 * switches and mute (mute disables the source track, so the filter outputs silence).
 */
export function useNoiseFilter(): NoiseFilterControls {
  const { microphoneTrack } = useLocalParticipant();
  const enabled = useSyncExternalStore(subscribe, read, () => false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [supported] = useState(
    () => DeepFilterNoiseFilterProcessor.isSupported() && typeof AudioWorkletNode !== 'undefined',
  );
  const track = microphoneTrack?.track instanceof LocalAudioTrack ? microphoneTrack.track : undefined;

  const setEnabled = useCallback((next: boolean) => {
    localStorage.setItem(PREF_KEY, next ? 'on' : 'off');
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  useEffect(() => {
    if (!track) return;
    // Capture defaults leave this off; turn Chrome's Voice isolation on only with the switch.
    void track.applyConstraints({ voiceIsolation: enabled }).catch(() => {});
    if (!supported) return;
    const active = track.getProcessor() instanceof DeepFilterNoiseFilterProcessor;
    if (enabled === active) return;
    let cancelled = false;
    setApplying(true);
    setError('');
    const change = enabled
      ? track.setProcessor(DeepFilterNoiseFilter({ noiseReductionLevel: SUPPRESSION_LEVEL, assetConfig: ASSETS }))
      : track.stopProcessor();
    change
      .catch(async (err: Error) => {
        // A half-initialised processor would leave the mic silent; fall back to the plain mic.
        if (enabled) await track.stopProcessor().catch(() => {});
        if (!cancelled) setError(`Noise cancellation couldn't start: ${err.message}`);
      })
      .finally(() => setApplying(false));
    return () => {
      cancelled = true;
    };
  }, [supported, track, enabled]);

  return { enabled, setEnabled, applying, error, supported };
}
