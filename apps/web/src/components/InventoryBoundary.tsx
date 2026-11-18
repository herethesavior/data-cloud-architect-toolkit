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

interface InventoryBoundaryProps {
  query: UseQueryResult<InventorySnapshot, Error>;
  context: WorkspaceContext | null;
  children: (inventory: InventorySnapshot) => ReactNode;
}

export function InventoryBoundary({ query, context, children }: InventoryBoundaryProps) {
  const actions = useInventoryActions();

  // A disabled query is "pending" in React Query. Without this guard every
  // explorer would spin forever when live mode has no authenticated org.
  if (!context) return <NoOrgState />;
  if (query.isPending) return <DiscoveryProgress stages={discoveryStages(null, true)} />;
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

  return (
    <>
      <ResourceStatusNotice inventory={inventory} />
      <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-soft">
        <Icon name="clock" size={14} className="text-ink-faint" />
        <span>
          Updated <span title={absolute}>{formatUpdatedAt(inventory.generatedAt)}</span>
        </span>
        <span className="hidden text-ink-faint sm:inline">{absolute}</span>
        {stale ? (
          <span className="rounded-full border border-warning/30 bg-warning-soft px-2 py-0.5 text-warning">Cached</span>
        ) : null}
        {actions ? (
          <Button
            variant="quiet"
            onClick={actions.refreshInventory}
            disabled={!context.alias || actions.isRefreshingInventory}
            aria-label="Refresh inventory"
            aria-busy={actions.isRefreshingInventory}
            title="Refresh this inventory from the local connector"
            className="ml-auto px-2 py-1 text-xs"
          >
            <Icon name="refresh" size={14} className={actions.isRefreshingInventory ? 'animate-spin' : undefined} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        ) : null}
      </div>
      {actions?.refreshError ? (
        <p className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-danger/20 bg-danger-soft px-4 py-2 text-sm text-danger" role="alert">
          <span>Refresh failed: {actions.refreshError}</span>
          <button type="button" onClick={actions.refreshInventory} className="font-semibold underline underline-offset-2">Retry</button>
        </p>
      ) : null}
      {children(inventory)}
    </>
  );
}
