import { describe, expect, it } from 'vitest';
import { demoInventory } from '@dcat/test-fixtures';
import {
  COMMAND_RESULT_LIMIT,
  buildCommandResults,
  commandResultDetails,
  filterCommandResults,
} from './commandSearch.ts';

const results = buildCommandResults(demoInventory);

describe('global command search', () => {
  it('indexes every searchable family from the active inventory only', () => {
    expect(results).toHaveLength(
      demoInventory.dataSpaces.length
      + demoInventory.dlos.length
      + demoInventory.dmos.length
      + demoInventory.dataStreams.length
      + demoInventory.mappings.length
      + demoInventory.dataTransforms.length,
    );
    expect([...new Set(results.map((result) => result.kind))]).toEqual([
      'data-space',
      'dlo',
      'dmo',
      'stream',
      'mapping',
      'transform',
    ]);

    const account = results.find((result) => result.apiName === 'Account_DLO__dll');
    expect(account).toMatchObject({
      kind: 'dlo',
      typeLabel: 'DLO',
      label: 'Account DLO',
      dataSpace: 'default',
      icon: 'database',
    });
  });

  it('filters by label, API name, type, and data space', () => {
    expect(filterCommandResults(results, 'normalize').map((result) => result.label)).toEqual(['Normalize Contacts']);

    const apiMatches = filterCommandResults(results, 'account_dlo__dll');
    expect(apiMatches.map((result) => result.id)).toContain('dlo:Account_DLO__dll');
    expect(apiMatches.every((result) => `${result.label} ${result.apiName}`.toLowerCase().includes('account_dlo__dll'))).toBe(true);

    expect(filterCommandResults(results, 'data stream').map((result) => result.id)).toContain('stream:Accounts_Stream');
    const spaceMatches = filterCommandResults(results, 'sales_space');
    expect(spaceMatches.map((result) => result.id)).toContain('space:sales_space');
    expect(spaceMatches.some((result) => result.dataSpace === 'sales_space')).toBe(true);
    expect(filterCommandResults(results, 'not-in-this-inventory')).toEqual([]);
  });

  it('caps result lists and keeps detail summaries grounded in the record', () => {
    expect(filterCommandResults([...results, ...results], '')).toHaveLength(COMMAND_RESULT_LIMIT);

    const transform = results.find((result) => result.kind === 'transform')!;
    const transformRecord = demoInventory.dataTransforms.find((entry) => entry.apiName === transform.apiName)!;
    expect(commandResultDetails(transform)).toEqual(expect.arrayContaining([
      { label: 'Transform status', value: transformRecord.status ?? '' },
      ...(transformRecord.description ? [{ label: 'Description', value: transformRecord.description }] : []),
      { label: 'Source endpoint', value: '/ssot/data-transforms' },
      { label: 'Confidence', value: 'source' },
    ]));

    const mapping = results.find((result) => result.kind === 'mapping')!;
    expect(commandResultDetails(mapping)).toEqual(expect.arrayContaining([
      { label: 'Source object', value: 'Account_DLO__dll' },
      { label: 'Target object', value: 'Account_DMO__dlm' },
      { label: 'Field mappings', value: '8' },
    ]));
  });
});
