import type { ApiCapability, InventorySnapshot, ResourceFamily, RetrievalStatus } from '@dcat/core';

export type ResourceStageState = 'complete' | 'loading' | 'partial' | 'blocked' | 'pending';

export interface ResourceStage {
  id: string;
  label: string;
  state: ResourceStageState;
  detail: string;
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

/** Explains the actual retrieval outcome; an empty list is never treated as failure. */
export function resourceStatusMessage(capability: ApiCapability): string {
  if (capability.status === 'forbidden') {
    return 'Access denied. Check Data 360 permissions or API access for this user.';
  }
  if (capability.status === 'unsupported') {
    return capability.message ?? 'This endpoint is unavailable for this org or API version.';
  }
  if (capability.status === 'error') {
    return capability.message ?? 'Discovery failed for this family. Retry the inventory.';
  }
  if (capability.status === 'partial') {
    const count = capability.itemCount ?? 0;
    return `${count} ${count === 1 ? 'item' : 'items'} loaded; some results may be missing. ${capability.message ?? ''}`.trim();
  }
  if (capability.status === 'not-started') return 'Not started.';
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
  if (capabilities.length > 0 && capabilities.every((capability) => capability.status === 'available')) return 'complete';
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
      return {
        id: stage.id,
        label: stage.label,
        state: inventory ? 'complete' : loading ? 'loading' : 'pending',
        detail: inventory
          ? `${inventory.relationships.length} relationship edges in the current snapshot.`
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

    let detail = 'Waiting for the inventory snapshot.';
    if (state === 'loading') detail = `Checking ${stage.families.map(humanizeResource).join(', ')}…`;
    else if (blocking) detail = resourceStatusMessage(blocking);
    else if (partial) detail = resourceStatusMessage(partial);
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
