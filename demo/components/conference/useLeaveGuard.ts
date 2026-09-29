'use client';

import { useConnectionState } from '@livekit/components-react';
import { ConnectionState } from 'livekit-client';
import { useEffect } from 'react';
import { useEmbed } from '../embed/EmbedContext';

const GUARD = 'spaces-call';

/**
 * Stops an accidental exit from a live call.
 *
 * - Closing the tab or window, reloading, or following a link away gets the browser's own
 *   "Leave site?" confirmation. Its wording is the browser's — a page can't supply text or a
 *   custom dialog there — and browsers only show it once the person has interacted with the page,
 *   which joining a call always counts as.
 * - Going back (the button, the trackpad swipe, Alt/Cmd+←, and Backspace in browsers that still
 *   navigate on it) is cancelled and asks through our own leave dialog instead: a sentinel history
 *   entry is pushed on join and pushed straight back on `popstate`, so the first Back press never
 *   leaves the call. The entry is given back on a real leave, so Back still works from the end
 *   screen.
 *
 * Embedded, only the unload half runs: history belongs to the consumer's page, and hijacking its
 * Back button from inside an iframe would be a surprise.
 */
export function useLeaveGuard(ask: () => void) {
  const connected = useConnectionState() === ConnectionState.Connected;
  const embedded = useEmbed() !== null;

  useEffect(() => {
    if (!connected) return;
    // preventDefault is the modern way to ask for the prompt; returnValue keeps older Safari/Firefox.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    if (embedded) return () => window.removeEventListener('beforeunload', onBeforeUnload);

    const push = () => history.pushState({ [GUARD]: true }, '');
    const onPopState = () => {
      push();
      ask();
    };
    push();
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('popstate', onPopState);
      if ((history.state as Record<string, unknown> | null)?.[GUARD]) history.back();
    };
  }, [connected, embedded, ask]);
}
