import { describe, expect, it } from 'vitest';
import type { ApiCapability, InventorySnapshot } from '@dcat/core';
import { demoInventory } from '@dcat/test-fixtures';
import {
  actionableWarnings,
  attentionItems,
  data360NotEnabled,
  discoveryStages,
  findCapability,
  hasDegradedResources,
  hasResumableDiscoveryGap,
  isUnsupportedWarning,
  resourceStatusMessage,
  resumableProgressFamilies,
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

  it('does not report relationship discovery as complete when lookup warnings exist', () => {
    const inventory = structuredClone(demoInventory);
    inventory.warnings = [{
      family: 'dmos',
      code: 'RELATIONSHIP_QUERY_LIMIT',
      message: 'Checked the first 500 DMOs; remaining relationship lookups were not attempted.',
      severity: 'warning',
    }];
    const stage = discoveryStages(inventory).find((entry) => entry.id === 'relationships');

    expect(stage?.state).toBe('partial');
    expect(stage?.detail).toContain('1 relationship lookup gap.');
  });

  it('points partial results at discovery health rather than a retry button', () => {
    expect(resourceStatusMessage(capability({ status: 'partial', itemCount: 2, message: null }))).toBe(
      '2 items loaded; some results may be missing. Check Discovery health on the Dashboard for details.',
    );
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

  it('includes capability failures in Needs attention even without warnings', () => {
    const inventory = inventoryWith([
      capability({ family: 'dlos', status: 'error', message: 'Gateway timeout' }),
      capability({ family: 'dmos', status: 'partial', itemCount: 2, message: '2 of 5 loaded' }),
    ]);
    inventory.warnings = [];

    expect(attentionItems(inventory)).toEqual([
      expect.objectContaining({ family: 'dlos', code: 'ERROR', severity: 'error' }),
      expect.objectContaining({ family: 'dmos', code: 'PARTIAL', severity: 'warning' }),
    ]);
  });

  it('does not list the diagnostic version probe in Needs attention', () => {
    const inventory = inventoryWith([
      capability({ family: 'api-versions', status: 'error', message: 'Version probe failed.' }),
    ]);
    inventory.warnings = [
      { family: 'api-versions', code: 'ERROR', message: 'Version probe failed.', severity: 'error' },
    ];

    expect(attentionItems(inventory)).toEqual([]);
  });

  it('does not offer resume for forbidden or unsupported families', () => {
    const inventory = structuredClone(demoInventory);
    inventory.progress = {
      sessionId: 'session-1',
      generation: 'gen-1',
      state: 'failed',
      loaded: 0,
      total: null,
      message: 'Some families stopped after a page failure.',
      families: [
        {
          family: 'dlos', status: 'failed', loaded: 0, total: null,
          pagesFetched: 1, hasMore: false, error: 'Access denied', errorStatus: 'forbidden',
        },
        {
          family: 'dmos', status: 'failed', loaded: 0, total: null,
          pagesFetched: 1, hasMore: false, error: 'Gateway timeout', errorStatus: 'error',
        },
      ],
    };

    expect(resumableProgressFamilies(inventory)).toBe(1);
  });

  it('does not treat an empty available family as a failure', () => {
    const inventory = inventoryWith([capability({ status: 'available', itemCount: 0 })]);
    expect(hasDegradedResources(inventory)).toBe(false);
    expect(discoveryStages(inventory).find((stage) => stage.id === 'pipelines')?.state).toBe('complete');
  });

  it('explains a skipped family without treating it as actionable', () => {
    const message = 'Skipped: no DMOs were found; mapping lookup requires a DMO developer name.';
    const inventory = inventoryWith([
      capability({ family: 'mappings', status: 'not-started', itemCount: 0, message }),
    ]);
    inventory.warnings.push({ family: 'mappings', code: 'MAPPINGS_SKIPPED', message, severity: 'info' });

    expect(resourceStatusMessage(inventory.capabilities[0]!)).toBe(message);
    expect(hasDegradedResources(inventory)).toBe(false);
    expect(actionableWarnings(inventory)).toEqual([]);
    expect(discoveryStages(inventory).find((stage) => stage.id === 'pipelines')).toMatchObject({
      state: 'complete',
      detail: message,
    });
  });

  it('presents the demo snapshot without degraded-resource warnings', () => {
    expect(hasDegradedResources(demoInventory)).toBe(false);
    expect(demoInventory.warnings).toHaveLength(0);
    expect(discoveryStages(demoInventory).every((stage) => stage.state === 'complete')).toBe(true);
  });

  it('offers resume for a terminal snapshot stopped by a deadline or interruption', () => {
    const inventory = structuredClone(demoInventory);
    expect(hasResumableDiscoveryGap(inventory)).toBe(false);

    inventory.progress = { ...inventory.progress!, state: 'complete' };
    inventory.warnings = [{
      family: 'dlos',
      code: 'DISCOVERY_DEADLINE',
      message: 'Discovery stopped after 480 second(s); earlier results were kept.',
      severity: 'warning',
    }];
    expect(hasResumableDiscoveryGap(inventory)).toBe(true);

    inventory.warnings[0]!.code = 'DISCOVERY_INTERRUPTED';
    expect(hasResumableDiscoveryGap(inventory)).toBe(true);
  });
});

const disabledMessage = 'Data 360 is not enabled for this user or org. FUNCTIONALITY_NOT_ENABLED.';

function disabledInventory(): InventorySnapshot {
  return {
    ...structuredClone(demoInventory),
    capabilities: demoInventory.capabilities.map((entry) => ({
      ...entry,
      status: 'unsupported' as const,
      message: disabledMessage,
    })),
    warnings: demoInventory.capabilities.map((entry) => ({
      family: entry.family,
      code: 'UNSUPPORTED',
      message: disabledMessage,
      severity: 'warning' as const,
    })),
  };
}

describe('unavailable Data 360 resources', () => {
  it('recognizes Data 360 disablement as a capability finding', () => {
    const inventory = disabledInventory();

    expect(data360NotEnabled(inventory)).toBe(true);
    expect(inventory.warnings.every(isUnsupportedWarning)).toBe(true);
    expect(actionableWarnings(inventory)).toEqual([]);
    expect(retryableFamilyCount(inventory)).toBe(0);
    expect(resourceStatusMessage(inventory.capabilities[0]!)).toBe('Data 360 is not enabled for this user or org.');
    expect(discoveryStages(inventory).some((stage) => stage.state === 'blocked')).toBe(false);
  });

  it('recognizes a failed API-version probe as Data 360 disablement', () => {
    const inventory = disabledInventory();
    inventory.capabilities.push({
      ...capability({ family: 'data-transforms' }),
      family: 'api-versions',
      status: 'unsupported',
      apiVersion: null,
    });

    expect(data360NotEnabled(inventory)).toBe(true);
  });

  it('keeps real warnings actionable when only one family is unsupported', () => {
    const inventory = disabledInventory();
    inventory.capabilities[0] = { ...inventory.capabilities[0]!, status: 'available', message: 'Retrieved successfully.' };
    inventory.warnings.push({
      family: 'dlos',
      code: 'PAGINATION_LIMIT',
      message: 'Pagination stopped after 20 pages.',
      severity: 'warning',
    });

    expect(data360NotEnabled(inventory)).toBe(false);
    expect(actionableWarnings(inventory).map((warning) => warning.code)).toEqual(['PAGINATION_LIMIT']);
  });
});
