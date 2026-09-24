import type { ReactNode } from 'react';

/** One or two initials for an avatar: first and last word of the name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** The device's name plate: a power LED and the product name. */
export function Wordmark({ suffix }: { suffix?: string }) {
  return (
    <span className="wordmark">
      <span className="wordmark-led" aria-hidden="true" />
      Space
      {suffix && <span className="wordmark-suffix">{suffix}</span>}
    </span>
  );
}

export type Signal = 'live' | 'alert' | 'warn' | 'idle';

/** A status LED. `pulse` for things that are actively happening (recording, reconnecting). */
export function Led({ signal, pulse = false, label }: { signal: Signal; pulse?: boolean; label?: string }) {
  return (
    <span
      className={`led led-${signal}${pulse ? ' led-pulse' : ''}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/**
 * The status screen: a recessed strip that reports state as plain text, one segment per fact, in the
 * monospaced readout face.
 */
export function Readout({ children, className = '', live }: { children: ReactNode; className?: string; live?: boolean }) {
  return (
    <div className={`readout ${className}`} role={live ? 'status' : undefined} aria-live={live ? 'polite' : undefined}>
      {children}
    </div>
  );
}

export function ReadoutSegment({ children, strong = false }: { children: ReactNode; strong?: boolean }) {
  return <span className={`readout-seg${strong ? ' readout-strong' : ''}`}>{children}</span>;
}
