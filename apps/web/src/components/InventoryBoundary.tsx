import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { InventorySnapshot } from '@dcat/core';
import { formatUpdatedAt, isInventoryStale } from '../lib/inventory.ts';
import { discoveryStages } from '../lib/resourceStatus.ts';
import { useInventoryActions } from '../lib/inventoryActions.tsx';
import type { WorkspaceContext } from '../lib/workspace.ts';
import { Button } from './ui/index.ts';
import { EmptyState, ErrorState } from './DataStates.tsx';
import { Icon } from './Icon.tsx';
import { DiscoveryProgress, ResourceStatusNotice } from './ResourceStatusPanel.tsx';
import { NoOrgState } from './NoOrgState.tsx';

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
            className="min-h-9 rounded-lg border border-line px-3 text-sm font-medium text-ink-soft transition-colors hover:bg-surface-alt hover:text-ink"
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

  // A disabled query is "pending" in React Query. Without this guard every
  // explorer would spin forever when live mode has no authenticated org.
  if (!context) return <NoOrgState />;
  if (query.isPending) return <DiscoveryProgress stages={discoveryStages(null, true)} />;
  // Loading replaces the snapshot so stale rows cannot be mistaken for fresh
  // results. Once loading ends, the real result, empty, or error state returns.
  const manualRefresh = Boolean(actions?.isRefreshingInventory);
  if (query.isFetching || manualRefresh) {
    // Only a manual refresh can be cancelled. An invalidation-triggered query
    // refetch is owned by React Query, so offering Cancel there would spin
    // forever after the click without actually stopping the request.
    return <InventoryRefreshSkeleton onCancel={manualRefresh ? actions?.cancelRefresh : undefined} />;
  }
  if (query.isError) {
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
      <ResourceStatusNotice inventory={inventory} />
      {actions?.refreshError ? (
        <p className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-danger/20 bg-danger-soft px-4 py-2 text-sm text-danger" role="alert">
          <span>Refresh failed: {actions.refreshError}</span>
          <button type="button" onClick={actions.refreshInventory} className="font-semibold underline underline-offset-2">Retry</button>
        </p>
      ) : null}
      {children(inventory, freshness)}
    </>
  );
}
