import {
  type DiscoveryProgress,
  type FamilyProgress,
  type InventorySnapshot,
  type ResourceFamily,
  type RetrievalWarning,
  ITEM_DETAILS_OMITTED_WARNING,
  MORE_ITEMS_AVAILABLE_WARNING,
  RESPONSE_CHUNKED_WARNING,
} from '@dcat/core';
import { streamRowKey } from './streamDetail.ts';

type MergeFamily = ResourceFamily | 'relationships';

const FAMILY_FIELDS = {
  'data-spaces': 'dataSpaces',
  dlos: 'dlos',
  dmos: 'dmos',
  mappings: 'mappings',
  'data-streams': 'dataStreams',
  'data-transforms': 'dataTransforms',
} as const satisfies Record<ResourceFamily, keyof InventorySnapshot>;

/**
 * A completed cursor that hit a limit, a deadline, or a failed query cannot
 * prove a missing row was deleted. Deletion is only allowed when none of these
 * warnings applies to the family being reconciled.
 */
const GAP_WARNING_CODES = new Set([
  'API_VERSION_UNAVAILABLE',
  'CONTINUATION_LOOP',
  'CONTINUATION_MISSING',
  'COUNT_PROBE_FAILED',
  'DISCOVERY_DEADLINE',
  'DISCOVERY_INTERRUPTED',
  'EXPECTED_COUNT_MISMATCH',
  'ITEMS_SKIPPED',
  ITEM_DETAILS_OMITTED_WARNING,
  MORE_ITEMS_AVAILABLE_WARNING,
  RESPONSE_CHUNKED_WARNING,
  'MAPPING_QUERY_FAILED',
  'MAPPING_QUERY_LIMIT',
  'OUTPUT_LIMIT',
  'PAGINATION_LIMIT',
  'RELATIONSHIP_ITEMS_SKIPPED',
  'RELATIONSHIP_QUERY_FAILED',
  'RELATIONSHIP_QUERY_LIMIT',
]);

const fingerprints = new WeakMap<object, string>();
const rowKeys = new WeakMap<object, Map<MergeFamily, string>>();

/** Cached so an unchanged row is not serialized again on every 750 ms poll. */
function fingerprint(row: unknown): string {
  if (typeof row !== 'object' || row === null) return String(row);
  let value = fingerprints.get(row);
  if (value === undefined) {
    value = JSON.stringify(row);
    fingerprints.set(row, value);
  }
  return value;
}

/** Keys mirror the producer's `identityFor` so the same row reconciles across runs. */
function rowKey(family: MergeFamily, row: unknown): string {
  if (typeof row === 'object' && row !== null) {
    let byFamily = rowKeys.get(row);
    if (!byFamily) {
      byFamily = new Map();
      rowKeys.set(row, byFamily);
    }
    let key = byFamily.get(family);
    if (key === undefined) {
      key = computeRowKey(family, row);
      byFamily.set(family, key);
    }
    return key;
  }
  return computeRowKey(family, row);
}

function computeRowKey(family: MergeFamily, row: unknown): string {
  const record = row as Record<string, unknown>;
  if (family === 'relationships') return `id|${String(record.id ?? fingerprint(row))}`;
  if (family === 'mappings') {
    const fields = Array.isArray(record.fieldMappings)
      ? record.fieldMappings.map((field) => JSON.stringify(field)).join('|')
      : '';
    // `apiName` is a label, not identity: two runs may name the same endpoints
    // and field map differently. Including it would duplicate the mapping.
    return `mapping|${String(record.sourceObject ?? '')}|${String(record.targetObject ?? '')}|${fields}`;
  }
  if (family === 'data-streams') {
    return `stream|${streamRowKey(row as Parameters<typeof streamRowKey>[0])}`;
  }
  if (typeof record.apiName === 'string' && record.apiName) return `apiName|${record.apiName}`;
  if (typeof record.id === 'string' && record.id) return `id|${record.id}`;
  return `raw|${fingerprint(row)}`;
}

