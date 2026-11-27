import type { InventorySnapshot } from './domain.ts';

/** Emitted on every chunk so partial arrays are merged instead of replacing rows. */
export const RESPONSE_CHUNKED_WARNING = 'RESPONSE_CHUNKED';
/** Tells the browser another chunk is queued for the same relay request. */
export const MORE_ITEMS_AVAILABLE_WARNING = 'MORE_ITEMS_AVAILABLE';
/** A single oversized row was compacted so the rest of the inventory can render. */
export const ITEM_DETAILS_OMITTED_WARNING = 'ITEM_DETAILS_OMITTED';
/** Small row batches keep every explorer responsive while progressive rows land. */
export const MAX_CHUNK_ROWS = 5;
/** Field maps are the bulkiest mapping rows; keep enough to explain the join. */
const MAX_COMPACT_FIELD_MAPPINGS = 12;
/** Identity survives every compaction pass so a trimmed row still identifies a record. */
const IDENTITY_KEYS = new Set(['apiName', 'id', 'name', 'label', 'sourceObject', 'targetObject']);
/**
 * Large orgs must not turn into thousands of relay polls. Small batches are
 * preferred, but the row size grows once that many chunks would be needed.
 */
export const MAX_CHUNK_COUNT = 100;

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
  // Retrieval gaps belong to the source snapshot, not to the transport split.
  // Dropping them would make a partial discovery look authoritative.
  result.warnings = [...(snapshot.warnings ?? [])];
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
  } else if (field === 'mappings' && Array.isArray(compact.fieldMappings)) {
    compact.fieldMappings = compact.fieldMappings.slice(0, MAX_COMPACT_FIELD_MAPPINGS);
  }
  return compact;
}

/** Drop bulky nested structures first; identity fields survive every pass. */
function stripBulkFields(row: Record<string, unknown>, level: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (Array.isArray(value)) {
      if (level === 0 && value.length > 1) result[key] = value.slice(0, 1);
      continue;
    }
    if (isRecord(value)) {
      if (key === 'provenance') {
        result[key] = Object.fromEntries(Object.entries(value).filter(([, nested]) =>
          typeof nested === 'string' || typeof nested === 'number' || typeof nested === 'boolean'));
      }
      continue;
    }
    result[key] = value;
  }
  return result;
}

function truncateStrings(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    result[key] = typeof value === 'string' && value.length > 256 ? `${value.slice(0, 256)}…` : value;
  }
  return result;
}

/**
 * A single row must never make a whole inventory terminal. Trim details in
 * stages, keeping the fields that identify the record, until it fits the chunk
 * budget. The omitted-details warning makes the loss visible to the caller.
 */
function fitRow(field: ArrayField, row: unknown, maxBytes: number): { row: unknown; omitted: boolean } {
  if (!isRecord(row)) return { row, omitted: false };
  const ceiling = Math.max(1_024, maxBytes - 4_096);
  // Keep the established detail threshold for field maps and bulky graphs: a
  // row this large is compacted even when it would technically fit one chunk.
  if (byteLength(row) <= Math.max(64 * 1024, Math.floor(maxBytes / 2))) {
    return { row, omitted: false };
  }
  let compact = compactRow(field, row) as Record<string, unknown>;
  for (let level = 0; level < 3 && byteLength(compact) > ceiling; level += 1) {
    compact = stripBulkFields(compact, level);
  }
  if (byteLength(compact) > ceiling) compact = truncateStrings(compact);
  // A row made almost entirely of scalars survives the staged trimming above.
  // Drop non-identifying keys until the row actually fits the chunk budget.
  for (const key of Object.keys(compact)) {
    if (byteLength(compact) <= ceiling) break;
    if (!IDENTITY_KEYS.has(key)) delete compact[key];
  }
  if (byteLength(compact) > ceiling) {
    for (const key of Object.keys(compact)) compact[key] = String(compact[key]).slice(0, 64);
  }
  return { row: compact, omitted: true };
}

