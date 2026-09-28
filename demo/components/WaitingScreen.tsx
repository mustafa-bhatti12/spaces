'use client';

import { useEffect } from 'react';
import type { ConnectionDetails } from './conference/types';
import { Led, Readout, ReadoutSegment } from './ui/Device';

const POLL_MS = 2000;

export type WaitingAnswer = 'denied' | 'no-response' | 'ask-again';

/**
 * Asked to join a call with a waiting room: polls until the host answers. The poll is also what keeps
 * the request alive (token-service drops askers that stop polling), so leaving this screen cancels it.
 * `onAdmitted` / `onAnswer` must be stable (useCallback) or the poll restarts on every render.
 */
export function WaitingScreen({
  roomName,
  requestId,
  onAdmitted,
  onAnswer,
  onCancel,
}: {
  roomName: string;
  requestId: string;
  onAdmitted: (details: ConnectionDetails) => void;
  onAnswer: (answer: WaitingAnswer) => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/lobby/status?id=${encodeURIComponent(requestId)}`, { cache: 'no-store' });
        if (!res.ok || stopped) return;
        const data = await res.json();
        if (stopped) return;
        if (data.status === 'admitted') onAdmitted(data as ConnectionDetails);
        else if (data.status === 'denied') onAnswer('denied');
        else if (data.status === 'timeout') onAnswer('no-response');
        else if (data.status === 'unknown') onAnswer('ask-again');
        else return;
        stopped = true;
      } catch {
        // transient network error: the next poll retries
      }
    };
    const timer = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [requestId, onAdmitted, onAnswer]);

  return (
    <section className="face end-face waiting-face" aria-labelledby="waiting-title">
      <Readout live>
        <ReadoutSegment strong>
          <span className="mono">{roomName}</span>
        </ReadoutSegment>
        <ReadoutSegment>
          <Led signal="warn" pulse />
          Waiting room
        </ReadoutSegment>
      </Readout>
      <h1 id="waiting-title" className="title">
        Asking to join…
      </h1>
      <p className="lede">You&apos;ll join the call when someone in it lets you in.</p>
      <div className="end-actions">
        <button type="button" className="key" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
