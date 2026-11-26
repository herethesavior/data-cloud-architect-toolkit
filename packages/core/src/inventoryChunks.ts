import type { InventorySnapshot } from './domain.ts';

/** Emitted on every chunk so partial arrays are merged instead of replacing rows. */
export const RESPONSE_CHUNKED_WARNING = 'RESPONSE_CHUNKED';
/** Tells the browser another chunk is queued for the same relay request. */
export const MORE_ITEMS_AVAILABLE_WARNING = 'MORE_ITEMS_AVAILABLE';
/** A single oversized row was compacted so the rest of the inventory can render. */
export const ITEM_DETAILS_OMITTED_WARNING = 'ITEM_DETAILS_OMITTED';
/** Small row batches keep every explorer responsive while progressive rows land. */
export const MAX_CHUNK_ROWS = 5;

type ArrayField =
  | 'dataSpaces'
  | 'dlos'
  | 'dmos'
  | 'mappings'
  | 'dataStreams'
  | 'dataTransforms'
  | 'relationships';

const ARRAY_FIELDS: readonly ArrayField[] = [
  'dataSpaces',
  'dlos',
  'dmos',
  'mappings',
  'dataStreams',
  'dataTransforms',
  'relationships',
];

const FAMILY_BY_FIELD: Record<ArrayField, string> = {
  dataSpaces: 'data-spaces',
  dlos: 'dlos',
  dmos: 'dmos',
  mappings: 'mappings',
  dataStreams: 'data-streams',
  dataTransforms: 'data-transforms',
  relationships: 'relationships',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function isInventorySnapshotLike(value: unknown): value is InventorySnapshot {
  return isRecord(value)
    && Array.isArray(value.capabilities)
    && Array.isArray(value.warnings)
    && ARRAY_FIELDS.every((field) => Array.isArray(value[field]));
}

function emptySnapshot(snapshot: InventorySnapshot): InventorySnapshot {
  const result: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
  for (const field of ARRAY_FIELDS) result[field] = [];
  result.warnings = [];
  return result as unknown as InventorySnapshot;
}

function compactRow(field: ArrayField, row: unknown): unknown {
  if (!isRecord(row)) return row;
  const compact: Record<string, unknown> = { ...row };
  if (field === 'dataTransforms') {
    delete compact.definition;
    delete compact.raw;
  } else if (field === 'dlos' || field === 'dmos') {
    delete compact.fields;
  }
  return compact;
}

interface PendingChunk {
  snapshot: InventorySnapshot;
  omitted: Set<string>;
}

function finalizeChunk(pending: PendingChunk, hasMore: boolean): InventorySnapshot {
  const warnings = [
    ...pending.snapshot.warnings,
    {
      family: 'inventory',
      code: RESPONSE_CHUNKED_WARNING,
      message: 'Loaded in smaller batches.',
      severity: 'info' as const,
    },
  ];
  for (const family of pending.omitted) {
    warnings.push({
      family,
      code: ITEM_DETAILS_OMITTED_WARNING,
      message: 'Some large record details were omitted to keep this view responsive.',
      severity: 'warning' as const,
    });
  }
  if (hasMore) {
    warnings.push({
      family: 'inventory',
      code: MORE_ITEMS_AVAILABLE_WARNING,
      message: 'More metadata is ready to load.',
      severity: 'info' as const,
    });
  }
  const progress = pending.snapshot.progress
    ? {
        ...pending.snapshot.progress,
        state: hasMore ? 'running' as const : pending.snapshot.progress.state,
        message: hasMore ? 'Loading metadata in smaller batches.' : pending.snapshot.progress.message,
      }
    : pending.snapshot.progress;
  return { ...pending.snapshot, warnings, progress };
}

/**
 * Split an inventory into relay-sized snapshots. Rows are kept in discovery
 * order and every chunk carries the same progress envelope, so the browser can
 * union them without mistaking a partial page for a complete replacement.
 */
export function chunkInventorySnapshot(
  snapshot: InventorySnapshot,
  maxBytes: number,
  maxRows = MAX_CHUNK_ROWS,
): InventorySnapshot[] {
  const chunks: PendingChunk[] = [];
  const rowLimit = Math.max(1, Math.floor(maxRows));
  let current = emptySnapshot(snapshot);
  let omitted = new Set<string>();
  let bytes = byteLength(current);
  let rowsInChunk = 0;

  for (const field of ARRAY_FIELDS) {
    const rows = snapshot[field] as readonly unknown[];
    for (const original of rows) {
      const oversized = byteLength(original) > Math.max(64 * 1024, Math.floor(maxBytes / 2));
      const row = oversized ? compactRow(field, original) : original;
      if (oversized) omitted.add(FAMILY_BY_FIELD[field]);
      const addition = byteLength(row) + 1;
      if (rowsInChunk > 0 && (rowsInChunk >= rowLimit || bytes + addition > maxBytes)) {
        chunks.push({ snapshot: current, omitted });
        current = emptySnapshot(snapshot);
        omitted = new Set<string>();
        bytes = byteLength(current);
        rowsInChunk = 0;
      }
      (current[field] as unknown[]).push(row);
      bytes += addition;
      rowsInChunk += 1;
    }
  }
  if (rowsInChunk > 0) chunks.push({ snapshot: current, omitted });
  if (chunks.length <= 1) return [snapshot];
  return chunks.map((pending, index) => finalizeChunk(pending, index < chunks.length - 1));
}

/** Supports both progressive session results and legacy all-at-once snapshots. */
export function chunkRelayResult<T>(result: T, maxBytes: number): T[] | null {
  if (isRecord(result) && isInventorySnapshotLike(result.snapshot)) {
    const chunks = chunkInventorySnapshot(result.snapshot, maxBytes);
    if (chunks.length <= 1) return null;
    return chunks.map((snapshot) => ({ ...result, snapshot }) as T);
  }
  if (isInventorySnapshotLike(result)) {
    const chunks = chunkInventorySnapshot(result, maxBytes);
    return chunks.length <= 1 ? null : chunks as T[];
  }
  return null;
}
