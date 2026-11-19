import {
  RESOURCE_FAMILIES,
  type ApiCapability,
  type InventorySnapshot,
  type ResourceFamily,
  type RetrievalStatus,
  type RetrievalWarning,
} from '@dcat/core';

export type ResourceStageState = 'complete' | 'loading' | 'partial' | 'blocked' | 'pending';

export interface ResourceStage {
  id: string;
  label: string;
  state: ResourceStageState;
  detail: string;
}

const RESOURCE_FAMILY_NAMES: ReadonlySet<string> = new Set<string>(RESOURCE_FAMILIES);

function isResourceFamily(family: string): boolean {
  return RESOURCE_FAMILY_NAMES.has(family);
}

const STAGE_FAMILIES: { id: string; label: string; families: ResourceFamily[] }[] = [
  { id: 'identity', label: 'Verifying org access', families: [] },
  { id: 'spaces', label: 'Discovering Data Spaces and objects', families: ['data-spaces', 'dlos', 'dmos'] },
  {
    id: 'pipelines',
    label: 'Loading streams, mappings, and transforms',
    families: ['data-streams', 'mappings', 'data-transforms'],
  },
  { id: 'relationships', label: 'Building relationships and summaries', families: [] },
];

export function humanizeResource(value: string): string {
  const acronyms: Record<string, string> = { dlos: 'DLOs', dmos: 'DMOs' };
  if (acronyms[value]) return acronyms[value];
  return value.replace(/-/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

export function statusLabel(status: RetrievalStatus | ResourceStageState): string {
  return humanizeResource(status);
}

const disabledText = /\bFUNCTIONALITY_NOT_ENABLED\b|\bnot\s+(?:currently\s+)?enabled\s+for\s+this\s+(?:user\s+type\s+or\s+org|org)\b/i;

export function isUnsupportedWarning(warning: RetrievalWarning): boolean {
  return warning.code === 'UNSUPPORTED' || disabledText.test(warning.message);
}

/** Unsupported and informational findings are context, not something a retry can fix. */
export function actionableWarnings(inventory: InventorySnapshot): RetrievalWarning[] {
  return inventory.warnings.filter((warning) =>
    warning.severity !== 'info' && !isUnsupportedWarning(warning));
}

export interface AttentionItem {
  family: string;
  code: string;
  message: string;
  severity: 'warning' | 'error';
}

/**
 * Health and Needs attention must agree. Capability failures are therefore
 * included even when a discovery path did not also emit a warning for them.
 */
export function attentionItems(inventory: InventorySnapshot): AttentionItem[] {
  const items: AttentionItem[] = actionableWarnings(inventory)
    .filter((warning) => isResourceFamily(warning.family))
    .map((warning) => ({
      family: warning.family,
      code: warning.code,
      message: warning.message,
      severity: warning.severity === 'error' ? 'error' : 'warning',
    }));
  for (const capability of inventory.capabilities) {
    if (!isResourceFamily(capability.family)) continue;
    if (capability.status !== 'error' && capability.status !== 'forbidden' && capability.status !== 'partial') continue;
    if (items.some((item) => item.family === capability.family)) continue;
    items.push({
      family: capability.family,
      code: capability.status.toUpperCase(),
      message: resourceStatusMessage(capability),
      severity: capability.status === 'partial' ? 'warning' : 'error',
    });
  }
  return items;
}

export function data360NotEnabled(inventory: InventorySnapshot): boolean {
  const families = inventory.capabilities.filter((capability) => isResourceFamily(capability.family));
  const version = inventory.capabilities.find((capability) => capability.family === 'api-versions');
  const versionUnavailable = version?.status === 'unsupported' || version?.status === 'forbidden';
  if (versionUnavailable && families.length === 0) return true;
  return families.length > 0 && (versionUnavailable || families.every((capability) => capability.status === 'unsupported'));
}

/** Explains the actual retrieval outcome; an empty list is never treated as failure. */
export function resourceStatusMessage(capability: ApiCapability): string {
  if (capability.status === 'forbidden') {
    return 'Access denied. Check Data 360 permissions or API access for this user.';
  }
  if (capability.status === 'unsupported') {
    if (disabledText.test(capability.message ?? '')) {
      return 'Data 360 is not enabled for this user or org.';
    }
    return capability.message ?? 'This endpoint is unavailable for this org or API version.';
  }
  if (capability.status === 'error') {
    return capability.message ?? 'Discovery failed for this family. Retry the inventory.';
  }
  if (capability.status === 'partial') {
    const count = capability.itemCount ?? 0;
    return `${count} ${count === 1 ? 'item' : 'items'} loaded; some results may be missing. ${capability.message ?? ''}`.trim();
  }
  if (capability.status === 'not-started') return capability.message ?? 'Not started.';
  return capability.message ?? 'Loaded successfully.';
}

export function findCapability(
  inventory: InventorySnapshot | null | undefined,
  family: ResourceFamily,
): ApiCapability | null {
  return inventory?.capabilities.find((capability) => capability.family === family) ?? null;
}

function aggregateState(capabilities: ApiCapability[], loading: boolean): ResourceStageState {
  if (loading && capabilities.length === 0) return 'loading';
  if (capabilities.some((capability) => capability.status === 'error' || capability.status === 'forbidden')) return 'blocked';
  if (capabilities.some((capability) => capability.status === 'partial')) return 'partial';
  if (capabilities.length > 0 && capabilities.every((capability) =>
    capability.status === 'available' || capability.status === 'not-started')) return 'complete';
  if (capabilities.some((capability) => capability.status === 'unsupported')) return 'partial';
  return 'pending';
}

/**
 * Client-side progress view derived from the snapshot's own capability results.
 * Discovery still happens in one connector call; this makes its stages legible
 * without inventing progress events the API does not expose.
 */
export function discoveryStages(
  inventory: InventorySnapshot | null | undefined,
  loading = false,
): ResourceStage[] {
  return STAGE_FAMILIES.map((stage) => {
    if (stage.id === 'identity') {
      return {
        id: stage.id,
        label: stage.label,
        state: inventory ? 'complete' : loading ? 'loading' : 'pending',
        detail: inventory ? `${inventory.org.alias} · API v${inventory.apiVersion ?? '—'}` : 'Waiting for the connector.',
      };
    }
    if (stage.id === 'relationships') {
      const gaps = inventory?.warnings.filter((warning) =>
        warning.code.startsWith('RELATIONSHIP') && warning.severity !== 'info') ?? [];
      return {
        id: stage.id,
        label: stage.label,
        state: inventory ? gaps.length > 0 ? 'partial' : 'complete' : loading ? 'loading' : 'pending',
        detail: inventory
          ? `${inventory.relationships.length} relationship edges in the current snapshot.${gaps.length > 0 ? ` ${gaps.length} lookup gap warning(s).` : ''}`
          : 'Waiting for the inventory snapshot.',
      };
    }

    const capabilities = stage.families.flatMap((family) => {
      const capability = findCapability(inventory, family);
      return capability ? [capability] : [];
    });
    const state = aggregateState(capabilities, loading);
    const loaded = capabilities.reduce((sum, capability) => sum + (capability.itemCount ?? 0), 0);
    const blocking = capabilities.find((capability) => capability.status === 'error' || capability.status === 'forbidden');
    const partial = capabilities.find((capability) => capability.status === 'partial');
    const unsupported = capabilities.filter((capability) => capability.status === 'unsupported');
    const skipped = capabilities.find((capability) => capability.status === 'not-started');

    let detail = 'Waiting for the inventory snapshot.';
    if (state === 'loading') detail = `Checking ${stage.families.map(humanizeResource).join(', ')}…`;
    else if (blocking) detail = resourceStatusMessage(blocking);
    else if (unsupported.length === capabilities.length && capabilities.length > 0) {
      detail = resourceStatusMessage(unsupported[0]!);
    } else if (unsupported.length > 0) {
      detail = `${unsupported.length} ${unsupported.length === 1 ? 'family' : 'families'} unavailable for this org.`;
    } else if (partial) detail = resourceStatusMessage(partial);
    else if (skipped) detail = resourceStatusMessage(skipped);
    else if (capabilities.length > 0) detail = `${loaded} ${loaded === 1 ? 'item' : 'items'} across ${stage.families.map(humanizeResource).join(', ')}.`;

    return { id: stage.id, label: stage.label, state, detail };
  });
}

export function hasDegradedResources(inventory: InventorySnapshot): boolean {
  return inventory.capabilities.some((capability) =>
    capability.status === 'error'
    || capability.status === 'forbidden'
    || capability.status === 'partial'
    || capability.status === 'unsupported',
  );
}

export function retryableFamilyCount(inventory: InventorySnapshot): number {
  return inventory.capabilities.filter((capability) => capability.status === 'error').length;
}

/** Resume clears transient failures only; forbidden/unsupported are org facts. */
export function resumableProgressFamilies(inventory: InventorySnapshot): number {
  return inventory.progress?.families.filter((family) =>
    family.status === 'failed'
    && (family.errorStatus === undefined || family.errorStatus === 'error'),
  ).length ?? 0;
}
