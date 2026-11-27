import {
  type ApiCapability,
  type DiscoveryProgress,
  type FamilyProgress,
  type InventorySnapshot,
  type ResourceFamily,
  type RetrievalStatus,
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
// Every chunk carries this warning, including the last one. A chunk only holds
// a slice of the snapshot, so none of them can prove a row was deleted.

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
      && (warning.code === MORE_ITEMS_AVAILABLE_WARNING || warning.code === RESPONSE_CHUNKED_WARNING);
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
  let changed = false;
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
      changed = true;
    } else if (fingerprint(merged[index]!) !== fingerprint(row)) {
      // A compacted chunk must never erase details already loaded for the same row.
      if (!preserveRich) {
        merged[index] = row;
        changed = true;
      }
    }
  }
  // Polling re-parses every row, so an unchanged page would otherwise allocate
  // a new array and invalidate every downstream memo on each progressive poll.
  return changed ? merged : previous as T[];
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
 * A family can report "not started" in a new snapshot while the browser still
 * shows rows from an earlier pass. Reconcile the health metadata with the rows
 * that are actually visible so a populated family never looks unrequested.
 */
function reconcileCapabilities(
  previous: InventorySnapshot,
  incoming: InventorySnapshot,
  visibleCounts: ReadonlyMap<ResourceFamily, number>,
): ApiCapability[] {
  return incoming.capabilities.map((capability) => {
    if (capability.family === 'api-versions') return capability;
    const visible = visibleCounts.get(capability.family) ?? 0;
    if (visible === 0) return capability;
    if (capability.status !== 'not-started' && (capability.itemCount ?? 0) >= visible) return capability;

    const previousStatus = previous.capabilities.find((entry) => entry.family === capability.family)?.status;
    // A skipped family is not a fresh failure. Inheriting a previous error or
    // forbidden result would create a new "needs attention" item without a new
    // retrieval attempt, so keep the rows but mark the retained view partial.
    const previousFailed = previousStatus === 'error' || previousStatus === 'forbidden';
    const authoritative = isAuthoritative(incoming.progress, incoming.warnings ?? [], capability.family);
    const status: RetrievalStatus = capability.status === 'not-started'
      ? previousFailed
        ? 'partial'
        : previousStatus && previousStatus !== 'not-started'
          ? previousStatus
          : authoritative ? 'available' : 'partial'
      : capability.status;
    const message = capability.status === 'not-started'
      ? `Showing ${visible} item(s) loaded earlier; this family was not requested in the latest update.${
        previousFailed ? ` Last known status: ${previousStatus}.` : ''
      }`
      : `${capability.message ?? ''} Showing ${visible} item(s) in the current view.`.trim();
    return { ...capability, status, itemCount: visible, message };
  });
}

/**
 * Keep everything the user can see while a new discovery runs, reconcile rows
 * by identity as each page arrives, and only trust a clean terminal pass to
 * remove rows. Metadata always comes from the newest snapshot, except where the
 * newest capability would contradict rows the browser is still displaying.
 */
export function mergeInventorySnapshot(previous: InventorySnapshot | undefined, incoming: InventorySnapshot): InventorySnapshot {
  if (!previous) return incoming;
  const warnings = incoming.warnings ?? [];
  const merged: Record<string, unknown> = { ...incoming };
  const visibleCounts = new Map<ResourceFamily, number>();

  for (const family of Object.keys(FAMILY_FIELDS) as ResourceFamily[]) {
    const field = FAMILY_FIELDS[family];
    const rows = mergeRows(
      family,
      previous[field] as readonly unknown[],
      incoming[field] as readonly unknown[],
      incoming.progress,
      warnings,
    );
    merged[field] = rows;
    visibleCounts.set(family, rows.length);
  }
  merged.relationships = mergeRows(
    'relationships',
    previous.relationships,
    incoming.relationships,
    incoming.progress,
    warnings,
  );
  merged.capabilities = reconcileCapabilities(previous, incoming, visibleCounts);
  return merged as unknown as InventorySnapshot;
}
