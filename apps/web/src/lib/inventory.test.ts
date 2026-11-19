import { describe, expect, it } from 'vitest';
import { demoInventory } from '@dcat/test-fixtures';
import {
  buildDictionaryRows,
  countInDataSpace,
  countStreamsInDataSpace,
  discoverySummary,
  filterByQuery,
  formatUpdatedAt,
  isInventoryStale,
  matchesQuery,
} from './inventory.ts';

describe('inventory helpers', () => {
  it('matches all search terms across the supplied values', () => {
    expect(matchesQuery('account dlo', ['Account DLO__dll', 'Salesforce CRM'])).toBe(true);
    expect(matchesQuery('account missing', ['Account DLO__dll'])).toBe(false);
    expect(matchesQuery('   ', ['anything'])).toBe(true);
  });

  it('filters objects by query', () => {
    const result = filterByQuery(demoInventory.dmos, 'click event', (object) => [object.label ?? object.apiName]);
    expect(result.map((object) => object.apiName)).toEqual(['ClickEvent_DMO__dlm']);
  });

  it('counts objects assigned to a data space', () => {
    expect(countInDataSpace(demoInventory.dlos, 'sales_space')).toBe(3);
    expect(countInDataSpace(demoInventory.dmos, 'default')).toBe(4);
  });

  it('matches data spaces without case sensitivity and counts streams directly or by target DLO', () => {
    const inventory = structuredClone(demoInventory);
    const firstStream = demoInventory.dataStreams[0]!;
    const firstDlo = demoInventory.dlos[0]!;
    expect(countInDataSpace([{ dataSpace: ' DEFAULT ' }], 'default')).toBe(1);

    inventory.dataStreams = [
      { ...firstStream, apiName: 'Direct_Space_Stream', dataSpace: 'DEFAULT', targetDlo: null },
      { ...firstStream, apiName: 'Joined_Space_Stream', dataSpace: null, targetDlo: firstDlo.apiName },
    ];
    expect(countStreamsInDataSpace(inventory, 'default')).toBe(2);
    expect(countStreamsInDataSpace(inventory, 'sales_space')).toBe(0);
  });

  it('keeps demo capability counts aligned with the inventory arrays', () => {
    const counts = new Map([
      ['data-spaces', demoInventory.dataSpaces.length],
      ['dlos', demoInventory.dlos.length],
      ['dmos', demoInventory.dmos.length],
      ['mappings', demoInventory.mappings.length],
      ['data-streams', demoInventory.dataStreams.length],
      ['data-transforms', demoInventory.dataTransforms.length],
    ]);

    for (const capability of demoInventory.capabilities) {
      const expected = counts.get(capability.family);
      expect(expected, `missing count for ${capability.family}`).toBeDefined();
      expect(capability.itemCount).toBe(expected);
      expect(capability.message).toContain(`${expected} `);
    }
  });

  it('builds a dictionary row for every field', () => {
    const rows = buildDictionaryRows(demoInventory);
    const expected = [...demoInventory.dlos, ...demoInventory.dmos].reduce((sum, object) => sum + object.fields.length, 0);
    expect(rows).toHaveLength(expected);
    expect(rows[0]).toMatchObject({ objectType: 'DLO', objectApiName: 'Account_DLO__dll', field: { apiName: 'Id' } });
  });

  it('describes inventory freshness using a supplied clock', () => {
    const now = Date.parse('2026-11-18T12:00:00.000Z');
    const recent = '2026-11-18T11:59:30.000Z';
    const freshPersisted = '2026-11-18T11:46:00.000Z';
    const stale = '2026-11-18T11:44:00.000Z';

    expect(formatUpdatedAt(recent, now)).toBe('just now');
    expect(formatUpdatedAt(stale, now)).toBe('16 min ago');
    expect(formatUpdatedAt('not a date', now)).toBe('at an unknown time');
    expect(isInventoryStale(recent, now)).toBe(false);
    expect(isInventoryStale(freshPersisted, now)).toBe(false);
    expect(isInventoryStale(stale, now)).toBe(true);
    expect(isInventoryStale('not a date', now)).toBe(false);
  });

  it('scores the fully healthy demo inventory as complete', () => {
    const summary = discoverySummary(demoInventory);
    expect(summary).toMatchObject({
      available: 6,
      partial: 0,
      unsupported: 0,
      issues: 0,
      total: 6,
      score: 100,
      label: 'Complete',
    });
  });

  it('scores user-facing resource families consistently on progressive snapshots', () => {
    const inventory = {
      ...structuredClone(demoInventory),
      capabilities: [
        ...demoInventory.capabilities,
        {
          family: 'api-versions' as const,
          status: 'error' as const,
          endpoint: 'services/data/',
          apiVersion: null,
          itemCount: null,
          durationMs: null,
          message: 'Version probe failed.',
        },
      ],
      warnings: [
        { family: 'api-versions', code: 'ERROR', message: 'Version probe failed.', severity: 'error' as const },
      ],
    };

    expect(discoverySummary(inventory)).toMatchObject({ total: 6, issues: 0, score: 100, label: 'Complete' });
  });

  it('counts each affected family once in discovery issues', () => {
    const inventory = structuredClone(demoInventory);
    inventory.capabilities[0] = { ...inventory.capabilities[0]!, status: 'error' };
    inventory.warnings = [
      { family: 'data-spaces', code: 'ERROR', message: 'First failure', severity: 'error' },
      { family: 'data-spaces', code: 'RETRY_LIMIT', message: 'Second failure', severity: 'warning' },
      { family: 'dlos', code: 'PAGINATION_LIMIT', message: 'Partial page', severity: 'warning' },
    ];

    expect(discoverySummary(inventory).issues).toBe(2);
  });

  it('does not count Data 360 disablement as a retryable issue', () => {
    const message = 'Data 360 is not enabled for this user or org. FUNCTIONALITY_NOT_ENABLED.';
    const inventory = {
      ...structuredClone(demoInventory),
      capabilities: demoInventory.capabilities.map((capability) => ({
        ...capability,
        status: 'unsupported' as const,
        message,
      })),
      warnings: demoInventory.capabilities.map((capability) => ({
        family: capability.family,
        code: 'UNSUPPORTED',
        message,
        severity: 'warning' as const,
      })),
    };

    expect(discoverySummary(inventory)).toMatchObject({
      available: 0,
      partial: 0,
      unsupported: 6,
      issues: 0,
      label: 'Not enabled',
    });
  });
});
