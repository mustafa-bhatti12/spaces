'use client';

import { useRoomContext } from '@livekit/components-react';
import { CircleSlash, LogOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The host's Leave: a modal asking whether to step out (the call goes on without them) or end it
 * for everyone. Native <dialog> for focus trapping, Escape and the backdrop; portaled out of the dock
 * so the dock's key styles don't reach it.
 */
export function LeaveDialog({ onClose, onEndForAll }: { onClose: () => void; onEndForAll: () => Promise<void> }) {
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
      className="face leave-dialog"
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
      <h2 id="leave-title" className="leave-title">
        Leave the call?
      </h2>
      <p id="leave-body" className="leave-body">
        You started this call. If you only leave, everyone else can keep talking.
      </p>
      <div className="leave-options">
        <button type="button" className="leave-option" onClick={leave} disabled={busy !== null} autoFocus>
          <LogOut aria-hidden="true" />
          <span>
            <strong>{busy === 'leave' ? 'Leaving…' : 'Leave call'}</strong>
            <small>The call continues without you</small>
          </span>
        </button>
        <button type="button" className="leave-option leave-option-end" onClick={end} disabled={busy !== null}>
          <CircleSlash aria-hidden="true" />
          <span>
            <strong>{busy === 'end' ? 'Ending…' : 'End call for everyone'}</strong>
            <small>Disconnects all participants and stops any recording</small>
          </span>
        </button>
      </div>
      {error && (
        <p className="leave-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="key key-quiet leave-cancel" onClick={onClose} disabled={busy !== null}>
        Cancel
      </button>
    </dialog>,
    document.body,
  );
}
