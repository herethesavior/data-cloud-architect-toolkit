import { type DiscoveryProgress, type FamilyProgress, type InventorySnapshot, type ResourceFamily } from '@dcat/core';

function shouldKeepPrevious(
  previousRows: readonly unknown[],
  incomingRows: readonly unknown[],
  progress: DiscoveryProgress | undefined,
  family: ResourceFamily,
): boolean {
  if (!progress || progress.state !== 'running' || incomingRows.length > 0 || previousRows.length === 0) return false;
  const familyProgress: FamilyProgress | undefined = progress.families.find((entry) => entry.family === family);
  return familyProgress?.loaded === 0 && (familyProgress.hasMore || familyProgress.status === 'failed');
}

function keep(
  family: ResourceFamily,
  previous: InventorySnapshot,
  incoming: InventorySnapshot,
): boolean {
  return shouldKeepPrevious(previous[FIELD_OF[family]], incoming[FIELD_OF[family]], incoming.progress, family);
}

const FIELD_OF = {
  'data-spaces': 'dataSpaces',
  dlos: 'dlos',
  dmos: 'dmos',
  mappings: 'mappings',
  'data-streams': 'dataStreams',
  'data-transforms': 'dataTransforms',
} as const satisfies Record<ResourceFamily, keyof InventorySnapshot>;

/**
 * A refresh starts with an empty running snapshot. Publishing it as-is makes
 * good rows disappear before the first page lands, and shows counters that do
 * not describe what the user can see. Keep the previous rows for any family
 * that has not produced results yet; once a family settles, its new rows win.
 */
export function keepRowsUntilRefreshReports(previous: InventorySnapshot | undefined, incoming: InventorySnapshot): InventorySnapshot {
  if (!previous || incoming.progress?.state !== 'running') return incoming;
  return {
    ...incoming,
    dataSpaces: keep('data-spaces', previous, incoming) ? previous.dataSpaces : incoming.dataSpaces,
    dlos: keep('dlos', previous, incoming) ? previous.dlos : incoming.dlos,
    dmos: keep('dmos', previous, incoming) ? previous.dmos : incoming.dmos,
    mappings: keep('mappings', previous, incoming) ? previous.mappings : incoming.mappings,
    dataStreams: keep('data-streams', previous, incoming) ? previous.dataStreams : incoming.dataStreams,
    dataTransforms: keep('data-transforms', previous, incoming) ? previous.dataTransforms : incoming.dataTransforms,
    // Relationships are derived after family loading, so they are empty until
    // discovery actually reports them even when families already have rows.
    relationships: incoming.relationships.length === 0 && previous.relationships.length > 0 && incoming.progress?.state === 'running'
      ? previous.relationships
      : incoming.relationships,
  };
}
