import type { InventorySnapshot } from '@dcat/core';

/**
 * Settle a load that was stopped after one or more batches. Rows already in the
 * cache stay intact, but running flags are cleared and an explicit resumable
 * gap is recorded so the UI neither spins forever nor treats a partial family
 * as a complete pass.
 */
export function settleInterruptedInventory(snapshot: InventorySnapshot): InventorySnapshot {
  if (snapshot.progress?.state !== 'running') return snapshot;
  const interrupted = snapshot.warnings.some((warning) => warning.code === 'DISCOVERY_INTERRUPTED');
  return {
    ...snapshot,
    warnings: interrupted ? snapshot.warnings : [...snapshot.warnings, {
      family: 'inventory',
      code: 'DISCOVERY_INTERRUPTED',
      message: 'Loading stopped after several batches. Earlier results were kept.',
      severity: 'warning',
    }],
    progress: {
      ...snapshot.progress,
      state: 'partial',
      message: 'Loading stopped after several batches. Earlier results were kept.',
      families: snapshot.progress.families.map((family) => ({ ...family, hasMore: false })),
    },
  };
}
