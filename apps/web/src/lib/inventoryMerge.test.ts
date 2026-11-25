import { describe, expect, it } from 'vitest';
import {
  RESOURCE_FAMILIES,
  type DiscoveryProgress,
  type FamilyProgress,
  type InventorySnapshot,
  type ResourceFamily,
  type RetrievalWarning,
} from '@dcat/core';
import { demoInventory } from '@dcat/test-fixtures';
import { mergeInventorySnapshot } from './inventoryMerge.ts';

type FamilyOverrides = Partial<Record<ResourceFamily, Partial<FamilyProgress>>>;
type RowOverrides = Partial<Pick<
  InventorySnapshot,
  'dataSpaces' | 'dlos' | 'dmos' | 'mappings' | 'dataStreams' | 'dataTransforms' | 'relationships'
>>;

function progress(state: DiscoveryProgress['state'], overrides: FamilyOverrides = {}): DiscoveryProgress {
  const families = RESOURCE_FAMILIES.map((family) => ({
    family,
    status: 'not-started' as FamilyProgress['status'],
    loaded: 0,
    total: null,
    pagesFetched: 0,
    hasMore: false,
    error: null,
    ...overrides[family],
  }));
  return {
    sessionId: 'session-1',
    generation: 'generation-1',
    state,
    loaded: families.reduce((sum, family) => sum + family.loaded, 0),
    total: null,
    families,
    message: null,
  };
}

function snapshot(
  rows: RowOverrides = {},
  discovery = progress('running'),
  warnings: RetrievalWarning[] = [],
): InventorySnapshot {
  return {
    ...structuredClone(demoInventory),
    dataSpaces: [],
    dlos: [],
    dmos: [],
    mappings: [],
    dataStreams: [],
    dataTransforms: [],
    relationships: [],
    ...rows,
    progress: discovery,
    warnings,
  } as InventorySnapshot;
}

function manyDlos(count: number): InventorySnapshot['dlos'] {
  const row = demoInventory.dlos[0]!;
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(row),
    apiName: `DLO_${index}`,
  })) as InventorySnapshot['dlos'];
}

