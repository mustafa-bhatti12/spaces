'use client';

import { UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { initials } from '../ui/Device';
import type { WaitingPerson, WaitingRoomControls } from './useWaitingRoom';

/** Matches `.chat-toast[data-leaving]`'s transition. */
const EXIT_MS = 180;
/** Avatars shown in the stack before "+N". */
const MAX_FACES = 3;

/**
 * The host's "wants to join" toast, first in the notification stack. It stays until the host answers
 * (or the asker gives up): one person gets Admit/Deny, several get View all/Admit all. Each new asker
 * pops into the avatar stack and pulses the icon once; once nobody is waiting, the card plays its exit
 * with the last list it showed before unmounting.
 */
export function WaitingNotice({ lobby, onView }: { lobby: WaitingRoomControls; onView: () => void }) {
  const [busy, setBusy] = useState(false);
  // What the card shows: the live list, or the last one while the exit plays.
  const [shown, setShown] = useState<WaitingPerson[]>(lobby.pending);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (lobby.pending.length > 0) {
      setShown(lobby.pending);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const timer = setTimeout(() => setShown([]), EXIT_MS);
    return () => clearTimeout(timer);
  }, [lobby.pending]);

  if (shown.length === 0) return null;

  const act = async (ids: string[] | 'all', admit: boolean) => {
    setBusy(true);
    try {
      await lobby.answer(ids, admit);
    } finally {
      setBusy(false);
    }
  };
  const one = shown.length === 1 ? shown[0] : null;
  const newest = shown[shown.length - 1];
  const faces = shown.slice(-MAX_FACES);

  return (
    <div className="chat-toast waiting-notice" role="alert" data-leaving={leaving || undefined}>
      <div className="waiting-notice-body">
        {/* Keyed on the newest asker, so the one-shot pulse replays for each new request. */}
        <span className="waiting-notice-icon" key={newest.id} aria-hidden="true">
          <UserPlus />
        </span>
        <span className="chat-toast-body">
          <span className="chat-toast-name">{one ? `${one.name} wants to join` : `${shown.length} people want to join`}</span>
          <span className="waiting-faces" aria-hidden="true">
            {faces.map((p) => (
              <span className="avatar waiting-avatar" key={p.id} title={p.name}>
                {initials(p.name)}
              </span>
            ))}
            {shown.length > MAX_FACES && <span className="waiting-more">+{shown.length - MAX_FACES}</span>}
            <span className="chat-toast-text">{one ? 'Waiting to be let in' : shown.map((p) => p.name).join(', ')}</span>
          </span>
        </span>
      </div>
      <div className="waiting-notice-actions">
        {one ? (
          <>
            <button type="button" className="key" disabled={busy || leaving} onClick={() => act([one.id], false)}>
              Deny
            </button>
            <button type="button" className="key key-go" disabled={busy || leaving} onClick={() => act([one.id], true)}>
              Admit
            </button>
          </>
        ) : (
          <>
            <button type="button" className="key" disabled={leaving} onClick={onView}>
              View all
            </button>
            <button type="button" className="key key-go" disabled={busy || leaving} onClick={() => act('all', true)}>
              Admit all
            </button>
          </>
        )}
      </div>
    </div>
  );
}
