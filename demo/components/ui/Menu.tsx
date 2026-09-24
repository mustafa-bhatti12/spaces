'use client';

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

interface MenuProps {
  /** Accessible name of the trigger (also its tooltip). */
  label: string;
  /** Trigger content: icon plus optional legend. */
  trigger: ReactNode;
  /** Extra classes on the trigger key. */
  triggerClassName?: string;
  /** Panel content; call `close` after an item acts. */
  children: (close: () => void) => ReactNode;
  panelClassName?: string;
}

/**
 * A dock key that opens a panel above it. Closes on outside pointer, Escape (returning focus to the
 * key), or when an item calls `close`.
 */
export function Menu({ label, trigger, triggerClassName = '', children, panelClassName = '' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`key ${triggerClassName}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
        <div id={panelId} className={`menu-panel ${panelClassName}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
