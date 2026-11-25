import { describe, expect, it } from 'vitest';
import { RESOURCE_FAMILIES, type DiscoveryProgress, type InventorySnapshot } from '@dcat/core';
import { demoInventory } from '@dcat/test-fixtures';
import { keepRowsUntilRefreshReports } from './inventoryRefresh.ts';

function snapshot(state: DiscoveryProgress['state'], dlosLoaded: number, dlosHasMore: boolean, status: DiscoveryProgress['families'][number]['status'] = 'not-started'): InventorySnapshot {
  const inventory = structuredClone(demoInventory);
  return {
    ...inventory,
    progress: {
      sessionId: 'session-1',
      generation: 'generation-1',
      state,
      loaded: dlosLoaded,
      total: null,
      families: RESOURCE_FAMILIES.map((family) => ({
        family,
        status: family === 'dlos' ? status : 'complete',
        loaded: family === 'dlos' ? dlosLoaded : 0,
        total: null,
        pagesFetched: 0,
        hasMore: family === 'dlos' ? dlosHasMore : false,
        error: null,
      })),
      message: null,
    },
  };
}

describe('keepRowsUntilRefreshReports', () => {
  it('keeps previous rows until the family reports its first page', () => {
    const previous = structuredClone(demoInventory);
    const incoming = snapshot('running', 0, true);

    const merged = keepRowsUntilRefreshReports(previous, incoming);

    expect(merged.dlos).toEqual(previous.dlos);
    expect(merged.dataSpaces).toEqual(previous.dataSpaces);
    expect(merged.relationships).toEqual(previous.relationships);
    expect(merged.progress).toBe(incoming.progress);
  });

  it('accepts an empty completed family instead of stale rows', () => {
    const previous = structuredClone(demoInventory);
    const incoming = {
      ...snapshot('running', 0, false, 'complete'),
      dlos: [],
    };

    const merged = keepRowsUntilRefreshReports(previous, incoming);

    expect(merged.dlos).toEqual([]);
    expect(merged.dataSpaces).toEqual(previous.dataSpaces);
  });

  it('keeps earlier rows when a family fails before reporting any page', () => {
    const previous = structuredClone(demoInventory);
    const incoming = snapshot('running', 0, false, 'failed');

    const merged = keepRowsUntilRefreshReports(previous, incoming);

    expect(merged.dlos).toEqual(previous.dlos);
  });

  it('does not rewrite a final snapshot', () => {
    const previous = structuredClone(demoInventory);
    const incoming = { ...snapshot('complete', 0, false, 'complete'), dlos: [] };

    expect(keepRowsUntilRefreshReports(previous, incoming)).toBe(incoming);
  });
});
