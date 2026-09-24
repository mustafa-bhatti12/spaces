'use client';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/** The shell every side panel shares with LiveKit's Chat: header with title, count and close. */
export function SidePanel({
  title,
  count,
  onClose,
  children,
}: {
  title: string;
  count?: number;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside className="side-panel" aria-label={title}>
      <header className="side-panel-head">
        <h2>
          {title}
          {count !== undefined && <span className="side-panel-count">{count}</span>}
        </h2>
        <button type="button" className="key key-quiet key-square" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="side-panel-body">{children}</div>
    </aside>
  );
}
