import { describe, expect, it } from 'vitest';
import { demoInventory } from '@dcat/test-fixtures';
import {
  buildDictionaryRows,
  countInDataSpace,
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
    const stale = '2026-11-18T11:00:00.000Z';

    expect(formatUpdatedAt(recent, now)).toBe('just now');
    expect(formatUpdatedAt(stale, now)).toBe('1 hr ago');
    expect(formatUpdatedAt('not a date', now)).toBe('at an unknown time');
    expect(isInventoryStale(recent, now)).toBe(false);
    expect(isInventoryStale(stale, now)).toBe(true);
    expect(isInventoryStale('not a date', now)).toBe(false);
  });

  it('scores the fully healthy demo inventory as complete', () => {
    const summary = discoverySummary(demoInventory);
    expect(summary).toMatchObject({
      available: 6,
      partial: 0,
      issues: 0,
      total: 6,
      score: 100,
      label: 'Complete',
    });
  });
});
