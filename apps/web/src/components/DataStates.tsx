import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { Button } from './ui/index.ts';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="panel flex flex-col gap-3 px-6 py-9" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-sm text-ink-soft">
        <span aria-hidden="true" className="loading-dot size-2 rounded-full bg-brand" />
        <span>{label}</span>
      </div>
      <div aria-hidden="true" className="space-y-2">
        <div className="skeleton h-3 w-3/4 rounded" />
        <div className="skeleton h-3 w-full rounded" />
        <div className="skeleton h-3 w-5/6 rounded" />
      </div>
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  description: string;
  icon?: IconName;
  action?: ReactNode;
}

export function EmptyState({ title, description, icon = 'database', action }: EmptyStateProps) {
  return (
    <div className="panel flex flex-col items-center gap-2 border-dashed px-6 py-12 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-surface-alt text-ink-faint">
        <Icon name={icon} size={20} />
      </span>
      <p className="font-semibold text-ink">{title}</p>
      <p className="max-w-md text-sm text-ink-soft">{description}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
  title?: string;
  retryLabel?: string;
  secondary?: ReactNode;
}

export function ErrorState({
  message,
  onRetry,
  title = 'Something went wrong',
  retryLabel = 'Try again',
  secondary,
}: ErrorStateProps) {
  return (
    <div className="rounded-xl border border-danger/20 bg-danger-soft p-5" role="alert">
      <div className="flex items-start gap-3">
        <Icon name="warning" className="mt-0.5 text-danger" />
        <div>
          <p className="font-semibold text-danger">{title}</p>
          <p className="mt-1 text-sm text-danger">{message}</p>
          {onRetry || secondary ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {onRetry ? (
                <Button variant="secondary" onClick={onRetry}>
                  {retryLabel}
                </Button>
              ) : null}
              {secondary}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
