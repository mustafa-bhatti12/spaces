'use client';

import { useConnectionQualityIndicator } from '@livekit/components-react';
import { ConnectionQuality, type Participant } from 'livekit-client';

type Tone = 'ok' | 'warn' | 'alert' | 'idle';

const LEVELS: Record<ConnectionQuality, { lit: number; tone: Tone; label: string }> = {
  [ConnectionQuality.Excellent]: { lit: 3, tone: 'ok', label: 'Excellent connection' },
  [ConnectionQuality.Good]: { lit: 2, tone: 'ok', label: 'Good connection' },
  [ConnectionQuality.Poor]: { lit: 1, tone: 'warn', label: 'Poor connection' },
  [ConnectionQuality.Lost]: { lit: 0, tone: 'alert', label: 'Connection lost' },
  [ConnectionQuality.Unknown]: { lit: 0, tone: 'idle', label: 'Checking connection' },
};

/** Bar heights on a 16 px box, bottom-aligned. */
const BARS = [5, 9, 13];

/**
 * A participant's connection as three bars. Neutral while it's fine; the signal colours only when
 * it isn't (amber poor, red lost). `onlyWhenBad` hides it on good links (tiles, like Meet).
 */
export function SignalBars({
  participant,
  onlyWhenBad = false,
  className = '',
}: {
  participant: Participant;
  onlyWhenBad?: boolean;
  className?: string;
}) {
  const { quality } = useConnectionQualityIndicator({ participant });
  const level = LEVELS[quality] ?? LEVELS[ConnectionQuality.Unknown];
  if (onlyWhenBad && (level.tone === 'ok' || level.tone === 'idle')) return null;
  return (
    <span className={`signal signal-${level.tone} ${className}`} role="img" aria-label={level.label} title={level.label}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {BARS.map((h, i) => (
          <rect key={h} x={1.5 + i * 5} y={14.5 - h} width="3" height={h} rx="1" className={i < level.lit ? 'signal-on' : 'signal-off'} />
        ))}
      </svg>
    </span>
  );
}
