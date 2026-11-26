import { describe, expect, it, vi } from 'vitest';
import { CliError } from '@dcat/salesforce-cli';
import {
  connectorCatalogJson,
  connectorConnectionsJson,
  dataSpacesJson,
  dataStreamsJson,
  dataTransformsJson,
  demoOrgs,
  dlosJson,
  dmoRelationshipsJson,
  dmosJson,
  dmosOffsetPage2Json,
  forbiddenRestOutput,
  malformedApiJson,
  mappingNotFoundOutput,
  mappingsJson,
  paginatedDlosPage1Json,
  paginatedDlosPage2Json,
  unsupportedRestOutput,
  versionsJson,
} from '@dcat/test-fixtures';
import { classifyRestFailure } from './capabilities.ts';
import { discoverInventory, extractHttpStatus } from './discover.ts';
import type { RestClient } from './discover.ts';
import {
  buildConnectorCatalogPath,
  buildConnectorConnectionsPath,
  buildDataTransformPath,
  buildDmoRelationshipsPath,
  buildFamilyPath,
  buildMappingPath,
} from './endpoints.ts';

const org = demoOrgs[0]!;
const base = 'services/data/v65.0/ssot';
const dmoPath = `${base}/data-model-objects?limit=100&offset=0`;
const dmoApiNames = ['Account_DMO__dlm', 'Contact_DMO__dlm', 'Order_DMO__dlm'];
const dmoSpaces: Record<string, string> = {
  Account_DMO__dlm: 'default',
  Contact_DMO__dlm: 'default',
  Order_DMO__dlm: 'sales_space',
};
const mappingPaths = dmoApiNames.map((name) => buildMappingPath(name, '65.0', dmoSpaces[name]));
const functionalityNotEnabled = JSON.stringify([{
  message: 'This feature is not currently enabled for this user type or org: [CdpDataSpace]',
  errorCode: 'FUNCTIONALITY_NOT_ENABLED',
}]);

function fakeCliAtVersion(
  version: string,
  overrides: Record<string, string | Error | Array<string | Error>> = {},
): RestClient {
  const versionBase = `services/data/v${version}/ssot`;
  const versionDmoPath = `${versionBase}/data-model-objects?limit=100&offset=0`;
  const paths: Record<string, string | Error | Array<string | Error>> = {
    'services/data/': versionsJson,
    [`${versionBase}/data-spaces`]: dataSpacesJson,
    [`${versionBase}/data-lake-objects`]: dlosJson,
    [versionDmoPath]: dmosJson,
    [`${versionBase}/data-model-objects?limit=100&offset=100`]: dmosOffsetPage2Json,
    [`${versionBase}/data-model-object-mappings`]: mappingsJson,
    ...Object.fromEntries(dmoApiNames.map((name) => [
      buildMappingPath(name, version, dmoSpaces[name]), mappingsJson,
    ])),
    [`${versionBase}/data-streams`]: dataStreamsJson,
    [buildConnectorCatalogPath(version)]: connectorCatalogJson,
    [buildConnectorConnectionsPath(version, 'SalesforceDotCom')]: connectorConnectionsJson,
    [buildFamilyPath('data-transforms', version)]: dataTransformsJson,
    ...overrides,
  };
  const indexes = new Map<string, number>();
  return {
    restGet: vi.fn(async (_alias: string, path: string) => {
      const value = paths[path];
      if (value === undefined && path.includes('/relationships?')) return '';
      if (value === undefined) throw new Error(`Unexpected REST path: ${path}`);
      if (Array.isArray(value)) {
        const index = indexes.get(path) ?? 0;
        indexes.set(path, index + 1);
        const entry = value[Math.min(index, value.length - 1)]!;
        if (typeof entry === 'string') return entry;
        throw entry;
      }
      if (value instanceof Error) throw value;
      return value;
    }),
  };
}

function fakeCli(
  overrides: Record<string, string | Error | Array<string | Error>> = {},
): RestClient {
  return fakeCliAtVersion('65.0', overrides);
}

function pathCalls(cli: RestClient, path: string): number {
  return vi.mocked(cli.restGet).mock.calls.filter(([, requested]) => requested === path).length;
}

