'use client';

import { useConnectionQualityIndicator, useLocalParticipant } from '@livekit/components-react';
import { ConnectionQuality } from 'livekit-client';
import { useEffect, useState } from 'react';

/** How long it must stay weak before the dock says so (brief dips aren't worth a warning). */
const WARN_AFTER_MS = 3_000;

/** Whether this participant's connection has been Poor/Lost for WARN_AFTER_MS, for the dock's readout. */
export function useWeakConnection(): boolean {
  const { localParticipant } = useLocalParticipant();
  const { quality } = useConnectionQualityIndicator({ participant: localParticipant });
  const [weak, setWeak] = useState(false);

  useEffect(() => {
    if (quality !== ConnectionQuality.Poor && quality !== ConnectionQuality.Lost) {
      setWeak(false);
      return;
    }
    const timer = setTimeout(() => setWeak(true), WARN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [quality]);

  return weak;
}
