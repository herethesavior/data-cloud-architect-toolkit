import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { DiscoveryProgress as DiscoveryProgressData, InventorySnapshot } from '@dcat/core';
import { formatUpdatedAt, isInventoryStale } from '../lib/inventory.ts';
import { discoveryStages, humanizeResource, resumableProgressFamilies } from '../lib/resourceStatus.ts';
import { useInventoryActions } from '../lib/inventoryActions.tsx';
import { useDismissibleNotice } from '../lib/noticeDismissal.ts';
import type { WorkspaceContext } from '../lib/workspace.ts';
import { Button } from './ui/index.ts';
import { EmptyState, ErrorState } from './DataStates.tsx';
import { Icon } from './Icon.tsx';
import { NoticeDismissButton } from './NoticeDismissButton.tsx';
import { DiscoveryProgress, ResourceStatusNotice } from './ResourceStatusPanel.tsx';
import { NoOrgState } from './NoOrgState.tsx';

function countLabel(loaded: number, total: number | null): string {
  return total === null ? `${loaded} loaded` : `${loaded}/${total}`;
}

function stalledFamilies(inventory: InventorySnapshot): boolean {
  return resumableProgressFamilies(inventory) > 0;
}

/** Visible, exact counters for partial snapshots; never hides loaded rows. */
function InventoryProgressBanner({
  progress,
  onResume,
  isResuming,
}: {
  progress: DiscoveryProgressData;
  onResume?: () => void;
  isResuming: boolean;
}) {
  const stalled = progress.state === 'failed';
  const title = stalled
    ? 'Some collections stopped loading'
    : progress.state === 'complete'
      ? 'Inventory complete'
      : 'Loading inventory in batches';
  const detail = progress.total === null
    ? `${progress.loaded} records loaded so far`
    : `${progress.loaded} of ${progress.total} records loaded`;

  if (progress.state === 'complete') {
    return (
      <p data-testid="inventory-progress" role="status" className="mb-4 text-xs text-ink-soft">
        <span aria-hidden="true">✓ </span>{title} · {detail}
      </p>
    );
  }

  return (
    <section
      data-testid="inventory-progress"
      role={stalled ? 'alert' : 'status'}
      aria-busy={progress.state === 'running'}
      className={`mb-4 rounded-lg border px-4 py-3 ${stalled ? 'border-danger/25 bg-danger-soft' : 'border-brand/20 bg-brand-soft'}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-ink">{title}</p>
          <p className="mt-0.5 text-xs text-ink-soft">{detail}</p>
        </div>
        {stalled && onResume ? (
          <button
            type="button"
            onClick={onResume}
            disabled={isResuming}
            className="min-h-8 rounded-lg border border-line-strong bg-surface px-3 text-xs font-semibold text-brand transition-colors hover:bg-surface-alt disabled:opacity-50"
          >
            {isResuming ? 'Resuming…' : 'Resume loading'}
          </button>
        ) : null}
      </div>
      <ul className="mt-3 grid gap-1.5 text-xs text-ink-soft sm:grid-cols-2 lg:grid-cols-3">
        {progress.families.map((family) => (
          <li key={family.family} data-testid={`inventory-progress-${family.family}`} className="flex items-center justify-between gap-2 rounded-md bg-surface/70 px-2.5 py-1.5">
            <span className="truncate font-medium text-ink">{humanizeResource(family.family)}</span>
            <span className="whitespace-nowrap tabular-nums">
              {countLabel(family.loaded, family.total)}
              {family.hasMore ? ' · more' : ''}
              {family.status === 'failed' ? ' · stopped' : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InventoryRefreshSkeleton({ onCancel }: { onCancel?: () => void }) {
  return (
    <section
      data-testid="inventory-refresh-skeleton"
      aria-busy="true"
      aria-live="polite"
      aria-label="Refreshing inventory"
      className="panel px-6 py-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="label-xs">Inventory refresh</p>
          <h3 className="mt-1 flex items-center gap-2 text-base font-semibold text-ink">
            <Icon name="refresh" size={17} className="animate-spin text-brand" />
            Getting the latest metadata…
          </h3>
          <p className="mt-1 text-sm text-ink-soft">Previous results return when the refresh finishes.</p>
        </div>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel refresh"
            title="Cancel this refresh"
            className="min-h-9 rounded-lg border border-line-strong px-3 text-sm font-medium text-ink-soft transition-colors hover:bg-surface-alt hover:text-ink"
          >
            Cancel refresh
          </button>
        ) : null}
      </div>
      <div aria-hidden="true" className="mt-5 space-y-3">
        <div className="skeleton h-3 w-2/3 rounded" />
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="skeleton h-20 rounded-lg" />
          <div className="skeleton h-20 rounded-lg" />
          <div className="skeleton h-20 rounded-lg" />
        </div>
        <div className="skeleton h-28 rounded-lg" />
      </div>
    </section>
  );
}

interface InventoryBoundaryProps {
  query: UseQueryResult<InventorySnapshot, Error>;
  context: WorkspaceContext | null;
  children: (inventory: InventorySnapshot, freshness: ReactNode) => ReactNode;
}

export function InventoryBoundary({ query, context, children }: InventoryBoundaryProps) {
  const actions = useInventoryActions();
  const refreshError = actions?.refreshError ?? '';
  const { visible: refreshErrorVisible, dismiss: dismissRefreshError } = useDismissibleNotice(
    'inventory-refresh-error',
    refreshError ? `${context?.contextId ?? 'none'}:${refreshError}` : 'none',
  );

  // A disabled query is "pending" in React Query. Without this guard every
  // explorer would spin forever when live mode has no authenticated org.
  if (!context) return <NoOrgState />;
  if (query.isPending && !query.data) return <DiscoveryProgress stages={discoveryStages(null, true)} />;
  // A manual refresh deliberately replaces the view with its cancellable
  // skeleton. Automatic continuation keeps partial rows visible; it only needs
  // a skeleton when there is no snapshot to render yet.
  const manualRefresh = Boolean(actions?.isRefreshingInventory);
  if (manualRefresh || (query.isFetching && !query.data)) {
    // Only a manual refresh can be cancelled. An invalidation-triggered query
    // refetch is owned by React Query, so offering Cancel there would spin
    // forever after the click without actually stopping the request.
    return <InventoryRefreshSkeleton onCancel={manualRefresh ? actions?.cancelRefresh : undefined} />;
  }
  if (query.isError && !query.data) {
    return (
      <ErrorState
        title="Couldn't load the inventory"
        message={query.error.message}
        onRetry={() => void query.refetch()}
        secondary={actions && actions.mode === 'live' ? (
          <Button variant="quiet" onClick={actions.onToggleMode} disabled={actions.isTogglingMode}>Use demo mode</Button>
        ) : undefined}
      />
    );
  }
  if (!query.data) {
    return (
      <EmptyState
        title="No inventory available"
        description="This org returned no Data 360 metadata. Check the discovery details on the Dashboard."
      />
    );
  }

  const inventory = query.data;
  const timestamp = Date.parse(inventory.generatedAt);
  const absolute = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : 'time unavailable';
  const live = context.mode === 'live';
  const stale = live && isInventoryStale(inventory.generatedAt);

  const freshness = (
    <span data-testid="inventory-freshness" className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line bg-surface-alt px-2 text-xs text-ink-soft">
      <Icon name="clock" size={13} className="text-ink-faint" />
      <span title={`Updated ${absolute}`} className="whitespace-nowrap">
        Updated {formatUpdatedAt(inventory.generatedAt)}
      </span>
      {stale ? (
        <span
          aria-label="Cached snapshot"
          title="Cached snapshot"
          className="size-1.5 shrink-0 rounded-full bg-warning"
        />
      ) : null}
      {actions && actions.isRefreshingInventory ? (
        <button
          type="button"
          onClick={actions.cancelRefresh}
          aria-label="Cancel refresh"
          title="Cancel this refresh"
          className="grid size-7 shrink-0 place-items-center rounded-full text-ink-soft transition-colors hover:bg-danger-soft hover:text-danger"
        >
          <Icon name="close" size={13} />
        </button>
      ) : actions ? (
        <button
          type="button"
          onClick={actions.refreshInventory}
          disabled={!context.alias}
          aria-label="Refresh inventory"
          title="Refresh this inventory from the local connector"
          className="grid size-7 shrink-0 place-items-center rounded-full text-ink-soft transition-colors hover:bg-brand-soft hover:text-brand disabled:opacity-40"
        >
          <Icon name="refresh" size={13} />
        </button>
      ) : null}
    </span>
  );

  return (
    <>
      {inventory.progress ? (
        <InventoryProgressBanner
          progress={inventory.progress}
          onResume={stalledFamilies(inventory) ? () => actions?.resumeDiscovery?.() : undefined}
          isResuming={Boolean(actions?.isResumingDiscovery)}
        />
      ) : null}
      <ResourceStatusNotice inventory={inventory} />
      {refreshError && refreshErrorVisible ? (
        <p className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-danger/20 bg-danger-soft px-4 py-2 text-sm text-danger" role="alert">
          <span className="min-w-0 flex-1">Refresh failed: {refreshError}</span>
          <button type="button" onClick={actions?.refreshInventory} className="font-semibold underline underline-offset-2">Retry</button>
          <NoticeDismissButton label="Dismiss refresh error" onClick={dismissRefreshError} />
        </p>
      ) : null}
      {children(inventory, freshness)}
    </>
  );
}
