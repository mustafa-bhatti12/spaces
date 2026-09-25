'use client';

import { useRoomContext } from '@livekit/components-react';
import { CircleSlash, LogOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Leave confirmation for everyone. The host (onEndForAll given) also gets "End call for everyone";
 * guests only confirm leaving. Native <dialog> for focus trapping, Escape and the backdrop;
 * portaled out of the dock so the dock's key styles don't reach it.
 */
export function LeaveDialog({ onClose, onEndForAll }: { onClose: () => void; onEndForAll?: () => Promise<void> }) {
  const room = useRoomContext();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState<'leave' | 'end' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const leave = async () => {
    setBusy('leave');
    await room.disconnect();
  };

  const end = async () => {
    if (!onEndForAll) return;
    setBusy('end');
    setError('');
    try {
      await onEndForAll();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  return createPortal(
    <dialog
      ref={ref}
      className={`face leave-dialog${onEndForAll ? ' leave-dialog-host' : ''}`}
      aria-labelledby="leave-title"
      aria-describedby="leave-body"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the <dialog> itself.
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="leave-head">
        <span className="leave-icon" aria-hidden="true">
          <LogOut />
        </span>
        <div>
          <h2 id="leave-title" className="leave-title">
            {onEndForAll ? 'Leave or end the call?' : 'Leave the call?'}
          </h2>
          <p id="leave-body" className="leave-body">
            {onEndForAll
              ? 'You started this call. Leave and it continues without you, or end it for everyone.'
              : 'You can rejoin any time with the same link.'}
          </p>
        </div>
      </div>
      {error && (
        <p className="leave-error" role="alert">
          {error}
        </p>
      )}
      <div className="leave-actions">
        <button type="button" className="key key-quiet" onClick={onClose} disabled={busy !== null} autoFocus>
          Cancel
        </button>
        <button
          type="button"
          className={onEndForAll ? 'key' : 'key key-destroy'}
          onClick={leave}
          disabled={busy !== null}
        >
          {busy === 'leave' ? 'Leaving…' : 'Leave call'}
        </button>
        {onEndForAll && (
          <button type="button" className="key key-destroy" onClick={end} disabled={busy !== null}>
            <CircleSlash aria-hidden="true" />
            {busy === 'end' ? 'Ending…' : 'End for everyone'}
          </button>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