interface PendingChunk {
  snapshot: InventorySnapshot;
  omitted: Set<string>;
}

function finalizeChunk(
  pending: PendingChunk,
  hasMore: boolean,
  cumulative: ReadonlyMap<string, number>,
): InventorySnapshot {
  const warnings = [
    ...pending.snapshot.warnings,
    {
      family: 'inventory',
      code: RESPONSE_CHUNKED_WARNING,
      message: 'Loaded in smaller batches. Deletions are not reconciled until a complete unsplit pass.',
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
  // Counters describe what the browser has accumulated so far, not the full
  // source snapshot that has not been delivered yet.
  const progress = pending.snapshot.progress
    ? {
        ...pending.snapshot.progress,
        state: hasMore ? 'running' as const : pending.snapshot.progress.state,
        message: hasMore ? 'Loading metadata in smaller batches.' : pending.snapshot.progress.message,
        loaded: ARRAY_FIELDS
          .filter((field) => field !== 'relationships')
          .reduce((sum, field) => sum + (cumulative.get(FAMILY_BY_FIELD[field]) ?? 0), 0),
        families: pending.snapshot.progress.families.map((family) => ({
          ...family,
          loaded: cumulative.get(family.family) ?? 0,
        })),
      }
    : pending.snapshot.progress;
  const capabilities = pending.snapshot.capabilities.map((capability) =>
    capability.family === 'api-versions'
      ? capability
      : { ...capability, itemCount: cumulative.get(capability.family) ?? capability.itemCount });
  return { ...pending.snapshot, warnings, progress, capabilities };
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
  const totalRows = ARRAY_FIELDS.reduce((sum, field) =>
    sum + (snapshot[field] as readonly unknown[]).length, 0);
  const rowLimit = Math.max(1, Math.floor(maxRows), Math.ceil(totalRows / MAX_CHUNK_COUNT));
  let current = emptySnapshot(snapshot);
  let omitted = new Set<string>();
  let compacted = false;
  let bytes = byteLength(current);
  let rowsInChunk = 0;

  for (const field of ARRAY_FIELDS) {
    const rows = snapshot[field] as readonly unknown[];
    for (const original of rows) {
      const fitted = fitRow(field, original, maxBytes);
      const row = fitted.row;
      if (fitted.omitted) {
        omitted.add(FAMILY_BY_FIELD[field]);
        compacted = true;
      }
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
  // A compacted single row must still be delivered through the chunk envelope,
  // otherwise the oversized original would bypass the size check entirely.
  if (chunks.length <= 1 && !compacted) return [snapshot];
  const cumulative = new Map<string, number>();
  const chunkCounts = chunks.map((pending) => {
    for (const field of ARRAY_FIELDS) {
      const family = FAMILY_BY_FIELD[field];
      cumulative.set(family, (cumulative.get(family) ?? 0) + pending.snapshot[field].length);
    }
    return new Map(cumulative);
  });
  return chunks.map((pending, index) =>
    finalizeChunk(pending, index < chunks.length - 1, chunkCounts[index]!));
}

/** Supports both progressive session results and legacy all-at-once snapshots. */
export function chunkRelayResult<T>(result: T, maxBytes: number): T[] | null {
  if (isRecord(result) && isInventorySnapshotLike(result.snapshot)) {
    const original = result.snapshot;
    const chunks = chunkInventorySnapshot(original, maxBytes);
    // One compacted row is still a new snapshot that must be delivered; only
    // an untouched single snapshot needs no chunk envelope.
    if (chunks.length <= 1 && chunks[0] === original) return null;
    return chunks.map((snapshot) => ({ ...result, snapshot }) as T);
  }
  if (isInventorySnapshotLike(result)) {
    const original = result as InventorySnapshot;
    const chunks = chunkInventorySnapshot(original, maxBytes);
    if (chunks.length <= 1 && chunks[0] === original) return null;
    return chunks as T[];
  }
  return null;
}
