import { RESOURCE_FAMILIES } from '@dcat/core';
import type { InventorySnapshot, ResourceFamily } from '@dcat/core';
import type { Page } from '../navigation.ts';
import { humanizeResource } from './resourceStatus.ts';

export const ALL_REFRESH_FAMILIES: readonly ResourceFamily[] = RESOURCE_FAMILIES;

export interface RefreshScope {
  /** Families that must be fetched again. An empty scope means everything. */
  families: readonly ResourceFamily[];
  /** Human-facing description used by refresh controls and status messages. */
  label: string;
}

const FULL_SCOPE: RefreshScope = { families: ALL_REFRESH_FAMILIES, label: 'the full inventory' };

function scope(families: readonly ResourceFamily[]): RefreshScope {
  return { families, label: describeRefreshFamilies(families) };
}

/**
 * Each view refreshes its own family plus the families that directly join to
 * it. Derived views and the Dashboard keep the whole inventory so their summary
 * and cross-family joins stay coherent after a refresh.
 */
const PAGE_SCOPES: Partial<Record<Page, RefreshScope>> = {
  dashboard: FULL_SCOPE,
  settings: FULL_SCOPE,
  'data-spaces': FULL_SCOPE,
  dlos: scope(['dlos', 'mappings', 'data-streams']),
  // Relationships are derived from DMOs, so refreshing DMOs refreshes them too.
  dmos: scope(['dmos', 'mappings']),
  mappings: scope(['mappings', 'dlos', 'dmos']),
  'data-streams': scope(['data-streams', 'dlos']),
  'data-transforms': scope(['data-transforms']),
  erd: scope(['dlos', 'dmos', 'mappings']),
  lineage: FULL_SCOPE,
  'change-impact': FULL_SCOPE,
  dictionary: FULL_SCOPE,
};

export function refreshScopeForPage(page: Page): RefreshScope {
  return PAGE_SCOPES[page] ?? FULL_SCOPE;
}

export function isFullRefresh(families: readonly ResourceFamily[]): boolean {
  return families.length >= RESOURCE_FAMILIES.length
    && RESOURCE_FAMILIES.every((family) => families.includes(family));
}

const FAMILY_FIELDS = {
  'data-spaces': 'dataSpaces',
  dlos: 'dlos',
  dmos: 'dmos',
  mappings: 'mappings',
  'data-streams': 'dataStreams',
  'data-transforms': 'dataTransforms',
} as const satisfies Record<ResourceFamily, keyof InventorySnapshot>;

/**
 * A scoped refresh applies only the families the user asked for. The React
 * Query merge keeps every other family from the current snapshot, so unrelated
 * rows never disappear while a page-level refresh is in flight.
 */
export function scopeInventorySnapshot(
  snapshot: InventorySnapshot,
  families: readonly ResourceFamily[],
): InventorySnapshot {
  if (isFullRefresh(families)) return snapshot;
  const scope = new Set(families);
  const scoped = { ...snapshot };

  for (const family of Object.keys(FAMILY_FIELDS) as ResourceFamily[]) {
    if (scope.has(family)) continue;
    Object.assign(scoped, { [FAMILY_FIELDS[family]]: [] });
  }
  // Relationship edges are derived from DMOs, not an independent family.
  if (!scope.has('dmos')) scoped.relationships = [];

  if (snapshot.progress) {
    const scopedFamilies = snapshot.progress.families.filter((family) => scope.has(family.family));
    const totals = scopedFamilies.map((family) =>
      family.expectedTotal ?? (family.total !== null && (!family.hasMore || family.total > family.loaded)
        ? family.total
        : null));
    scoped.progress = {
      ...snapshot.progress,
      families: scopedFamilies,
      loaded: scopedFamilies.reduce((sum, family) => sum + family.loaded, 0),
      total: totals.every((total): total is number => total !== null)
        ? totals.reduce((sum, total) => sum + total, 0)
        : null,
    };
  }

  // Warnings still describe rows kept from earlier passes. Dropping them here
  // would make a retained gap look clean, so the full set survives every scope.

  return scoped;
}

export function describeRefreshFamilies(families: readonly ResourceFamily[]): string {
  if (isFullRefresh(families)) return 'the full inventory';
  // Keep acronyms intact but use sentence case for everything after the first
  // family so labels read naturally ("DLOs, mappings, and data streams").
  const names = families.map((family) => {
    const name = humanizeResource(family);
    return name === 'DLOs' || name === 'DMOs' ? name : name.toLowerCase();
  });
  if (names.length <= 1) return names[0] ?? 'inventory';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}
