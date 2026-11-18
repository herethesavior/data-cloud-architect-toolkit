import { describe, expect, it } from 'vitest';
import { demoInventory } from '@dcat/test-fixtures';
import {
  streamDataSpace,
  streamDateText,
  streamRowKey,
  streamSearchValues,
  streamStatusTone,
  streamTargetKnown,
  streamValue,
} from './streamDetail.ts';

const accounts = demoInventory.dataStreams[0]!;

describe('stream detail helpers', () => {
  it('derives data space only from a target DLO present in the snapshot', () => {
    expect(streamDataSpace(demoInventory, accounts)).toBe(demoInventory.dlos.find((dlo) => dlo.apiName === accounts.targetDlo)?.dataSpace);
    expect(streamTargetKnown(demoInventory, accounts)).toBe(true);

    const orphan = { ...accounts, targetDlo: 'Missing_DLO__dll' };
    expect(streamDataSpace(demoInventory, orphan)).toBeNull();
    expect(streamTargetKnown(demoInventory, orphan)).toBe(false);
    expect(streamDataSpace(demoInventory, { ...accounts, targetDlo: null })).toBeNull();
  });

  it('shows invalid and missing dates without inventing a timestamp', () => {
    expect(streamDateText(null)).toBe('Not provided');
    expect(streamDateText('not-a-date')).toBe('not-a-date');
    expect(streamDateText('2026-11-18T00:00:00.000Z')).toMatch(/\d/);
  });

  it('maps known statuses to honest tones and leaves unknown values neutral', () => {
    expect(streamStatusTone('Active')).toBe('success');
    expect(streamStatusTone('Paused')).toBe('warning');
    expect(streamStatusTone('Failed')).toBe('danger');
    expect(streamStatusTone('Custom status')).toBe('neutral');
    expect(streamStatusTone(null)).toBe('neutral');
  });

  it('keeps blank values out of search and distinguishes colliding API names', () => {
    expect(streamSearchValues(demoInventory, accounts)).toContain('Accounts Stream');
    expect(streamSearchValues(demoInventory, accounts)).toContain('Salesforce CRM');
    expect(streamSearchValues(demoInventory, { ...accounts, label: null })).not.toContain('');

    expect(streamValue('', 'fallback')).toBe('fallback');
    expect(streamRowKey(accounts)).toBe('Accounts_Stream|Salesforce CRM|Account_DLO__dll');
    expect(streamRowKey({ ...accounts, targetDlo: 'Other_DLO__dll' })).not.toBe(streamRowKey(accounts));
  });
});