describe('mergeInventorySnapshot', () => {
  it('returns the incoming snapshot when nothing was cached', () => {
    const incoming = snapshot();
    expect(mergeInventorySnapshot(undefined, incoming)).toBe(incoming);
  });

  it('keeps all loaded rows while a refresh reports only the first one', () => {
    const previous = snapshot({}, progress('running', {
      dlos: { status: 'partial', loaded: 8, pagesFetched: 1, hasMore: true },
    }));
    previous.dlos = manyDlos(8);
    const incomingRow = { ...structuredClone(previous.dlos[0]!), label: 'Renamed' };
    const incoming = snapshot(
      { dlos: [incomingRow] },
      progress('running', { dlos: { status: 'partial', loaded: 1, pagesFetched: 1, hasMore: true } }),
    );

    const merged = mergeInventorySnapshot(previous, incoming);

    expect(merged.dlos).toHaveLength(8);
    expect(merged.dlos[0]).toBe(incomingRow);
    expect(merged.dlos[1]).toBe(previous.dlos[1]);
    expect(merged.dataSpaces).toBe(previous.dataSpaces);
    expect(merged.relationships).toBe(previous.relationships);
    expect(merged.progress).toBe(incoming.progress);
  });

  it('replaces only the row that actually changed', () => {
    const previous = snapshot({}, progress('running', {
      dlos: { status: 'partial', loaded: 10, pagesFetched: 2, hasMore: true },
    }));
    previous.dlos = manyDlos(10);
    const incomingRows = structuredClone(previous.dlos);
    incomingRows[4] = { ...incomingRows[4]!, label: 'Updated' };
    const incoming = snapshot(
      { dlos: incomingRows },
      progress('running', { dlos: { status: 'partial', loaded: 10, pagesFetched: 2, hasMore: true } }),
    );

    const merged = mergeInventorySnapshot(previous, incoming);

    expect(merged.dlos).toHaveLength(10);
    expect(merged.dlos[4]).toBe(incomingRows[4]);
    for (const index of [0, 1, 2, 3, 5, 6, 7, 8, 9]) {
      expect(merged.dlos[index]).toBe(previous.dlos[index]);
    }
  });

  it('keeps a thousand rows visible while merging a new page', () => {
    const previous = snapshot({}, progress('running', {
      dlos: { status: 'partial', loaded: 1000, pagesFetched: 100, hasMore: true },
    }));
    previous.dlos = manyDlos(1000);
    const incomingRows = structuredClone(previous.dlos);
    incomingRows[999] = { ...incomingRows[999]!, label: 'Updated' };
    incomingRows.push({ ...structuredClone(demoInventory.dlos[1]!), apiName: 'DLO_NEW' });
    const incoming = snapshot(
      { dlos: incomingRows },
      progress('running', { dlos: { status: 'partial', loaded: 1001, pagesFetched: 101, hasMore: true } }),
    );

    const merged = mergeInventorySnapshot(previous, incoming);

    expect(merged.dlos).toHaveLength(1001);
    expect(merged.dlos[999]!.label).toBe('Updated');
    expect(merged.dlos[1000]!.apiName).toBe('DLO_NEW');
  });

  it('is idempotent when the same page is published again', () => {
    const previous = snapshot({}, progress('running'));
    previous.dlos = manyDlos(10);
    const incoming = snapshot(
      { dlos: [...structuredClone(previous.dlos), { ...structuredClone(demoInventory.dlos[0]!), apiName: 'NEW' }] },
      progress('running', { dlos: { status: 'partial', loaded: 11, pagesFetched: 2, hasMore: true } }),
    );

    const once = mergeInventorySnapshot(previous, incoming);
    const twice = mergeInventorySnapshot(once, incoming);

    expect(twice.dlos).toHaveLength(11);
  });

  it('removes missing rows only after a clean complete pass', () => {
    const previous = snapshot({}, progress('complete', {
      dlos: { status: 'complete', loaded: 10, pagesFetched: 2 },
    }));
    previous.dlos = manyDlos(10);
    const incoming = snapshot(
      { dlos: manyDlos(9) },
      progress('complete', { dlos: { status: 'complete', loaded: 9, pagesFetched: 2 } }),
    );

    expect(mergeInventorySnapshot(previous, incoming).dlos).toHaveLength(9);
  });

  it('clears rows for a family confirmed empty by a real page fetch', () => {
    const previous = snapshot({}, progress('complete', {
      dlos: { status: 'complete', loaded: 10, pagesFetched: 2 },
    }));
    previous.dlos = manyDlos(10);
    const incoming = snapshot(
      { dlos: [] },
      progress('complete', { dlos: { status: 'complete', loaded: 0, pagesFetched: 1 } }),
    );

    expect(mergeInventorySnapshot(previous, incoming).dlos).toEqual([]);
  });

  it('keeps rows when a gap warning makes a shorter result untrustworthy', () => {
    const previous = snapshot({}, progress('complete', {
      dlos: { status: 'complete', loaded: 10, pagesFetched: 2 },
    }));
    previous.dlos = manyDlos(10);
    const incoming = snapshot(
      { dlos: manyDlos(9) },
      progress('complete', { dlos: { status: 'complete', loaded: 9, pagesFetched: 2 } }),
      [{ family: 'dlos', code: 'EXPECTED_COUNT_MISMATCH', message: 'gap', severity: 'warning' }],
    );

    expect(mergeInventorySnapshot(previous, incoming).dlos).toHaveLength(10);
  });

  it('keeps rows for a failed family even when the session is terminal', () => {
    const previous = snapshot({}, progress('failed', {
      dlos: { status: 'failed', loaded: 10, pagesFetched: 2 },
    }));
    previous.dlos = manyDlos(10);
    const incoming = snapshot(
      { dlos: manyDlos(3) },
      progress('failed', { dlos: { status: 'failed', loaded: 3, pagesFetched: 3 } }),
    );

    expect(mergeInventorySnapshot(previous, incoming).dlos).toHaveLength(10);
  });

  it('does not delete rows for a family that never actually fetched', () => {
    const previous = snapshot({}, progress('complete', {
      dlos: { status: 'complete', loaded: 10, pagesFetched: 2 },
    }));
    previous.dlos = manyDlos(10);
    const incoming = snapshot(
      {},
      progress('complete', { dlos: { status: 'complete', loaded: 0, pagesFetched: 0 } }),
    );

    expect(mergeInventorySnapshot(previous, incoming).dlos).toHaveLength(10);
  });

  it('reconciles mappings by endpoints and fields, not the optional apiName', () => {
    const previousMapping = structuredClone(demoInventory.mappings[0]!);
    const previous = snapshot({ mappings: [previousMapping] });
    const incomingMapping = { ...structuredClone(previousMapping), apiName: 'Renamed_Mapping' };
    const incoming = snapshot({ mappings: [incomingMapping] });

    const merged = mergeInventorySnapshot(previous, incoming);

    expect(merged.mappings).toHaveLength(1);
    expect(merged.mappings[0]).toBe(incomingMapping);
  });

  it('distinguishes streams that share an apiName from different connectors', () => {
    const first = { ...structuredClone(demoInventory.dataStreams[0]!), sourceConnector: 'A' };
    const second = { ...structuredClone(demoInventory.dataStreams[0]!), sourceConnector: 'B' };
    const previous = snapshot({ dataStreams: [first, second] });
    const updated = { ...structuredClone(first), status: 'Updated' };
    const incoming = snapshot({ dataStreams: [updated] });

    const merged = mergeInventorySnapshot(previous, incoming);

    expect(merged.dataStreams).toHaveLength(2);
    expect(merged.dataStreams.find((row) => row.sourceConnector === 'A')!.status).toBe('Updated');
    expect(merged.dataStreams.find((row) => row.sourceConnector === 'B')).toBe(second);
  });

  it('replaces relationships only when their source family finished cleanly', () => {
    const previous = snapshot({ relationships: structuredClone(demoInventory.relationships) }, progress('running'));
    const incoming = snapshot({}, progress('running'));

    expect(mergeInventorySnapshot(previous, incoming).relationships).toBe(previous.relationships);

    const terminal = snapshot(
      { relationships: [] },
      progress('complete', { dmos: { status: 'complete', loaded: 8, pagesFetched: 1 } }),
    );
    expect(mergeInventorySnapshot(previous, terminal).relationships).toEqual([]);
  });

  it('unions relay chunks even when the final chunk reports a complete pass', () => {
    const complete = progress('complete', {
      dlos: { status: 'complete', loaded: 4, pagesFetched: 1 },
    });
    const all = manyDlos(4);
    const chunkWarning: RetrievalWarning = {
      family: 'inventory',
      code: 'RESPONSE_CHUNKED',
      message: 'Loaded in smaller batches.',
      severity: 'info',
    };
    const first = snapshot({ dlos: all.slice(0, 2) }, complete, [
      chunkWarning,
      { family: 'inventory', code: 'MORE_ITEMS_AVAILABLE', message: 'More rows.', severity: 'info' },
    ]);
    const second = snapshot({ dlos: all.slice(2) }, complete, [chunkWarning]);

    expect(mergeInventorySnapshot(mergeInventorySnapshot(first, second), second).dlos).toHaveLength(4);
  });
});
