import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { trapDialogFocus } from '../../lib/focusTrap.ts';
import { Icon } from '../Icon.tsx';

interface DetailDrawerProps {
  open: boolean;
  title: string;
  subtitle?: string;
  breadcrumbs?: ReactNode;
  headerActions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

const EXIT_DURATION = 150;

/** Keeps the drawer mounted briefly after close so it can animate out. */
function useDrawerPresence(open: boolean) {
  const [rendered, setRendered] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setClosing(false);
      return;
    }
    if (!rendered) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (reduced) {
      setRendered(false);
      setClosing(false);
      return;
    }
    setClosing(true);
    const timer = window.setTimeout(() => {
      setRendered(false);
      setClosing(false);
    }, EXIT_DURATION);
    return () => window.clearTimeout(timer);
  }, [open, rendered]);

  return { rendered, closing };
}

export function DetailDrawer({ open, title, subtitle, breadcrumbs, headerActions, onClose, children }: DetailDrawerProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const { rendered, closing } = useDrawerPresence(open);

  useEffect(() => {
    if (!open || !rendered) return;
    if (!previousFocusRef.current && document.activeElement instanceof HTMLElement) {
      previousFocusRef.current = document.activeElement;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      trapDialogFocus(event, dialogRef.current);
    };
    document.addEventListener('keydown', handleKeyDown);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, rendered]);

  // Restore focus only after the exit animation removes the portal; restoring
  // while it is still visible would let Tab escape the modal early.
  useEffect(() => {
    if (rendered) return;
    previousFocusRef.current?.focus();
    previousFocusRef.current = null;
  }, [rendered]);

  if (!rendered) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50"
      data-testid="drawer-overlay"
      data-state={closing ? 'closing' : 'open'}
    >
      {/* Invisible click-catcher: the drawer is modal for keyboard users but
          does not dim the underlying content the architect may be comparing. */}
      <button
        type="button"
        data-testid="drawer-click-catcher"
        aria-label="Close details"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <aside
        ref={dialogRef}
        data-testid="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="drawer-panel absolute inset-y-0 right-0 flex w-full max-w-[40rem] flex-col border-l border-line bg-surface shadow-popover"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {breadcrumbs ? <p title={typeof breadcrumbs === 'string' ? breadcrumbs : undefined} className="label-xs mb-1 truncate text-ink-faint">{breadcrumbs}</p> : null}
            <h2 id={titleId} title={typeof title === 'string' ? title : undefined} className="truncate text-base font-semibold text-ink">
              {title}
            </h2>
            {subtitle ? <p title={subtitle} className="mono mt-1 truncate text-ink-soft">{subtitle}</p> : null}
            {headerActions ? <div className="mt-2 flex flex-wrap gap-1">{headerActions}</div> : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-soft hover:bg-surface-alt hover:text-ink"
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
