import { describe, expect, it } from 'vitest';
import type { ApiCapability, InventorySnapshot } from '@dcat/core';
import { demoInventory } from '@dcat/test-fixtures';
import {
  discoveryStages,
  findCapability,
  hasDegradedResources,
  resourceStatusMessage,
  retryableFamilyCount,
} from './resourceStatus.ts';

function capability(overrides: Partial<ApiCapability>): ApiCapability {
  return {
    family: 'data-transforms',
    status: 'available',
    endpoint: '/ssot/data-transforms',
    apiVersion: '64.0',
    itemCount: 3,
    message: null,
    durationMs: 12,
    ...overrides,
  };
}

function inventoryWith(capabilities: ApiCapability[]): InventorySnapshot {
  return { ...structuredClone(demoInventory), capabilities };
}

describe('resource status model', () => {
  it('shows four understandable stages while the first snapshot loads', () => {
    const stages = discoveryStages(null, true);
    expect(stages.map((stage) => stage.id)).toEqual(['identity', 'spaces', 'pipelines', 'relationships']);
    expect(stages.every((stage) => stage.state === 'loading')).toBe(true);
    expect(stages[0]?.detail).toContain('Waiting for the connector');
  });

  it('derives partial and blocked stages from capability results', () => {
    const inventory = inventoryWith([
      capability({ family: 'data-spaces', status: 'available' }),
      capability({ family: 'dlos', status: 'available' }),
      capability({ family: 'dmos', status: 'partial', itemCount: 2, message: '2 of 5 objects returned' }),
      capability({ family: 'data-streams', status: 'forbidden' }),
      capability({ family: 'mappings', status: 'available' }),
      capability({ family: 'data-transforms', status: 'unsupported' }),
    ]);
    const stages = discoveryStages(inventory);

    expect(stages.find((stage) => stage.id === 'spaces')?.state).toBe('partial');
    expect(stages.find((stage) => stage.id === 'pipelines')?.state).toBe('blocked');
    expect(stages.find((stage) => stage.id === 'pipelines')?.detail).toContain('Access denied');
    expect(findCapability(inventory, 'data-transforms')?.status).toBe('unsupported');
    expect(hasDegradedResources(inventory)).toBe(true);
    expect(retryableFamilyCount(inventory)).toBe(0);
  });

  it('counts only transient errors as retryable', () => {
    const inventory = inventoryWith([
      capability({ family: 'dlos', status: 'error', message: 'Gateway timeout' }),
      capability({ family: 'dmos', status: 'forbidden' }),
    ]);
    expect(retryableFamilyCount(inventory)).toBe(1);
    expect(resourceStatusMessage(inventory.capabilities[0]!)).toContain('Gateway timeout');
    expect(resourceStatusMessage(inventory.capabilities[1]!)).toContain('Access denied');
  });

  it('does not treat an empty available family as a failure', () => {
    const inventory = inventoryWith([capability({ status: 'available', itemCount: 0 })]);
    expect(hasDegradedResources(inventory)).toBe(false);
    expect(discoveryStages(inventory).find((stage) => stage.id === 'pipelines')?.state).toBe('complete');
  });

  it('presents the demo snapshot without degraded-resource warnings', () => {
    expect(hasDegradedResources(demoInventory)).toBe(false);
    expect(demoInventory.warnings).toHaveLength(0);
    expect(discoveryStages(demoInventory).every((stage) => stage.state === 'complete')).toBe(true);
  });
});
