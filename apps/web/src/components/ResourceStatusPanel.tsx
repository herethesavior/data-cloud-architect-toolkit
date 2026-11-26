import type { InventorySnapshot } from '@dcat/core';
import { Badge } from './ui/index.ts';
import type { BadgeTone } from './ui/index.ts';
import { Icon } from './Icon.tsx';
import { data360NotEnabled, hasDegradedResources, humanizeResource, statusLabel } from '../lib/resourceStatus.ts';
import type { ResourceStage, ResourceStageState } from '../lib/resourceStatus.ts';
import { useDismissibleNotice } from '../lib/noticeDismissal.ts';
import { NoticeDismissButton } from './NoticeDismissButton.tsx';

const stateTone: Record<ResourceStageState, BadgeTone> = {
  complete: 'success',
  loading: 'brand',
  partial: 'warning',
  blocked: 'danger',
  pending: 'neutral',
};

const stateIcon: Record<ResourceStageState, 'check' | 'refresh' | 'warning' | 'info' | 'clock'> = {
  complete: 'check',
  loading: 'refresh',
  partial: 'warning',
  blocked: 'warning',
  pending: 'clock',
};

interface DiscoveryProgressProps {
  stages: ResourceStage[];
  label?: string;
}

/** Shows the four discovery stages while the first scoped snapshot loads. */
export function DiscoveryProgress({ stages, label = 'Discovering your Data 360 inventory' }: DiscoveryProgressProps) {
  return (
    <section className="panel px-6 py-6" aria-busy="true" aria-label={label}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="label-xs">Automatic inventory load</p>
          <h3 className="mt-1 text-base font-semibold text-ink">{label}</h3>
        </div>
        <Badge tone="brand" dot>Discovering</Badge>
      </div>
      <ol className="mt-5 space-y-2">
        {stages.map((stage) => (
          <li
            key={stage.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-alt px-3 py-2.5"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <Icon
                name={stateIcon[stage.state]}
                size={16}
                className={stage.state === 'loading' ? 'animate-spin text-brand' : 'text-ink-faint'}
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{stage.label}</p>
                <p className="truncate text-xs text-ink-soft">{stage.detail}</p>
              </div>
            </div>
            <Badge tone={stateTone[stage.state]}>{statusLabel(stage.state)}</Badge>
          </li>
        ))}
      </ol>
      <div aria-hidden="true" className="mt-4 space-y-2">
        <div className="skeleton h-2.5 w-2/3 rounded" />
        <div className="skeleton h-2.5 w-1/2 rounded" />
      </div>
    </section>
  );
}

function familyList(families: readonly { family: string }[]): string {
  const names = families.map((capability) => humanizeResource(capability.family));
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

/** Surfaced on every inventory view so one failed family cannot look like empty data. */
export function ResourceStatusNotice({ inventory, onReview }: { inventory: InventorySnapshot; onReview?: () => void }) {
  const data360Unavailable = data360NotEnabled(inventory);
  const failures = inventory.capabilities.filter((capability) =>
    capability.status === 'error' || capability.status === 'forbidden',
  );
  const partial = inventory.capabilities.filter((capability) => capability.status === 'partial');
  const unsupported = inventory.capabilities.filter((capability) => capability.status === 'unsupported');
  const title = data360Unavailable
    ? 'Data 360 is not enabled for this user or org'
    : failures.length > 0
      ? 'Some inventory families need attention'
      : partial.length > 0
        ? 'Inventory loaded with gaps'
        : 'Some inventory families are unavailable';
  const failureDetail = failures.length > 0 ? `${familyList(failures)} could not be retrieved.` : '';
  const partialDetail = partial.length > 0 ? `${familyList(partial)} returned only some records.` : '';
  const detail = data360Unavailable
    ? 'Ask an administrator to enable Data 360 for this user or org. No metadata families are available to retry.'
    : failures.length > 0
      ? `${failureDetail}${partialDetail ? ` ${partialDetail}` : ''} The records that loaded are still available.`
      : partial.length > 0
        ? `Some results are missing from ${familyList(partial)}. The records that loaded are still available.`
        : `${familyList(unsupported)} ${unsupported.length === 1 ? 'is' : 'are'} unavailable for this org or API version. Other loaded families are still available.`;
  const statusSignature = inventory.capabilities
    .map((capability) => `${capability.family}:${capability.status}`)
    .sort()
    .join('|');
  const noticeKey = `${inventory.mode}:${inventory.org.orgId ?? inventory.org.alias}:${
    data360Unavailable ? 'data360' : 'gaps'
  }:${statusSignature}`;
  const { visible, dismiss } = useDismissibleNotice('inventory-status', noticeKey);

  if ((!data360Unavailable && !hasDegradedResources(inventory)) || !visible) return null;

  return (
    <div className={`mb-4 flex flex-wrap items-start gap-3 rounded-lg border px-4 py-3 ${
      data360Unavailable ? 'border-line bg-surface-alt' : 'border-warning/25 bg-warning-soft'
    }`} role="note">
      <Icon name={data360Unavailable ? 'info' : 'warning'} size={17} className={`mt-0.5 shrink-0 ${data360Unavailable ? 'text-brand' : 'text-warning'}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-xs text-ink-soft">{detail}</p>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {onReview ? (
          <button
            type="button"
            onClick={onReview}
            className="shrink-0 text-xs font-semibold text-brand underline underline-offset-2"
          >
            Review discovery health
          </button>
        ) : null}
        <NoticeDismissButton label="Dismiss inventory status notice" onClick={dismiss} />
      </div>
    </div>
  );
}
