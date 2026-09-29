'use client';

import { useSyncExternalStore } from 'react';

/** Same breakpoint as the phone layout in globals.css. */
const PHONE = '(max-width: 560px)';

function subscribe(onChange: () => void) {
  const query = window.matchMedia(PHONE);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** True on phone-sized screens. False while server-rendering, so the desktop layout is the default. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}
