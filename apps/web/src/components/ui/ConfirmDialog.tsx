import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { trapDialogFocus } from '../../lib/focusTrap.ts';
import { Icon } from '../Icon.tsx';
import { Button } from './Button.tsx';

interface ConfirmDialogProps {
  title: string;
  description: ReactNode;
  consequences?: ReactNode;
  error?: string;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Modal for actions whose consequences must be read before they are accepted. */
export function ConfirmDialog({
  title,
  description,
  consequences,
  error,
  confirmLabel,
  cancelLabel = 'Cancel',
  busy = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) onCloseRef.current();
      trapDialogFocus(event, dialogRef.current);
    };
    document.addEventListener('keydown', handleKeyDown);
    dialogRef.current?.querySelector<HTMLElement>('[data-dialog-cancel]')?.focus();
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center px-4 py-6">
      <button
        type="button"
        aria-label="Dismiss dialog"
        disabled={busy}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/40"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="relative w-full max-w-lg rounded-xl border border-line bg-surface shadow-popover"
      >
        <div className="border-b border-line px-5 py-4">
          <p className="label-xs mb-1.5 flex items-center gap-1.5 text-danger">
            <Icon name="warning" size={13} />
            Destructive action
          </p>
          <h2 id={titleId} className="text-base font-semibold tracking-tight text-ink">{title}</h2>
        </div>
        <div id={descriptionId} className="space-y-4 px-5 py-5">
          <div className="text-sm text-ink-soft">{description}</div>
          {consequences}
          {error ? (
            <p role="alert" className="rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-4">
          <button
            type="button"
            data-dialog-cancel
            onClick={onClose}
            disabled={busy}
            className="btn-secondary"
          >
            {cancelLabel}
          </button>
          <Button variant="danger" onClick={onConfirm} disabled={busy} aria-busy={busy}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
