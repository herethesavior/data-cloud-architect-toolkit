import { useId } from 'react';
import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { DiscoveryProgress as DiscoveryProgressData, InventorySnapshot } from '@dcat/core';
import {
  activeDiscoveryActivity,
  activityDetailLabel,
  isInventoryLoading,
  loadedCountLabel,
  loadedDetailLabel,
  progressTotal,
  trustedTotal,
} from '../lib/inventoryDisplay.ts';
import { formatUpdatedAt, isInventoryStale } from '../lib/inventory.ts';
import {
  discoveryStages,
  hasResumableDiscoveryGap,
  humanizeResource,
  resumableProgressFamilies,
} from '../lib/resourceStatus.ts';
import { useInventoryActions } from '../lib/inventoryActions.tsx';
import { isFullRefresh } from '../lib/refreshScope.ts';
import { describeError } from '../lib/userError.ts';
import { useDismissibleNotice } from '../lib/noticeDismissal.ts';
import type { WorkspaceContext } from '../lib/workspace.ts';
import { Button } from './ui/index.ts';
import { EmptyState, ErrorState } from './DataStates.tsx';
import { Icon } from './Icon.tsx';
import { NoticeDismissButton } from './NoticeDismissButton.tsx';
import { DiscoveryProgress, ResourceStatusNotice } from './ResourceStatusPanel.tsx';
import { NoOrgState } from './NoOrgState.tsx';

function stalledFamilies(inventory: InventorySnapshot): boolean {
  return resumableProgressFamilies(inventory) > 0 || hasResumableDiscoveryGap(inventory);
}

