'use client';

import { useLocalParticipant } from '@livekit/components-react';
import {
  BackgroundProcessor,
  type BackgroundProcessorWrapper,
  supportsBackgroundProcessors,
} from '@livekit/track-processors';
import { LocalVideoTrack, Track } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';

export type BackgroundEffect =
  | { id: 'none' }
  | { id: 'blur-light' | 'blur-strong'; blurRadius: number }
  | { id: string; imagePath: string };

export const BACKGROUND_EFFECTS: { effect: BackgroundEffect; label: string; preview?: string }[] = [
  { effect: { id: 'none' }, label: 'None' },
  { effect: { id: 'blur-light', blurRadius: 8 }, label: 'Blur' },
  { effect: { id: 'blur-strong', blurRadius: 20 }, label: 'Strong blur' },
  ...['ocean', 'sunset', 'forest', 'studio'].map((name) => ({
    effect: { id: name, imagePath: `/backgrounds/${name}.jpg` },
    label: name[0].toUpperCase() + name.slice(1),
    preview: `/backgrounds/${name}.jpg`,
  })),
];

export interface BackgroundEffectControls {
  effect: BackgroundEffect;
  setEffect: (effect: BackgroundEffect) => void;
  applying: boolean;
  error: string;
  supported: boolean;
  cameraOn: boolean;
}

/**
 * Background blur / virtual background on the local camera, via @livekit/track-processors (runs in
 * the browser; no server cost). Lives at the conference level, not in the settings modal, so the
 * choice survives closing the modal and is re-applied whenever the camera track is replaced
 * (device switch, camera off/on).
 */
export function useBackgroundEffect(): BackgroundEffectControls {
  const { localParticipant, cameraTrack } = useLocalParticipant();
  const [effect, setEffect] = useState<BackgroundEffect>({ id: 'none' });
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const processorRef = useRef<BackgroundProcessorWrapper | null>(null);
  // supportsBackgroundProcessors() creates a throwaway WebGL context per call; calling it on every
  // render exhausts the browser's context limit ("Too many active WebGL contexts"). Check once.
  const [supported] = useState(() => supportsBackgroundProcessors());

  const track = cameraTrack?.source === Track.Source.Camera ? cameraTrack.track : undefined;

  const apply = useCallback(async (videoTrack: LocalVideoTrack, next: BackgroundEffect) => {
    const options =
      next.id === 'none'
        ? ({ mode: 'disabled' } as const)
        : 'blurRadius' in next
          ? ({ mode: 'background-blur', blurRadius: next.blurRadius } as const)
          : ({ mode: 'virtual-background', imagePath: (next as { imagePath: string }).imagePath } as const);

    if (videoTrack.getProcessor() && processorRef.current) {
      await processorRef.current.switchTo(options);
      return;
    }
    if (options.mode === 'disabled') return;
    const processor = BackgroundProcessor(options);
    processorRef.current = processor;
    await videoTrack.setProcessor(processor);
  }, []);

  useEffect(() => {
    if (!supported || !(track instanceof LocalVideoTrack)) return;
    let cancelled = false;
    setApplying(true);
    setError('');
    apply(track, effect)
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setApplying(false));
    return () => {
      cancelled = true;
    };
  }, [supported, track, effect, apply]);

  return { effect, setEffect, applying, error, supported, cameraOn: Boolean(track) && localParticipant.isCameraEnabled };
}
