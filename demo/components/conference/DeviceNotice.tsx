'use client';

import { MicOff, VideoOff, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DeviceHelp, FailedDevice } from '@/lib/client/prejoinGuidance';

/** Matches `.device-notice[data-leaving]`'s transition. */
const EXIT_MS = 180;

export interface DeviceProblem {
  device: FailedDevice;
  help: DeviceHelp;
  /** Failed "Try again" presses so far: after one, the card says it's still blocked. */
  retries: number;
}

const CONSEQUENCE: Record<'audioinput' | 'videoinput' | 'both', string> = {
  audioinput: 'Others in the call can’t hear you.',
  videoinput: 'Others can’t see you, but they can still hear you.',
  both: 'Others can’t see or hear you.',
};

/**
 * The mic or camera failed during the call (permission denied or revoked, no device, device busy).
 * An amber-edged card at the top of the stage: what's wrong, what it means for the others, the
 * steps for this browser, and Try again. It stays until the device works or it's dismissed; a
 * retry that fails again says so instead of silently doing nothing.
 */
export function DeviceNotice({ problem, onRetry, onDismiss }: { problem: DeviceProblem | null; onRetry: () => Promise<void>; onDismiss: () => void }) {
  // What the card shows: the live problem, or the last one while the exit plays.
  const [shown, setShown] = useState<DeviceProblem | null>(problem);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (problem) {
      setShown(problem);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const timer = setTimeout(() => setShown(null), EXIT_MS);
    return () => clearTimeout(timer);
  }, [problem]);

  if (!shown) return null;

  const retry = async () => {
    setBusy(true);
    try {
      await onRetry();
    } finally {
      setBusy(false);
    }
  };
  const { help } = shown;
  const { steps } = help;
  const Icon = shown.device === 'videoinput' ? VideoOff : MicOff;

  return (
    <div className="device-notice" role="alert" aria-labelledby="device-notice-title" data-leaving={leaving || undefined}>
      <div className="device-notice-head">
        <span className="device-notice-icon" aria-hidden="true">
          <Icon />
        </span>
        <div className="device-notice-text">
          <p className="device-notice-title" id="device-notice-title">{help.title}</p>
          <p className="device-notice-lede">{CONSEQUENCE[shown.device ?? 'both']}</p>
        </div>
        <button type="button" className="chat-toast-close" aria-label="Dismiss" onClick={onDismiss}>
          <X aria-hidden="true" />
        </button>
      </div>
      {steps.length > 0 && (
        <ol className="device-notice-steps">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {help.fallback && (
        <p className="device-notice-fallback">
          <span>Still blocked?</span> {help.fallback}
        </p>
      )}
      {help.message && <p className="device-notice-detail">{help.message}</p>}
      <div className="device-notice-foot">
        <p className="device-notice-status" aria-live="polite">
          {shown.retries > 0 && !busy ? 'Still not working. Check the steps above.' : ''}
        </p>
        <button type="button" className="key key-quiet" onClick={onDismiss}>
          Not now
        </button>
        <button type="button" className="key key-go" disabled={busy || leaving} onClick={() => void retry()}>
          {busy ? 'Trying…' : 'Try again'}
        </button>
      </div>
    </div>
  );
}
