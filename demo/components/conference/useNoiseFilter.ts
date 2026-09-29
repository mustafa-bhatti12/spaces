'use client';

import { useLocalParticipant } from '@livekit/components-react';
import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import { LocalAudioTrack, type AudioProcessorOptions, type Track, type TrackProcessor } from 'livekit-client';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

const PREF_KEY = 'spaces-noise-filter';
const CHANGE_EVENT = 'spaces-noise-filter-change';
const PROCESSOR_NAME = 'rnnoise';
// Copied from @sapphi-red/web-noise-suppressor into public/rnnoise by next.config.ts.
const ASSETS = '/rnnoise';

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

// One fetch per page; a failed one is retried on the next attempt.
let wasmBinary: Promise<ArrayBuffer> | undefined;
function loadWasm(): Promise<ArrayBuffer> {
  wasmBinary ??= loadRnnoise({ url: `${ASSETS}/rnnoise.wasm`, simdUrl: `${ASSETS}/rnnoise_simd.wasm` }).catch(
    (err: unknown) => {
      wasmBinary = undefined;
      throw err;
    },
  );
  return wasmBinary;
}

/**
 * RNNoise (xiph/rnnoise in an AudioWorklet) between the mic and the sender. It works in 10 ms frames
 * at 48 kHz, so it runs in its own 48 kHz AudioContext rather than LiveKit's (which follows the
 * device rate, often 44.1 kHz on Macs). LiveKit calls restart() with the new track on a device switch.
 */
class RnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = PROCESSOR_NAME;
  processedTrack?: MediaStreamTrack;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private node?: RnnoiseWorkletNode;

  async init({ track }: AudioProcessorOptions) {
    const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.context = context;
    try {
      const [binary] = await Promise.all([loadWasm(), context.audioWorklet.addModule(`${ASSETS}/workletProcessor.js`)]);
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const node = new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary: binary });
      node.channelCount = 1;
      node.channelCountMode = 'explicit';
      const destination = context.createMediaStreamDestination();
      source.connect(node).connect(destination);
      this.source = source;
      this.node = node;
      this.processedTrack = destination.stream.getAudioTracks()[0];
      // The join click already gave the page user activation, so this resolves at once.
      void context.resume().catch(() => {});
    } catch (err) {
      await this.destroy();
      throw err;
    }
  }

  async restart(opts: AudioProcessorOptions) {
    await this.destroy();
    await this.init(opts);
  }

  async destroy() {
    this.source?.disconnect();
    this.node?.disconnect();
    this.node?.destroy();
    this.processedTrack?.stop();
    await this.context?.close().catch(() => {});
    this.source = this.node = this.processedTrack = this.context = undefined;
  }
}

export interface NoiseFilterControls {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  applying: boolean;
  error: string;
  supported: boolean;
}

/**
 * Noise cancellation on the local mic: RNNoise as the mic track's LiveKit processor, so everyone
 * hears, and the recording captures, the filtered audio. Off until Settings → Microphone → Noise
 * cancellation is on. The browser's echo cancellation, noise suppression and auto gain run either
 * way (`lib/client/mic.ts`). Lives at the conference level so it survives closing Settings; LiveKit
 * keeps the processor across device switches and mute.
 */
export function useNoiseFilter(): NoiseFilterControls {
  const { microphoneTrack } = useLocalParticipant();
  const enabled = useSyncExternalStore(subscribe, read, () => false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [supported] = useState(
    () => typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly !== 'undefined',
  );
  const track = microphoneTrack?.track instanceof LocalAudioTrack ? microphoneTrack.track : undefined;

  const setEnabled = useCallback((next: boolean) => {
    localStorage.setItem(PREF_KEY, next ? 'on' : 'off');
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  useEffect(() => {
    if (!supported || !track) return;
    const active = track.getProcessor()?.name === PROCESSOR_NAME;
    if (enabled === active) return;
    let cancelled = false;
    setApplying(true);
    setError('');
    const change = enabled ? track.setProcessor(new RnnoiseProcessor()) : track.stopProcessor();
    change
      .catch(async (err: Error) => {
        // A half-initialised processor would leave the mic silent; fall back to the plain mic.
        if (enabled) await track.stopProcessor().catch(() => {});
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