function familyProgress(progress: DiscoveryProgress | undefined, family: ResourceFamily): FamilyProgress | undefined {
  return progress?.families.find((entry) => entry.family === family);
}

function hasGap(warnings: readonly RetrievalWarning[], family: ResourceFamily): boolean {
  return warnings.some((warning) => {
    if (!GAP_WARNING_CODES.has(warning.code)) return false;
    if (warning.family === family) return true;
    return warning.family === 'inventory'
      && (warning.code === RESPONSE_CHUNKED_WARNING
        || warning.code === MORE_ITEMS_AVAILABLE_WARNING);
  });
}

/**
 * A shorter array means a real deletion only after a clean, complete pass over
 * that family. `not-started`, failed, gap-flagged, and never-fetched families
 * may be empty simply because discovery stopped before finishing them.
 */
function isAuthoritative(
  progress: DiscoveryProgress | undefined,
  warnings: readonly RetrievalWarning[],
  family: ResourceFamily,
): boolean {
  if (!progress || progress.state === 'running') return false;
  const state = familyProgress(progress, family);
  if (!state || state.status !== 'complete' || state.hasMore || hasGap(warnings, family)) return false;
  return state.pagesFetched > 0 || state.loaded > 0 || state.expectedTotal === 0;
}

/**
 * Union two pages by identity. Previous rows keep their object identity unless
 * the new snapshot actually changed them, so one updated row does not rerender
 * every row in a thousand-item inventory.
 */
function unionRows<T>(family: MergeFamily, previous: readonly T[], incoming: readonly T[], preserveRich: boolean): T[] {
  const merged = [...previous];
  const indexByKey = new Map<string, number>();
  for (let index = 0; index < merged.length; index += 1) {
    const key = rowKey(family, merged[index]);
    if (!indexByKey.has(key)) indexByKey.set(key, index);
  }
  for (const row of incoming) {
    const key = rowKey(family, row);
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, merged.length);
      merged.push(row);
    } else if (fingerprint(merged[index]!) !== fingerprint(row)) {
      // A compacted chunk must never erase details already loaded for the same row.
      if (!preserveRich) merged[index] = row;
    }
  }
  return merged;
}

function mergeRows<T>(
  family: MergeFamily,
  previous: readonly T[] | undefined,
  incoming: readonly T[],
  progress: DiscoveryProgress | undefined,
  warnings: readonly RetrievalWarning[],
): T[] {
  const old = previous ?? [];
  const preserveRich = warnings.some((warning) =>
    warning.code === ITEM_DETAILS_OMITTED_WARNING && warning.family === family);
  // An empty page from an unfinished family is not evidence of deletion. Keep
  // the same array reference so unchanged families do not rerender.
  if (incoming.length === 0) {
    if (isAuthoritative(progress, warnings, family === 'relationships' ? 'dmos' : family)) return [];
    return old as T[];
  }
  if (isAuthoritative(progress, warnings, family === 'relationships' ? 'dmos' : family) && !preserveRich) {
    return [...incoming];
  }
  return unionRows(family, old, incoming, preserveRich);
}

/**
 * Keep everything the user can see while a new discovery runs, reconcile rows
 * by identity as each page arrives, and only trust a clean terminal pass to
 * remove rows. Metadata always comes from the newest snapshot.
 */
export function mergeInventorySnapshot(previous: InventorySnapshot | undefined, incoming: InventorySnapshot): InventorySnapshot {
  if (!previous) return incoming;
  const warnings = incoming.warnings ?? [];
  const merged: Record<string, unknown> = { ...incoming };

  for (const family of Object.keys(FAMILY_FIELDS) as ResourceFamily[]) {
    const field = FAMILY_FIELDS[family];
    merged[field] = mergeRows(
      family,
      previous[field] as readonly unknown[],
      incoming[field] as readonly unknown[],
      incoming.progress,
      warnings,
    );
  }
  merged.relationships = mergeRows(
    'relationships',
    previous.relationships,
    incoming.relationships,
    incoming.progress,
    warnings,
  );
  return merged as unknown as InventorySnapshot;
}
