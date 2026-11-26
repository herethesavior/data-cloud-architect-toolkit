import { describe, expect, it } from 'vitest';
import { demoInventory } from '@dcat/test-fixtures';
import type { InventorySnapshot } from '@dcat/core';
import { settleInterruptedInventory } from './inventorySettlement.ts';

function runningSnapshot(): InventorySnapshot {
  return {
    ...demoInventory,
    warnings: [],
    progress: {
      sessionId: 'session-1',
      generation: 'generation-1',
      state: 'running',
      loaded: 5,
      total: 10,
      families: [{
        family: 'dlos',
        status: 'running',
        loaded: 5,
        total: 10,
        pagesFetched: 1,
        hasMore: true,
      }],
      message: 'Loading in batches.',
    },
  };
}

describe('settleInterruptedInventory', () => {
  it('keeps loaded rows, stops the spinner, and exposes a resumable gap', () => {
    const before = runningSnapshot();
    const after = settleInterruptedInventory(before);

    expect(after.dlos).toBe(before.dlos);
    expect(after.progress?.state).toBe('partial');
    expect(after.progress?.families.every((family) => !family.hasMore)).toBe(true);
    expect(after.warnings).toEqual([expect.objectContaining({
      code: 'DISCOVERY_INTERRUPTED',
      severity: 'warning',
    })]);
  });

  it('does not rewrite a settled snapshot and does not duplicate the warning', () => {
    const stopped = settleInterruptedInventory(runningSnapshot());
    expect(settleInterruptedInventory(stopped)).toBe(stopped);
  });
});
