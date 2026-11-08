'use client';

import { useSyncExternalStore } from 'react';

/** Same queries as the phone layout in globals.css: a narrow screen, or a phone held sideways. */
const PHONE = '(max-width: 560px), (orientation: landscape) and (max-height: 500px) and (pointer: coarse)';

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
