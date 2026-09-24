'use client';

import { useLayoutContext } from '@livekit/components-react';
import type { ReactNode } from 'react';

/**
 * LiveKit's SettingsMenuToggle isn't exported from @livekit/components-react (alpha), so this is its
 * 5-line equivalent: the same `toggle_settings` layout-context action VideoConference's modal uses.
 */
export function SettingsToggle({ children }: { children: ReactNode }) {
  const { dispatch, state } = useLayoutContext().widget;
  return (
    <button
      type="button"
      className="lk-button lk-settings-toggle"
      aria-pressed={Boolean(state?.showSettings)}
      onClick={() => dispatch?.({ msg: 'toggle_settings' })}
    >
      {children}
    </button>
  );
}
