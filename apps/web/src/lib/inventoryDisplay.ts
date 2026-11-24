import type { DiscoveryProgress, FamilyProgress, InventorySnapshot, ResourceFamily } from '@dcat/core';

/** A page-local `total` must never become a final denominator while more pages remain. */
export function hasUsableTotal(loaded: number, total: number | null, hasMore: boolean): boolean {
  if (total === null) return false;
  return hasMore ? total > loaded : total >= loaded;
}

/** Prefer the authoritative count read before loading; fall back to the safe envelope total. */
export function trustedTotal(family: FamilyProgress | undefined): number | null {
  if (!family) return null;
  return family.expectedTotal ?? (hasUsableTotal(family.loaded, family.total, family.hasMore) ? family.total : null);
}

export function familyProgress(inventory: InventorySnapshot, family: ResourceFamily): FamilyProgress | undefined {
  return inventory.progress?.families.find((entry) => entry.family === family);
}

/** Sum expected totals only when every family exposes an authoritative final count. */
export function progressTotal(progress: DiscoveryProgress): number | null {
  const totals = progress.families.map(trustedTotal);
  if (totals.every((total) => total !== null)) {
    return totals.reduce<number>((sum, total) => sum + (total ?? 0), 0);
  }
  return progress.total;
}

export function isFamilyLoading(inventory: InventorySnapshot, family: ResourceFamily): boolean {
  const progress = familyProgress(inventory, family);
  if (!progress) return false;
  if (progress.hasMore) return true;
  return inventory.progress?.state === 'running'
    && (progress.status === 'running' || progress.status === 'not-started' || progress.status === 'partial');
}

export function isInventoryLoading(inventory: InventorySnapshot): boolean {
  return inventory.progress?.state === 'running'
    || Boolean(inventory.progress?.families.some((family) => family.hasMore));
}

/** Compact counter for list headers: `2/100` only when the denominator is real. */
export function loadedCountLabel(loaded: number, total: number | null, hasMore = false): string {
  return hasUsableTotal(loaded, total, hasMore) ? `${loaded}/${total}` : `${loaded} loaded`;
}

/** Sentence form used by the shared progress banner. */
export function loadedDetailLabel(loaded: number, total: number | null, hasMore = false): string {
  return hasUsableTotal(loaded, total, hasMore)
    ? `${loaded} of ${total} records loaded`
    : `${loaded} records loaded so far`;
}

/** Family counter that uses the authoritative final count when available. */
export function familyCountLabel(inventory: InventorySnapshot, family: ResourceFamily, loaded = 0): string {
  const progress = familyProgress(inventory, family);
  const total = trustedTotal(progress);
  return loadedCountLabel(loaded, total, Boolean(progress?.hasMore));
}

/** Demo and legacy snapshots have no progress contract; keep their plain count. */
export function snapshotCountLabel(inventory: InventorySnapshot, family: ResourceFamily, loaded: number): string {
  return inventory.progress ? familyCountLabel(inventory, family, loaded) : String(loaded);
}

/** Filtered-view counter: never presents the loaded subset as the whole inventory. */
export function shownCountLabel(
  shown: number,
  loaded: number,
  total: number | null,
  hasMore = false,
  noun = 'records',
): string {
  if (!hasUsableTotal(loaded, total, hasMore)) {
    return `${shown} shown of ${loaded} ${noun} loaded so far`;
  }
  return `${shown} of ${total} ${noun}`;
}

/** Explorer badge that respects the shared progress contract for one family. */
export function shownFamilyCountLabel(
  inventory: InventorySnapshot,
  family: ResourceFamily,
  shown: number,
  loaded: number,
  noun: string,
): string {
  // Demo and legacy snapshots have no partial-progress contract: their array is
  // the whole dataset, so the familiar concise label remains accurate.
  if (!inventory.progress) return `${shown} of ${loaded} ${noun}`;
  const progress = familyProgress(inventory, family);
  return shownCountLabel(shown, loaded, trustedTotal(progress), Boolean(progress?.hasMore), noun);
}