describe('live Data 360 discovery', () => {
  it('extracts CLI-style status codes and classifies failures conservatively', () => {
    expect(extractHttpStatus('Exited with code 403.')).toBe(403);
    expect(extractHttpStatus('status: 404')).toBe(404);
    expect(extractHttpStatus('no status here')).toBeNull();
    expect(classifyRestFailure(extractHttpStatus('Exited with code 403.'), 'Exited with code 403.').status).toBe('forbidden');
    expect(classifyRestFailure(null, 'user not found for this org').status).toBe('error');
    expect(classifyRestFailure(null, 'endpoint not found').status).toBe('unsupported');
    expect(classifyRestFailure(null, `Salesforce CLI command failed: FUNCTIONALITY_NOT_ENABLED: ${functionalityNotEnabled}`).status)
      .toBe('unsupported');
  });

  it('builds a complete normalized snapshot with provenance and certainty labels', async () => {
    const cli = fakeCli();
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });

    expect(inventory).toMatchObject({
      mode: 'live',
      apiVersion: '65.0',
      org: { alias: org.alias },
    });
    expect(inventory.dataSpaces).toHaveLength(2);
    expect(inventory.dlos).toHaveLength(2);
    expect(inventory.dmos).toHaveLength(3);
    expect(inventory.mappings).toHaveLength(2);
    expect(inventory.dataStreams).toHaveLength(1);
    expect(inventory.dataStreams[0]).toMatchObject({
      sourceConnector: 'SalesforceDotCom',
      sourceConnectorLabel: 'Salesforce CRM',
      sourceConnectionName: 'SalesforceDotCom_Home',
      sourceConnectionLabel: 'EPIC OrgFarm',
      sourceConnectionStatus: 'Connected',
      sourceDataSource: 'Salesforce_Home',
    });
    expect(inventory.dataStreams[0]?.connectorLookup?.endpoints).toEqual([
      buildConnectorCatalogPath('65.0'),
      buildConnectorConnectionsPath('65.0', 'SalesforceDotCom'),
    ]);
    expect(inventory.dataTransforms).toHaveLength(1);
    expect(inventory.capabilities.map((capability) => capability.status)).toEqual(Array(7).fill('available'));
    expect(inventory.warnings).toHaveLength(0);
    expect(pathCalls(cli, `${base}/data-model-object-mappings`)).toBe(0);
    for (const path of mappingPaths) expect(pathCalls(cli, path)).toBe(1);
    expect(inventory.dlos[0]?.provenance).toMatchObject({
      orgId: org.orgId,
      orgAlias: org.alias,
      apiVersion: '65.0',
      confidence: 'source',
    });
    expect(inventory.dmos[0]?.fields[0]?.provenance.confidence).toBe('source');
    expect(inventory.relationships.some((edge) => edge.certainty === 'confirmed')).toBe(true);
    expect(inventory.relationships.some((edge) => edge.certainty === 'inferred')).toBe(true);
  });

  it('treats a live org with zero DMOs as an empty result and skips invalid mapping lookups', async () => {
    const cli = fakeCli({
      [dmoPath]: JSON.stringify({ dataModelObject: [] }),
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });

    expect(inventory.mode).toBe('live');
    expect(inventory.dmos).toEqual([]);
    expect(inventory.relationships).toEqual([]);
    expect(inventory.capabilities.find((entry) => entry.family === 'dmos')).toMatchObject({
      status: 'available',
      itemCount: 0,
    });
    expect(inventory.capabilities.find((entry) => entry.family === 'mappings')).toMatchObject({
      status: 'not-started',
      itemCount: 0,
      message: /no DMOs were found/,
    });
    expect(inventory.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'mappings', code: 'MAPPINGS_SKIPPED', severity: 'info' }),
    ]));
    expect(inventory.warnings.some((warning) => warning.severity === 'error')).toBe(false);
    expect(pathCalls(cli, `${base}/data-model-object-mappings`)).toBe(0);
    for (const path of mappingPaths) expect(pathCalls(cli, path)).toBe(0);
  });

  it('queries mappings by encoded DMO developer name and accepts documented envelopes', async () => {
    const dmoName = 'Customer & Partner__dlm';
    const path = buildMappingPath(dmoName, '65.0', 'default');
    const cli = fakeCli({
      [dmoPath]: JSON.stringify({ records: [{ apiName: dmoName }] }),
      [path]: JSON.stringify({
        objectSourceTargetMaps: [{
          developerName: 'Customer_Map__m',
          sourceEntityDeveloperName: 'Customer_DLO__dll',
          targetEntityDeveloperName: dmoName,
          fieldMappings: [{ sourceFieldDeveloperName: 'Id', targetFieldDeveloperName: 'Id' }],
        }],
      }),
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });

    expect(path).toContain('dmoDeveloperName=Customer%20%26%20Partner__dlm');
    expect(pathCalls(cli, path)).toBe(1);
    expect(pathCalls(cli, `${base}/data-model-object-mappings`)).toBe(0);
    expect(inventory.mappings).toHaveLength(1);
    expect(inventory.mappings[0]).toMatchObject({
      apiName: 'Customer_Map__m',
      sourceObject: 'Customer_DLO__dll',
      targetObject: dmoName,
      fieldMappings: [{ sourceField: 'Id', targetField: 'Id' }],
    });
  });

  it('loads per-DMO relationships and preserves source status', async () => {
    const relationshipPath = buildDmoRelationshipsPath('Account_DMO__dlm', '65.0', 'default');
    const cli = fakeCli({ [relationshipPath]: dmoRelationshipsJson });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });

    expect(pathCalls(cli, relationshipPath)).toBe(1);
    expect(inventory.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: '0geDEMO000000001AAA',
        source: 'Account_DMO__dlm',
        target: 'Contact_DMO__dlm',
        label: 'ContactId',
        targetField: 'Id',
        cardinality: 'ManyToOne',
        status: 'INACTIVE',
        certainty: 'confirmed',
      }),
    ]));
    expect(inventory.relationships.find((edge) => edge.id === '0geDEMO000000001AAA')?.provenance)
      .toMatchObject({ sourceEndpoint: relationshipPath, confidence: 'source' });
  });

  it('follows DMO offset pages even when the response has no continuation cursor', async () => {
    const fullPage = JSON.stringify({
      dataModelObject: Array.from({ length: 100 }, (_, index) => ({
        name: `Standard_${index}__dlm`,
        dataSpaceName: 'default',
        isEnabled: false,
        fields: [],
      })),
    });
    const nextPath = `${base}/data-model-objects?limit=100&offset=100`;
    const cli = fakeCli({
      [dmoPath]: fullPage,
      [nextPath]: dmosOffsetPage2Json,
      [buildMappingPath('Page2_DMO__dlm', '65.0', 'default')]: mappingsJson,
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });

    expect(inventory.dmos).toHaveLength(101);
    expect(pathCalls(cli, nextPath)).toBe(1);
    expect(inventory.capabilities.find((entry) => entry.family === 'dmos')).toMatchObject({
      status: 'available',
      itemCount: 101,
    });
    expect(inventory.warnings).toHaveLength(0);
  });

  it('follows bounded Data Transform offset pages in one-shot discovery', async () => {
    const transformPage1 = JSON.stringify({
      dataTransforms: Array.from({ length: 20 }, (_, index) => ({
        name: `Transform_${String(index + 1).padStart(3, '0')}`,
        label: `Transform ${index + 1}`,
      })),
      totalSize: 21,
    });
    const transformPage2 = JSON.stringify({
      dataTransforms: [{ name: 'Transform_021', label: 'Transform 21' }],
      totalSize: 21,
    });
    const cli = fakeCli({
      [buildFamilyPath('data-transforms', '65.0')]: transformPage1,
      [buildDataTransformPath('65.0', 20)]: transformPage2,
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });

    expect(inventory.dataTransforms.map((transform) => transform.apiName)).toEqual([
      ...Array.from({ length: 20 }, (_, index) => `Transform_${String(index + 1).padStart(3, '0')}`),
      'Transform_021',
    ]);
    expect(pathCalls(cli, buildDataTransformPath('65.0', 20))).toBe(1);
    expect(inventory.capabilities.find((entry) => entry.family === 'data-transforms')).toMatchObject({
      status: 'available',
      itemCount: 21,
    });
  });

  it('classifies a CLI output limit as a size gap instead of raw CLI text', async () => {
    const cli = fakeCli({
      [buildFamilyPath('data-transforms', '65.0')]: new CliError(
        'OUTPUT_LIMIT',
        'Salesforce CLI output exceeded the safe size limit.',
      ),
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });

    expect(inventory.capabilities.find((entry) => entry.family === 'data-transforms')).toMatchObject({
      status: 'error',
    });
    expect(inventory.capabilities.find((entry) => entry.family === 'data-transforms')?.message)
      .toMatch(/too large.*smaller pages/i);
    expect(inventory.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: 'data-transforms',
        code: 'OUTPUT_LIMIT',
        message: expect.stringMatching(/too large.*smaller pages/i),
      }),
    ]));
  });

  it('does not follow a continuation into an unrelated REST endpoint', async () => {
    const crossFamilyPath = 'services/data/v65.0/query/01gABC?locator=abc%2B123';
    const cli = fakeCli({
      [`${base}/data-lake-objects`]: JSON.stringify({
        records: [{ apiName: 'Only_DLO__dll', fields: [] }],
        nextPageUrl: `/${crossFamilyPath}`,
      }),
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });

    expect(pathCalls(cli, crossFamilyPath)).toBe(0);
    expect(inventory.dlos).toHaveLength(1);
    expect(inventory.warnings.some((warning) => warning.message.includes('different REST endpoint'))).toBe(true);
  });

  it('queries mappings only for source-enabled DMOs and leaves disabled DMOs as explicit gaps', async () => {
    const enabledPath = buildMappingPath('Enabled_DMO__dlm', '65.0', 'default');
    const cli = fakeCli({
      [dmoPath]: JSON.stringify({
        dataModelObject: [
          { name: 'Enabled_DMO__dlm', dataSpaceName: 'default', isEnabled: true, fields: [] },
          { name: 'Disabled_DMO__dlm', dataSpaceName: 'default', isEnabled: false, fields: [] },
        ],
      }),
      [enabledPath]: mappingsJson,
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });

    expect(pathCalls(cli, enabledPath)).toBe(1);
    for (const path of mappingPaths) expect(pathCalls(cli, path)).toBe(0);
    expect(inventory.warnings.every((warning) => warning.severity !== 'error')).toBe(true);
    expect(inventory.capabilities.find((entry) => entry.family === 'mappings')?.status).toBe('available');
  });

  it('treats a DMO-specific mapping NOT_FOUND as an empty result', async () => {
    const cli = fakeCli({
      [mappingPaths[0]!]: new CliError('COMMAND_FAILED', mappingNotFoundOutput),
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });

    expect(inventory.warnings.every((warning) => warning.severity !== 'error')).toBe(true);
    expect(inventory.capabilities.find((entry) => entry.family === 'mappings')).toMatchObject({
      status: 'available',
      itemCount: 2,
    });
  });

  it('keeps real mapping lookup errors visible instead of treating them as empty data', async () => {
    const message = 'Salesforce CLI command failed: INVALID_INPUT: DMO or Source Object (CRM) developer Name is missing';
    const cli = fakeCli(Object.fromEntries(
      mappingPaths.map((path) => [path, new CliError('COMMAND_FAILED', message)]),
    ));
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });

    expect(inventory.capabilities.find((entry) => entry.family === 'mappings')).toMatchObject({
      status: 'error',
      itemCount: 0,
      message,
    });
    expect(inventory.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'mappings', code: 'ERROR', severity: 'error' }),
    ]));
  });

  it('keeps other families when one endpoint is forbidden', async () => {
    const cli = fakeCli({
      [dmoPath]: new CliError('COMMAND_FAILED', forbiddenRestOutput),
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });
    const dmosCapability = inventory.capabilities.find((capability) => capability.family === 'dmos');

    expect(dmosCapability?.status).toBe('forbidden');
    expect(dmosCapability?.message).toMatch(/Access denied/);
    expect(inventory.dmos).toHaveLength(0);
    expect(inventory.dlos).toHaveLength(2);
    expect(inventory.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'dmos', severity: 'error' }),
    ]));
    expect(inventory.relationships.some((edge) => edge.certainty === 'confirmed')).toBe(false);
  });

  it('reports a forbidden DMO lookup instead of a skipped mappings capability', async () => {
    const cli = fakeCli({
      [dmoPath]: new CliError('COMMAND_FAILED', forbiddenRestOutput),
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });
    const capability = inventory.capabilities.find((entry) => entry.family === 'mappings');

    expect(capability).toMatchObject({ status: 'forbidden', itemCount: 0 });
    expect(capability?.message).toMatch(/Access denied/);
    expect(inventory.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'mappings', code: 'FORBIDDEN', severity: 'error' }),
    ]));
  });

  it('keeps raw connector codes when connector lookups fail', async () => {
    const cli = fakeCli({
      [buildConnectorCatalogPath('65.0')]: new CliError('COMMAND_FAILED', 'Status: 500 Server Error'),
      [buildConnectorConnectionsPath('65.0', 'SalesforceDotCom')]: new CliError('COMMAND_FAILED', 'Status: 500 Server Error'),
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });

    expect(inventory.dataStreams[0]).toMatchObject({
      sourceConnector: 'SalesforceDotCom',
      sourceConnectorLabel: null,
      sourceConnectionLabel: null,
    });
    expect(inventory.capabilities).toHaveLength(7);
    expect(inventory.warnings.filter((warning) => warning.family === 'stream-enrichment')).toHaveLength(2);
  });

  it('treats a 404 as unsupported rather than an empty dataset', async () => {
    const cli = fakeCli(Object.fromEntries(
      mappingPaths.map((path) => [path, new CliError('COMMAND_FAILED', unsupportedRestOutput)]),
    ));
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });
    const capability = inventory.capabilities.find((entry) => entry.family === 'mappings');

    expect(capability?.status).toBe('unsupported');
    expect(capability?.message).toMatch(/unavailable for this org or API version/);
    expect(inventory.mappings).toHaveLength(0);
    expect(inventory.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'mappings', severity: 'warning' }),
    ]));
  });

  it('treats FUNCTIONALITY_NOT_ENABLED as a capability gap rather than a failed family', async () => {
    const cli = fakeCli({
      'services/data/': versionsJson,
      [`${base}/data-spaces`]: new CliError('COMMAND_FAILED', `Salesforce CLI command failed: FUNCTIONALITY_NOT_ENABLED: ${functionalityNotEnabled}`),
      [`${base}/data-lake-objects`]: new CliError('COMMAND_FAILED', `Salesforce CLI command failed: FUNCTIONALITY_NOT_ENABLED: ${functionalityNotEnabled}`),
      [dmoPath]: new CliError('COMMAND_FAILED', `Salesforce CLI command failed: FUNCTIONALITY_NOT_ENABLED: ${functionalityNotEnabled}`),
      ...Object.fromEntries(mappingPaths.map((path) => [
        path,
        new CliError('COMMAND_FAILED', `Salesforce CLI command failed: FUNCTIONALITY_NOT_ENABLED: ${functionalityNotEnabled}`),
      ])),
      [`${base}/data-streams`]: new CliError('COMMAND_FAILED', `Salesforce CLI command failed: FUNCTIONALITY_NOT_ENABLED: ${functionalityNotEnabled}`),
      [buildFamilyPath('data-transforms', '65.0')]: new CliError('COMMAND_FAILED', `Salesforce CLI command failed: FUNCTIONALITY_NOT_ENABLED: ${functionalityNotEnabled}`),
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });

    expect(inventory.capabilities.slice(1).every((capability) => capability.status === 'unsupported')).toBe(true);
    expect(inventory.capabilities[1]?.message).toMatch(/Data 360 is not enabled for this user or org/);
    expect(inventory.warnings.filter((warning) => warning.code === 'UNSUPPORTED')).toHaveLength(6);
    expect(inventory.warnings.every((warning) => warning.severity !== 'error')).toBe(true);
    expect(pathCalls(cli, `${base}/data-spaces`)).toBe(1);
  });

  it('reports malformed responses as errors instead of inventing empty results', async () => {
    const cli = fakeCli({ [`${base}/data-spaces`]: malformedApiJson });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });
    const capability = inventory.capabilities.find((entry) => entry.family === 'data-spaces');

    expect(capability?.status).toBe('error');
    expect(capability?.message).toMatch(/not valid JSON/);
    expect(inventory.dataSpaces).toHaveLength(0);
  });

  it('follows continuation tokens across pages', async () => {
    const cli = fakeCli({
      [`${base}/data-lake-objects`]: paginatedDlosPage1Json,
      [`${base}/data-lake-objects?nextToken=page-2-token`]: paginatedDlosPage2Json,
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });

    expect(inventory.dlos.map((object) => object.apiName)).toEqual(['Page1_DLO__dll', 'Page2_DLO__dll']);
    expect(inventory.capabilities.find((entry) => entry.family === 'dlos')?.status).toBe('available');
    expect(cli.restGet).toHaveBeenCalledWith(org.alias, `${base}/data-lake-objects?nextToken=page-2-token`);
  });

  it('marks partial results when the pagination limit is reached', async () => {
    const cli = fakeCli({
      [`${base}/data-lake-objects`]: paginatedDlosPage1Json,
      [`${base}/data-lake-objects?nextToken=page-2-token`]: paginatedDlosPage2Json,
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, maxPages: 1, apiVersionSelection: { mode: 'latest' } });

    expect(inventory.dlos).toHaveLength(1);
    expect(inventory.capabilities.find((entry) => entry.family === 'dlos')?.status).toBe('partial');
    expect(inventory.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'dlos', code: 'PAGINATION_LIMIT' }),
    ]));
  });

  it('loads pinned metadata when only the version-list check fails', async () => {
    const cli = fakeCliAtVersion('67.0', {
      'services/data/': new CliError('COMMAND_FAILED', forbiddenRestOutput),
    });
    const onApiVersionResolved = vi.fn();
    const inventory = await discoverInventory({
      cli,
      alias: org.alias,
      org,
      apiVersionSelection: { mode: 'recommended' },
      onApiVersionResolved,
    });

    expect(inventory.apiVersion).toBe('67.0');
    expect(inventory.dlos).toHaveLength(2);
    expect(inventory.capabilities.every((capability) => capability.status === 'available')).toBe(true);
    expect(inventory.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'API_VERSION_PROBE_UNAVAILABLE', severity: 'warning' }),
    ]));
    expect(onApiVersionResolved).toHaveBeenCalledWith(expect.objectContaining({
      apiVersion: '67.0',
      probe: expect.objectContaining({ failed: true, status: 'forbidden' }),
    }));
  });

  it('fails cleanly when API version discovery is unavailable', async () => {
    const cli = fakeCli({ 'services/data/': new CliError('COMMAND_FAILED', forbiddenRestOutput) });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });

    expect(inventory.apiVersion).toBeNull();
    expect(inventory.capabilities[0]?.status).toBe('forbidden');
    expect(inventory.capabilities.slice(1).every((capability) => capability.status === 'error')).toBe(true);
    expect(inventory.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'API_VERSION_UNAVAILABLE', severity: 'error' }),
    ]));
    expect(JSON.stringify(inventory.warnings)).not.toContain('ERROR running api request');
    expect(inventory.dlos).toHaveLength(0);
    expect(cli.restGet).toHaveBeenCalledTimes(1);
  });

  it('extracts HTTP statuses defensively from CLI error text', () => {
    expect(extractHttpStatus('ERROR running api request rest: status code 403 Forbidden')).toBe(403);
    expect(extractHttpStatus('ERROR running api request rest: (404) Not Found')).toBe(404);
    expect(extractHttpStatus('ERROR: 500 Server Error')).toBe(500);
    expect(extractHttpStatus('network failure')).toBeNull();
  });

  it('retries a transient family failure once and records that it succeeded', async () => {
    const path = `${base}/data-spaces`;
    const cli = fakeCli({
      [path]: [new CliError('COMMAND_FAILED', 'ERROR: 500 Server Error'), dataSpacesJson],
    });

    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });
    expect(inventory.dataSpaces).toHaveLength(2);
    expect(pathCalls(cli, path)).toBe(2);
    expect(inventory.capabilities.find((entry) => entry.family === 'data-spaces')?.status).toBe('available');
    expect(inventory.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'data-spaces', code: 'RETRY_SUCCEEDED', severity: 'info' }),
    ]));
  });

  it('does not retry forbidden or unsupported families', async () => {
    for (const [path, error] of [
      [`${base}/data-spaces`, new CliError('COMMAND_FAILED', forbiddenRestOutput)],
      [`${base}/data-streams`, new CliError('COMMAND_FAILED', unsupportedRestOutput)],
    ] as const) {
      const cli = fakeCli({ [path]: error });
      const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });
      expect(pathCalls(cli, path)).toBe(1);
      expect(inventory.warnings.some((warning) => warning.code === 'RETRY_LIMIT' || warning.code === 'RETRY_SUCCEEDED')).toBe(false);
    }
  });

  it('stops after two attempts and warns when a transient failure persists', async () => {
    const path = `${base}/data-spaces`;
    const cli = fakeCli({ [path]: new CliError('COMMAND_FAILED', 'ERROR: 503 Service Unavailable') });

    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });
    expect(pathCalls(cli, path)).toBe(2);
    expect(inventory.capabilities.find((entry) => entry.family === 'data-spaces')?.status).toBe('error');
    expect(inventory.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'data-spaces', code: 'RETRY_LIMIT', severity: 'warning' }),
    ]));
  });

  it('does not retry malformed responses that cannot be transient', async () => {
    const path = `${base}/data-spaces`;
    const cli = fakeCli({ [path]: malformedApiJson });

    const inventory = await discoverInventory({ cli, alias: org.alias, org, apiVersionSelection: { mode: 'latest' } });
    expect(pathCalls(cli, path)).toBe(1);
    expect(inventory.capabilities.find((entry) => entry.family === 'data-spaces')?.status).toBe('error');
  });
});