/** Visible, exact counters for partial snapshots; never hides loaded rows. */
function InventoryProgressBanner({
  progress,
  onResume,
  isResuming,
  resumable = false,
  interrupted = false,
  refreshing = false,
}: {
  progress: DiscoveryProgressData;
  onResume?: () => void;
  isResuming: boolean;
  resumable?: boolean;
  interrupted?: boolean;
  refreshing?: boolean;
}) {
  const stalled = resumable || progress.state === 'failed';
  const degraded = progress.state === 'partial' || progress.families.some((family) =>
    family.status === 'partial' || family.status === 'failed');
  // A stopped session can still carry `hasMore` as resume work. Only a running
  // session is actively loading, so only that state may show a live spinner.
  const spinning = !interrupted && progress.state === 'running';
  // A terminal `partial` snapshot is a settled result with gapped families, so
  // it must not be presented as still loading.
  const finished = !spinning && (progress.state === 'complete' || progress.state === 'partial');
  const title = interrupted
    ? 'Inventory loading stopped'
    : stalled
      ? 'Some inventory families stopped loading'
      : finished
        ? degraded ? 'Inventory loaded with gaps' : 'Inventory complete'
        : 'Loading inventory in batches';
  const activity = spinning ? activeDiscoveryActivity(progress) : null;
  const detail = activity
    ? `${activityDetailLabel(activity)} · ${loadedDetailLabel(progress.loaded, progressTotal(progress), spinning)}`
    : loadedDetailLabel(progress.loaded, progressTotal(progress), spinning);

  // A resumable gap must keep the action-bearing banner even when discovery's
  // own state is terminal; the compact line is only for genuinely finished work.
  if (finished && !stalled) {
    return (
      <p data-testid="inventory-progress" role="status" className="mb-4 text-xs text-ink-soft">
        <span aria-hidden="true">{degraded ? '! ' : '✓ '}</span>{title} · {detail}
      </p>
    );
  }

  return (
    <section
      data-testid="inventory-progress"
      role={stalled ? 'alert' : 'status'}
      aria-busy={progress.state === 'running' && !interrupted}
      className={`mb-4 rounded-lg border px-4 py-3 ${stalled ? 'border-danger/25 bg-danger-soft' : 'border-brand/20 bg-brand-soft'}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {spinning ? (
            <span role="img" aria-label="Inventory still loading" className="shrink-0">
              <Icon name="refresh" size={16} className="animate-spin text-brand" />
            </span>
          ) : null}
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{title}</p>
            <p className="mt-0.5 text-xs text-ink-soft">{detail}</p>
          </div>
        </div>
        {stalled && onResume && !refreshing ? (
          <button
            type="button"
            onClick={onResume}
            disabled={isResuming}
            className="min-h-8 rounded-lg border border-line-strong bg-surface px-3 text-xs font-semibold text-brand transition-colors hover:bg-surface-alt disabled:opacity-50"
          >
            {isResuming ? 'Resuming...' : 'Resume loading'}
          </button>
        ) : null}
      </div>
      <ul className="mt-3 grid gap-1.5 text-xs text-ink-soft sm:grid-cols-2 lg:grid-cols-3">
        {progress.families.map((family) => (
          <li key={family.family} data-testid={`inventory-progress-${family.family}`} className="flex items-center justify-between gap-2 rounded-md bg-surface/70 px-2.5 py-1.5">
            <span className="truncate font-medium text-ink">{humanizeResource(family.family)}</span>
            <span className="whitespace-nowrap tabular-nums">
              {loadedCountLabel(family.loaded, trustedTotal(family))}
              {family.hasMore ? ' · more to load' : ''}
              {family.status === 'failed' ? ' · stopped' : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InventoryRefreshSkeleton({
  onCancel,
  scopeLabel,
  scoped,
}: {
  onCancel?: () => void;
  scopeLabel: string;
  scoped: boolean;
}) {
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
            Updating {scopeLabel}...
          </h3>
          <p className="mt-1 text-sm text-ink-soft">
            {scoped
              ? 'Other families stay as they are. Previous results return when the refresh finishes.'
              : 'Previous results return when the refresh finishes.'}
          </p>
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
  const scopeDescriptionId = useId();
  const refreshScope = actions?.refreshScope;
  const scopeLabel = refreshScope?.label ?? 'the full inventory';
  const scopedRefresh = refreshScope ? !isFullRefresh(refreshScope.families) : false;
  const refreshError = actions?.refreshError ?? '';
  // Include the mutation attempt so dismissing one failure does not hide the
  // same error from a later retry.
  const { visible: refreshErrorVisible, dismiss: dismissRefreshError } = useDismissibleNotice(
    'inventory-refresh-error',
    refreshError ? `${context?.contextId ?? 'none'}:${actions?.refreshAttempt ?? 0}:${refreshError}` : 'none',
  );
  const resumeError = actions?.resumeError ?? '';
  const { visible: resumeErrorVisible, dismiss: dismissResumeError } = useDismissibleNotice(
    'inventory-resume-error',
    resumeError ? `${context?.contextId ?? 'none'}:${actions?.resumeAttempt ?? 0}:${resumeError}` : 'none',
  );

  // A disabled query is "pending" in React Query. Without this guard every
  // explorer would spin forever when live mode has no authenticated org.
  if (!context) return <NoOrgState />;
  if (query.isPending && !query.data) return <DiscoveryProgress stages={discoveryStages(null, true)} />;
  // Once any snapshot exists, keep it visible. Automatic loads, resume, and
  // manual refresh all stream partial snapshots into the same query cache;
  // only a first-ever load needs a full-page skeleton.
  const manualRefresh = Boolean(actions?.isRefreshingInventory);
  if (query.isFetching && !query.data) {
    // Only a manual refresh can be cancelled. An invalidation-triggered query
    // refetch is owned by React Query, so offering Cancel there would spin
    // forever after the click without actually stopping the request.
    return (
      <InventoryRefreshSkeleton
        onCancel={manualRefresh ? actions?.cancelRefresh : undefined}
        scopeLabel={scopeLabel}
        scoped={scopedRefresh}
      />
    );
  }
  if (query.isError && !query.data) {
    const described = describeError(query.error, 'inventory');
    const canContinue = described.recovery === 'continue' && Boolean(actions?.continueInventory);
    return (
      <ErrorState
        title="Couldn't load the inventory"
        message={described.message}
        hint={described.hint}
        retryLabel={canContinue ? 'Continue loading' : 'Try again'}
        onRetry={() => {
          if (canContinue) actions?.continueInventory?.();
          else void query.refetch();
        }}
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
  const describedLoadError = query.isError ? describeError(query.error, 'inventory') : null;
  const loadError = describedLoadError?.message ?? '';
  const canContinue = describedLoadError?.recovery === 'continue' && Boolean(actions?.continueInventory);
  const timestamp = Date.parse(inventory.generatedAt);
  const absolute = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : 'time unavailable';
  const live = context.mode === 'live';
  // A failed poll leaves the last partial snapshot in React Query. Spinning on
  // that stale `running` state would promise work nobody is doing anymore.
  const working = !loadError && (
    isInventoryLoading(inventory)
    || Boolean(actions?.isRefreshingInventory || actions?.isResumingDiscovery)
  );
  // While work is active the timestamp means "last batch", not "settled data";
  // a stale dot there would contradict the spinner.
  const stale = live && !working && isInventoryStale(inventory.generatedAt);

  const freshness = (
    <span data-testid="inventory-freshness" className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line bg-surface-alt px-2 text-xs text-ink-soft">
      {working ? (
        <span role="img" aria-label="Inventory loading" className="shrink-0">
          <Icon name="refresh" size={13} className="animate-spin text-brand" />
        </span>
      ) : null}
      <Icon name="clock" size={13} className="text-ink-faint" />
      <span title={`${working ? 'Last batch' : 'Updated'} ${absolute}`} className="whitespace-nowrap">
        {working ? 'Last batch' : 'Updated'} {formatUpdatedAt(inventory.generatedAt)}
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
          className="grid size-8 shrink-0 place-items-center rounded-full text-ink-soft transition-colors hover:bg-danger-soft hover:text-danger"
        >
          <Icon name="close" size={13} />
        </button>
      ) : actions ? (
        <button
          type="button"
          onClick={actions.refreshInventory}
          disabled={!context.alias}
          aria-label="Refresh inventory"
          aria-describedby={scopedRefresh ? scopeDescriptionId : undefined}
          title={scopedRefresh
            ? `Refresh ${scopeLabel} from the local connector`
            : 'Refresh this inventory from the local connector'}
          data-refresh-scope={scopedRefresh ? scopeLabel : undefined}
          className="grid size-8 shrink-0 place-items-center rounded-full text-ink-soft transition-colors hover:bg-brand-soft hover:text-brand disabled:opacity-40"
        >
          <Icon name="refresh" size={13} />
        </button>
      ) : null}
    </span>
  );

  return (
    <>
      {loadError ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-danger/20 bg-danger-soft px-4 py-2 text-sm text-danger" role="alert">
          <span className="min-w-0 flex-1">Loading stopped: {loadError}</span>
          <button
            type="button"
            onClick={() => {
              if (canContinue) actions?.continueInventory?.();
              else void query.refetch();
            }}
            className="min-h-8 rounded-lg border border-danger/30 bg-surface px-3 font-semibold text-danger transition-colors hover:bg-surface-alt"
          >
            {canContinue ? 'Continue loading' : 'Retry'}
          </button>
        </div>
      ) : null}
      {inventory.progress ? (
        <InventoryProgressBanner
          progress={inventory.progress}
          onResume={stalledFamilies(inventory) ? () => actions?.resumeDiscovery?.() : undefined}
          isResuming={Boolean(actions?.isResumingDiscovery)}
          resumable={stalledFamilies(inventory)}
          interrupted={Boolean(loadError)}
          refreshing={Boolean(actions?.isRefreshingInventory)}
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
      {resumeError && resumeErrorVisible ? (
        <p className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-danger/20 bg-danger-soft px-4 py-2 text-sm text-danger" role="alert">
          <span className="min-w-0 flex-1">Resume failed: {resumeError}</span>
          <button type="button" onClick={() => actions?.resumeDiscovery?.()} className="font-semibold underline underline-offset-2">Retry</button>
          <NoticeDismissButton label="Dismiss resume error" onClick={dismissResumeError} />
        </p>
      ) : null}
      {children(inventory, freshness)}
      {scopedRefresh ? (
        <span id={scopeDescriptionId} className="sr-only">
          Refresh updates {scopeLabel}. Other inventory families stay as they are.
        </span>
      ) : null}
    </>
  );
}
