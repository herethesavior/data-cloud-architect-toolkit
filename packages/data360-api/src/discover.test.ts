import { describe, expect, it, vi } from 'vitest';
import { CliError } from '@dcat/salesforce-cli';
import {
  dataSpacesJson,
  dataStreamsJson,
  dataTransformsJson,
  demoOrgs,
  dlosJson,
  dmosJson,
  forbiddenRestOutput,
  malformedApiJson,
  mappingsJson,
  paginatedDlosPage1Json,
  paginatedDlosPage2Json,
  unsupportedRestOutput,
  versionsJson,
} from '@dcat/test-fixtures';
import { classifyRestFailure } from './capabilities.ts';
import { discoverInventory, extractHttpStatus } from './discover.ts';
import type { RestClient } from './discover.ts';

const org = demoOrgs[0]!;
const base = 'services/data/v65.0/ssot';
const functionalityNotEnabled = JSON.stringify([{
  message: 'This feature is not currently enabled for this user type or org: [CdpDataSpace]',
  errorCode: 'FUNCTIONALITY_NOT_ENABLED',
}]);

function fakeCli(overrides: Record<string, string | Error | Array<string | Error>> = {}): RestClient {
  const paths: Record<string, string | Error | Array<string | Error>> = {
    'services/data/': versionsJson,
    [`${base}/data-spaces`]: dataSpacesJson,
    [`${base}/data-lake-objects`]: dlosJson,
    [`${base}/data-model-objects`]: dmosJson,
    [`${base}/data-model-object-mappings`]: mappingsJson,
    [`${base}/data-streams`]: dataStreamsJson,
    [`${base}/data-transforms`]: dataTransformsJson,
    ...overrides,
  };
  const indexes = new Map<string, number>();
  return {
    restGet: vi.fn(async (_alias: string, path: string) => {
      const value = paths[path];
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
    const inventory = await discoverInventory({ cli: fakeCli(), alias: org.alias, org });

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
    expect(inventory.dataTransforms).toHaveLength(1);
    expect(inventory.capabilities.map((capability) => capability.status)).toEqual(Array(7).fill('available'));
    expect(inventory.warnings).toHaveLength(0);
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

  it('keeps other families when one endpoint is forbidden', async () => {
    const cli = fakeCli({
      [`${base}/data-model-objects`]: new CliError('COMMAND_FAILED', forbiddenRestOutput),
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org });
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

  it('treats a 404 as unsupported rather than an empty dataset', async () => {
    const cli = fakeCli({
      [`${base}/data-model-object-mappings`]: new CliError('COMMAND_FAILED', unsupportedRestOutput),
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org });
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
      [`${base}/data-model-objects`]: new CliError('COMMAND_FAILED', `Salesforce CLI command failed: FUNCTIONALITY_NOT_ENABLED: ${functionalityNotEnabled}`),
      [`${base}/data-model-object-mappings`]: new CliError('COMMAND_FAILED', `Salesforce CLI command failed: FUNCTIONALITY_NOT_ENABLED: ${functionalityNotEnabled}`),
      [`${base}/data-streams`]: new CliError('COMMAND_FAILED', `Salesforce CLI command failed: FUNCTIONALITY_NOT_ENABLED: ${functionalityNotEnabled}`),
      [`${base}/data-transforms`]: new CliError('COMMAND_FAILED', `Salesforce CLI command failed: FUNCTIONALITY_NOT_ENABLED: ${functionalityNotEnabled}`),
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org });

    expect(inventory.capabilities.slice(1).every((capability) => capability.status === 'unsupported')).toBe(true);
    expect(inventory.capabilities[1]?.message).toMatch(/Data 360 is not enabled for this user or org/);
    expect(inventory.warnings.filter((warning) => warning.code === 'UNSUPPORTED')).toHaveLength(6);
    expect(inventory.warnings.every((warning) => warning.severity !== 'error')).toBe(true);
    expect(pathCalls(cli, `${base}/data-spaces`)).toBe(1);
  });

  it('reports malformed responses as errors instead of inventing empty results', async () => {
    const cli = fakeCli({ [`${base}/data-spaces`]: malformedApiJson });
    const inventory = await discoverInventory({ cli, alias: org.alias, org });
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
    const inventory = await discoverInventory({ cli, alias: org.alias, org });

    expect(inventory.dlos.map((object) => object.apiName)).toEqual(['Page1_DLO__dll', 'Page2_DLO__dll']);
    expect(inventory.capabilities.find((entry) => entry.family === 'dlos')?.status).toBe('available');
    expect(cli.restGet).toHaveBeenCalledWith(org.alias, `${base}/data-lake-objects?nextToken=page-2-token`);
  });

  it('marks partial results when the pagination limit is reached', async () => {
    const cli = fakeCli({
      [`${base}/data-lake-objects`]: paginatedDlosPage1Json,
      [`${base}/data-lake-objects?nextToken=page-2-token`]: paginatedDlosPage2Json,
    });
    const inventory = await discoverInventory({ cli, alias: org.alias, org, maxPages: 1 });

    expect(inventory.dlos).toHaveLength(1);
    expect(inventory.capabilities.find((entry) => entry.family === 'dlos')?.status).toBe('partial');
    expect(inventory.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'dlos', code: 'PAGINATION_LIMIT' }),
    ]));
  });

  it('fails cleanly when API version discovery is unavailable', async () => {
    const cli = fakeCli({ 'services/data/': new CliError('COMMAND_FAILED', forbiddenRestOutput) });
    const inventory = await discoverInventory({ cli, alias: org.alias, org });

    expect(inventory.apiVersion).toBeNull();
    expect(inventory.capabilities[0]?.status).toBe('forbidden');
    expect(inventory.capabilities.slice(1).every((capability) => capability.status === 'error')).toBe(true);
    expect(inventory.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'API_VERSION_UNAVAILABLE', severity: 'error' }),
    ]));
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

    const inventory = await discoverInventory({ cli, alias: org.alias, org });
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
      const inventory = await discoverInventory({ cli, alias: org.alias, org });
      expect(pathCalls(cli, path)).toBe(1);
      expect(inventory.warnings.some((warning) => warning.code === 'RETRY_LIMIT' || warning.code === 'RETRY_SUCCEEDED')).toBe(false);
    }
  });

  it('stops after two attempts and warns when a transient failure persists', async () => {
    const path = `${base}/data-spaces`;
    const cli = fakeCli({ [path]: new CliError('COMMAND_FAILED', 'ERROR: 503 Service Unavailable') });

    const inventory = await discoverInventory({ cli, alias: org.alias, org });
    expect(pathCalls(cli, path)).toBe(2);
    expect(inventory.capabilities.find((entry) => entry.family === 'data-spaces')?.status).toBe('error');
    expect(inventory.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'data-spaces', code: 'RETRY_LIMIT', severity: 'warning' }),
    ]));
  });

  it('does not retry malformed responses that cannot be transient', async () => {
    const path = `${base}/data-spaces`;
    const cli = fakeCli({ [path]: malformedApiJson });

    const inventory = await discoverInventory({ cli, alias: org.alias, org });
    expect(pathCalls(cli, path)).toBe(1);
    expect(inventory.capabilities.find((entry) => entry.family === 'data-spaces')?.status).toBe('error');
  });
});
