import { describe, expect, it } from 'vitest';
import { RESOURCE_FAMILIES } from '@dcat/core';
import type { DiscoveryProgress, InventorySnapshot } from '@dcat/core';
import { demoInventory } from '@dcat/test-fixtures';
import {
  ALL_REFRESH_FAMILIES,
  describeRefreshFamilies,
  isFullRefresh,
  refreshScopeForPage,
  scopeInventorySnapshot,
} from './refreshScope.ts';

const snapshot: InventorySnapshot = {
  ...demoInventory,
  warnings: [{
    family: 'dlos',
    code: 'MORE_ITEMS_AVAILABLE',
    severity: 'warning',
    message: 'Some DLO results may be missing.',
  }],
  progress: {
    sessionId: 'session-1',
    generation: 'generation-1',
    state: 'complete',
    loaded: 210,
    total: 210,
    families: RESOURCE_FAMILIES.map((family, index) => ({
      family,
      status: 'complete',
      loaded: (index + 1) * 10,
      total: (index + 1) * 10,
      expectedTotal: null,
      pagesFetched: 1,
      hasMore: false,
    })),
  } satisfies DiscoveryProgress,
};

describe('refreshScope', () => {
  it('maps each explorer to its primary family and direct joins', () => {
    expect(refreshScopeForPage('dlos').families).toEqual(['dlos', 'mappings', 'data-streams']);
    expect(refreshScopeForPage('dmos').families).toEqual(['dmos', 'mappings']);
    expect(refreshScopeForPage('mappings').families).toEqual(['mappings', 'dlos', 'dmos']);
    expect(refreshScopeForPage('data-streams').families).toEqual(['data-streams', 'dlos']);
    expect(refreshScopeForPage('data-transforms').families).toEqual(['data-transforms']);
    expect(refreshScopeForPage('erd').families).toEqual(['dlos', 'dmos', 'mappings']);
  });

  it('keeps cross-family views and configuration pages on a full refresh', () => {
    for (const page of [
      'dashboard', 'settings', 'data-spaces', 'lineage', 'change-impact', 'dictionary', 'orgs', 'help', 'about',
    ] as const) {
      expect(isFullRefresh(refreshScopeForPage(page).families)).toBe(true);
    }
  });

  it('recognizes a complete family set without depending on its order', () => {
    expect(isFullRefresh(ALL_REFRESH_FAMILIES)).toBe(true);
    expect(isFullRefresh([...RESOURCE_FAMILIES].reverse())).toBe(true);
    expect(isFullRefresh(['dlos', 'mappings'])).toBe(false);
  });

  it('limits a scoped snapshot to the refreshed families while retaining warnings', () => {
    const scoped = scopeInventorySnapshot(snapshot, ['dlos', 'mappings', 'data-streams']);

    expect(scoped.dlos).toEqual(demoInventory.dlos);
    expect(scoped.mappings).toEqual(demoInventory.mappings);
    expect(scoped.dataStreams).toEqual(demoInventory.dataStreams);
    expect(scoped.dataSpaces).toEqual([]);
    expect(scoped.dmos).toEqual([]);
    expect(scoped.dataTransforms).toEqual([]);
    expect(scoped.relationships).toEqual([]);
    expect(scoped.warnings).toEqual(snapshot.warnings);
    expect(scoped.progress?.families.map((family) => family.family)).toEqual(['dlos', 'mappings', 'data-streams']);
    expect(scoped.progress).toMatchObject({ loaded: 110, total: 110 });
  });

  it('keeps relationship edges when DMOs are inside the scope', () => {
    const scoped = scopeInventorySnapshot(snapshot, ['dmos', 'mappings']);

    expect(scoped.dmos).toEqual(demoInventory.dmos);
    expect(scoped.relationships).toEqual(demoInventory.relationships);
    expect(scoped.dlos).toEqual([]);
  });

  it('returns the original snapshot for a full refresh', () => {
    expect(scopeInventorySnapshot(snapshot, ALL_REFRESH_FAMILIES)).toBe(snapshot);
    expect(describeRefreshFamilies(ALL_REFRESH_FAMILIES)).toBe('the full inventory');
  });

  it('derives readable scope labels from the same family lists the UI sends', () => {
    expect(describeRefreshFamilies(['dlos', 'mappings', 'data-streams']))
      .toBe(refreshScopeForPage('dlos').label);
    expect(describeRefreshFamilies(['data-transforms'])).toBe('data transforms');
    expect(describeRefreshFamilies(['mappings', 'dlos', 'dmos'])).toBe('mappings, DLOs, and DMOs');
  });
});
