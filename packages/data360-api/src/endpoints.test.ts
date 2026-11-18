import { describe, expect, it } from 'vitest';
import { CliError } from '@dcat/salesforce-cli';
import {
  buildTransformDetailPath,
  buildTransformRunHistoryPath,
  buildTransformSchedulePath,
  buildTransformSubresourcePath,
  validateTransformId,
} from './endpoints.ts';

const base = 'services/data/v65.0/ssot/data-transforms';

describe('allowlisted transform paths', () => {
  it('builds the three documented GET paths from the registry', () => {
    expect(buildTransformDetailPath('Normalize_Contacts', '65.0')).toBe(`${base}/Normalize_Contacts`);
    expect(buildTransformRunHistoryPath('Normalize_Contacts', '65.0')).toBe(`${base}/Normalize_Contacts/run-history`);
    expect(buildTransformSchedulePath('Normalize_Contacts', '65.0')).toBe(`${base}/Normalize_Contacts/schedule`);
  });

  it('accepts conservative Salesforce ids and api names', () => {
    expect(validateTransformId('Account_Transform')).toBe('Account_Transform');
    expect(validateTransformId('ns__Transform__dtm')).toBe('ns__Transform__dtm');
    expect(validateTransformId('0TfDEMO000000001AAA')).toBe('0TfDEMO000000001AAA');
    expect(validateTransformId('Transform-01.v2~beta')).toBe('Transform-01.v2~beta');
    expect(validateTransformId('a'.repeat(128))).toHaveLength(128);
  });

  it('rejects ids that could escape the allowlisted path', () => {
    for (const id of [
      '',
      ' ',
      '/etc/passwd',
      '../data-transforms',
      'a/../b',
      'a?url=https://evil.example',
      'a#fragment',
      'a&b=c',
      'a%2Fb',
      'a%20b',
      'a\\b',
      'a:b',
      'a'.repeat(129),
    ]) {
      expect(() => validateTransformId(id), id).toThrow(CliError);
    }
  });

  it('encodes the validated id exactly once and never accepts a caller path', () => {
    const id = 'Transform-01.v2~beta';
    const path = buildTransformSubresourcePath(id, 'detail', '65.0');
    expect(path).toBe(`${base}/${encodeURIComponent(id)}`);
    expect(path).not.toMatch(/%2f|%3f|%23/i);
    expect(() => buildTransformDetailPath('/services/data/v65.0/other', '65.0')).toThrow(CliError);
  });

  it('rejects invalid api versions and unknown sections', () => {
    for (const version of ['latest', 'v65.0', '65', '65.0/../../evil', '']) {
      expect(() => buildTransformDetailPath('Account_Transform', version), version).toThrow(CliError);
    }
    expect(() => buildTransformSubresourcePath('Account_Transform', 'delete' as never, '65.0')).toThrow(CliError);
  });
});
