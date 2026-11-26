import { describe, expect, it } from 'vitest';
import { CliError } from '@dcat/salesforce-cli';
import {
  buildConnectorCatalogPath,
  buildConnectorConnectionsPath,
  buildDataTransformPath,
  buildDmoPath,
  buildDmoRelationshipsPath,
  buildExpectedCountPath,
  buildFamilyPath,
  buildMappingPath,
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

  it('builds bounded offset pages for DMOs and Data Transforms and plain paths for other families', () => {
    expect(buildFamilyPath('dmos', '65.0')).toBe(
      'services/data/v65.0/ssot/data-model-objects?limit=100&offset=0',
    );
    expect(buildDmoPath('65.0', 100)).toBe(
      'services/data/v65.0/ssot/data-model-objects?limit=100&offset=100',
    );
    expect(buildFamilyPath('data-transforms', '65.0')).toBe(
      'services/data/v65.0/ssot/data-transforms?filterGroup=Medium&limit=20&offset=0',
    );
    expect(buildDataTransformPath('65.0', 40)).toBe(
      'services/data/v65.0/ssot/data-transforms?filterGroup=Medium&limit=20&offset=40',
    );
    expect(buildExpectedCountPath('data-transforms', '65.0')).toBe(
      'services/data/v65.0/ssot/data-transforms?filterGroup=Medium&limit=1&offset=0',
    );
    expect(buildFamilyPath('dlos', '65.0')).toBe(
      'services/data/v65.0/ssot/data-lake-objects',
    );
    expect(buildExpectedCountPath('dlos', '65.0')).toBe(
      'services/data/v65.0/ssot/data-lake-objects?limit=1',
    );
    expect(() => buildDmoPath('65.0', -1)).toThrow(CliError);
    expect(() => buildDataTransformPath('65.0', -1)).toThrow(CliError);
  });

  it('builds the required, encoded DMO filter for mapping lookups', () => {
    expect(buildMappingPath('Account_DMO__dlm', '65.0')).toBe(
      'services/data/v65.0/ssot/data-model-object-mappings?dmoDeveloperName=Account_DMO__dlm',
    );
    expect(buildMappingPath('Customer & Partner__dlm', '65.0', 'sales & service')).toBe(
      'services/data/v65.0/ssot/data-model-object-mappings?dataspace=sales%20%26%20service&dmoDeveloperName=Customer%20%26%20Partner__dlm',
    );
    expect(() => buildMappingPath('  ', '65.0')).toThrow(/DMO developer name is required/);
    expect(() => buildMappingPath('Account_DMO__dlm', 'latest')).toThrow(CliError);
  });

  it('builds allowlisted connector lookup paths without treating the catalog as a family', () => {
    expect(buildConnectorCatalogPath('68.0')).toBe('services/data/v68.0/ssot/connectors');
    expect(buildConnectorConnectionsPath('68.0', 'SalesforceDotCom')).toBe(
      'services/data/v68.0/ssot/connections?connectorType=SalesforceDotCom',
    );
    expect(() => buildConnectorConnectionsPath('68.0', '../connections')).toThrow(CliError);
    expect(() => buildConnectorCatalogPath('latest')).toThrow(CliError);
  });

  it('builds only the allowlisted per-DMO relationship subresource', () => {
    expect(buildDmoRelationshipsPath('Account_DMO__dlm', '68.0', 'default')).toBe(
      'services/data/v68.0/ssot/data-model-objects/Account_DMO__dlm/relationships?dataspace=default&limit=500',
    );
    expect(buildDmoRelationshipsPath('Account_DMO__dlm', '68.0')).toBe(
      'services/data/v68.0/ssot/data-model-objects/Account_DMO__dlm/relationships?limit=500',
    );
  });

  it('rejects relationship path injection, unsafe versions, and oversized pages', () => {
    for (const name of ['', '../dmos', 'a/b', 'a?url=https://evil.example', 'a#fragment', 'a%2Fb', 'a b']) {
      expect(() => buildDmoRelationshipsPath(name, '68.0'), name).toThrow(CliError);
    }
    expect(() => buildDmoRelationshipsPath('Account_DMO__dlm', 'latest')).toThrow(CliError);
    expect(() => buildDmoRelationshipsPath('Account_DMO__dlm', '68.0', 'sales & service')).toThrow(CliError);
    expect(() => buildDmoRelationshipsPath('Account_DMO__dlm', '68.0', 'default', 501)).toThrow(CliError);
  });
});
