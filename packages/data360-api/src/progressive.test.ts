import { describe, expect, it, vi } from 'vitest';
import {
  connectorCatalogJson,
  connectorConnectionsJson,
  dataSpacesJson,
  dataStreamsJson,
  dataTransformsJson,
  demoOrgs,
  dmoRelationshipsJson,
  dmosJson,
  dmosOffsetPage2Json,
  mappingNotFoundOutput,
  mappingsJson,
  versionsJson,
} from '@dcat/test-fixtures';
import { CliError } from '@dcat/salesforce-cli';
import type { RestClient } from './discover.ts';
import {
  buildConnectorCatalogPath,
  buildConnectorConnectionsPath,
  buildDmoRelationshipsPath,
  buildExpectedCountPath,
  buildMappingPath,
} from './endpoints.ts';
import {
  advanceProgressiveDiscovery,
  createProgressiveDiscovery,
  initializeProgressiveDiscovery,
  interruptProgressiveDiscovery,
  isProgressiveDiscoveryActive,
  progressiveSnapshot,
  resumeProgressiveDiscovery,
  withPageRetry,
} from './progressive.ts';

const org = demoOrgs[0]!;
const base = 'services/data/v65.0/ssot';
const dloPath = `${base}/data-lake-objects`;
const dmoPath = `${base}/data-model-objects?limit=100&offset=0`;
const dmoNames = ['Account_DMO__dlm', 'Contact_DMO__dlm', 'Order_DMO__dlm'];
const dmoSpaces: Record<string, string> = {
  Account_DMO__dlm: 'default',
  Contact_DMO__dlm: 'default',
  Order_DMO__dlm: 'sales_space',
};

const retry = {
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 1,
  sleep: async () => {},
  random: () => 0,
};

interface FakeCli extends RestClient {
  calls: string[];
  failures: Record<string, number>;
  errors: Record<string, string>;
}

function pagedDlos(total = 200, perPage = 10): Record<string, string> {
  const pages: Record<string, string> = {};
  const pageCount = total / perPage;
  for (let page = 0; page < pageCount; page += 1) {
    const path = page === 0 ? dloPath : `${dloPath}?pageToken=${page + 1}`;
    const records = Array.from({ length: perPage }, (_, index) => ({
      apiName: `DLO_${String(page * perPage + index).padStart(3, '0')}__dll`,
      fields: [],
    }));
    const nextToken = page < pageCount - 1 ? String(page + 2) : null;
    pages[path] = JSON.stringify({
      records,
      pagination: { ...(nextToken ? { pageToken: nextToken } : {}), total },
    });
  }
  return pages;
}

function fakeCli(
  overrides: Record<string, string> = {},
  failures: Record<string, number> = {},
  errors: Record<string, string> = {},
): FakeCli {
  const calls: string[] = [];
  const attempts = new Map<string, number>();
  const countFixtures = {
    'data-spaces': dataSpacesJson,
    dlos: pagedDlos()[dloPath]!,
    'data-streams': dataStreamsJson,
    'data-transforms': dataTransformsJson,
  } as const;
  const countPaths = Object.fromEntries(Object.entries(countFixtures).map(([family, response]) => [
    buildExpectedCountPath(family as keyof typeof countFixtures, '65.0')!,
    response,
  ]));
  const paths: Record<string, string> = {
    'services/data/': versionsJson,
    [`${base}/data-spaces`]: dataSpacesJson,
    [dloPath]: pagedDlos()[dloPath]!,
    ...pagedDlos(),
    [dmoPath]: dmosJson,
    [`${base}/data-streams`]: dataStreamsJson,
    [buildConnectorCatalogPath('65.0')]: connectorCatalogJson,
    [buildConnectorConnectionsPath('65.0', 'SalesforceDotCom')]: connectorConnectionsJson,
    [`${base}/data-transforms`]: dataTransformsJson,
    ...countPaths,
    ...Object.fromEntries(dmoNames.map((name) => [
      buildMappingPath(name, '65.0', dmoSpaces[name]), mappingsJson,
    ])),
    ...overrides,
  };
  return {
    calls,
    failures,
    errors,
    restGet: async (_alias, path) => {
      calls.push(path);
      const count = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, count);
      if (errors[path]) {
        throw new CliError('COMMAND_FAILED', errors[path]!);
      }
      if ((failures[path] ?? 0) >= count) {
        throw new CliError('COMMAND_FAILED', 'ERROR: 500 Server Error');
      }
      const value = paths[path];
      if (value === undefined && path.includes('/relationships?')) return '';
      if (value === undefined) throw new Error(`Unexpected REST path: ${path}`);
      return value;
    },
  };
}

async function drain(state: Awaited<ReturnType<typeof createProgressiveDiscovery>>): Promise<void> {
  for (let batch = 0; batch < 500 && isProgressiveDiscoveryActive(state); batch += 1) {
    await advanceProgressiveDiscovery(state);
  }
}

describe('progressive discovery', () => {
  it('returns a fast first batch, then progressively loads 200 DLOs across pages', async () => {
    const cli = fakeCli();
    const state = await createProgressiveDiscovery({ cli, alias: org.alias, org, retry });
    const first = progressiveSnapshot(state);

    expect(first.dlos).toHaveLength(10);
    expect(first.progress?.state).toBe('running');
    expect(first.progress?.families.find((family) => family.family === 'dlos')).toMatchObject({
      loaded: 10,
      total: 200,
      hasMore: true,
      status: 'partial',
    });
    expect(cli.calls.filter((path) => path === dloPath || path.startsWith(`${dloPath}?pageToken`))).toHaveLength(1);

    await drain(state);
    const complete = progressiveSnapshot(state);

    expect(complete.dlos).toHaveLength(200);
    expect(new Set(complete.dlos.map((dlo) => dlo.apiName)).size).toBe(200);
    expect(complete.progress?.state).toBe('complete');
    expect(complete.progress?.loaded).toBeGreaterThanOrEqual(200);
    expect(complete.capabilities.find((capability) => capability.family === 'dlos')).toMatchObject({
      status: 'available',
      itemCount: 200,
    });
    expect(cli.calls.filter((path) => path === dloPath || path.startsWith(`${dloPath}?pageToken`))).toHaveLength(20);
  });

  it('reads final expected counts from first-page response envelopes without delaying rows', async () => {
    const cli = fakeCli();
    const state = await createProgressiveDiscovery({ cli, alias: org.alias, org, retry });
    const progress = progressiveSnapshot(state).progress!;
    const familyProgress = (family: string) => progress.families.find((entry) => entry.family === family)!;

    expect(familyProgress('dlos')).toMatchObject({ expectedTotal: 200, expectedTotalSource: 'response' });
    expect(familyProgress('data-spaces')).toMatchObject({ expectedTotal: 2, expectedTotalSource: 'response' });
    expect(familyProgress('data-streams')).toMatchObject({ expectedTotal: 1, expectedTotalSource: 'response' });
    expect(familyProgress('data-transforms')).toMatchObject({ expectedTotal: 1, expectedTotalSource: 'response' });
    expect(familyProgress('dmos').expectedTotal).toBeNull();
    expect(familyProgress('mappings').expectedTotal).toBeNull();
    expect(cli.calls).not.toContain(`${dloPath}?limit=1`);
  });

  it('retries a reported count gap, then ends with a visible gap instead of looping forever', async () => {
    const records = Array.from({ length: 8 }, (_, index) => ({
      apiName: `Short_DLO_${String(index + 1).padStart(3, '0')}__dll`,
      fields: [],
    }));
    const cli = fakeCli({
      [dloPath]: JSON.stringify({ records, totalSize: 200 }),
    });
    const state = await createProgressiveDiscovery({ cli, alias: org.alias, org, retry });
    await drain(state);
    const snapshot = progressiveSnapshot(state);
    const dlos = snapshot.progress!.families.find((family) => family.family === 'dlos')!;

    expect(snapshot.dlos).toHaveLength(8);
    expect(dlos).toMatchObject({ expectedTotal: 200, status: 'partial', hasMore: false });
    expect(snapshot.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'dlos', code: 'EXPECTED_COUNT_MISMATCH' }),
    ]));
    expect(snapshot.progress!.state).toBe('complete');
    expect(cli.calls.filter((path) => path === dloPath).length).toBeLessThanOrEqual(3);
  });

  it('uses cursor completion when no trustworthy count is available', async () => {
    const countPath = buildExpectedCountPath('dlos', '65.0')!;
    const records = Array.from({ length: 8 }, (_, index) => ({
      apiName: `Unknown_Total_DLO_${String(index + 1).padStart(3, '0')}__dll`,
      fields: [],
    }));
    const cli = fakeCli({
      [dloPath]: JSON.stringify({ records, pagination: { pageToken: '2' } }),
      [`${dloPath}?pageToken=2`]: JSON.stringify({ records: [] }),
    }, {}, { [countPath]: 'ERROR running api request rest: 403 Forbidden' });
    const state = await createProgressiveDiscovery({ cli, alias: org.alias, org, retry });
    await drain(state);
    const snapshot = progressiveSnapshot(state);
    const dlos = snapshot.progress!.families.find((family) => family.family === 'dlos')!;

    expect(dlos.expectedTotal).toBeNull();
    expect(dlos.status).toBe('complete');
    expect(snapshot.progress!.state).toBe('complete');
    expect(snapshot.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'dlos', code: 'COUNT_PROBE_FAILED' }),
    ]));
  });

  it('does not expose a page-local total as complete while another page remains', async () => {
    const records = Array.from({ length: 8 }, (_, index) => ({
      apiName: `Page_DLO_${String(index + 1).padStart(3, '0')}__dll`,
      fields: [],
    }));
    const cli = fakeCli({
      [dloPath]: JSON.stringify({ records, pagination: { pageToken: '2', total: records.length } }),
    });
    const state = await createProgressiveDiscovery({ cli, alias: org.alias, org, retry });

    expect(progressiveSnapshot(state).progress?.families.find((family) => family.family === 'dlos'))
      .toMatchObject({ status: 'partial', loaded: 8, total: null, hasMore: true });

    await advanceProgressiveDiscovery(state);
    expect(progressiveSnapshot(state).progress?.families.find((family) => family.family === 'dlos'))
      .toMatchObject({ status: 'partial', expectedTotal: 200, hasMore: true });
  });

  it('keeps earlier pages when a late page fails and resumes from the checkpoint', async () => {
    const page2 = `${dloPath}?pageToken=2`;
    const failures: Record<string, number> = { [page2]: retry.maxAttempts };
    const cli = fakeCli({}, failures);
    const state = await createProgressiveDiscovery({ cli, alias: org.alias, org, retry });
    await advanceProgressiveDiscovery(state);

    expect(progressiveSnapshot(state).dlos).toHaveLength(10);
    expect(progressiveSnapshot(state).progress?.state).toBe('failed');
    expect(progressiveSnapshot(state).progress?.families.find((family) => family.family === 'dlos'))
      .toMatchObject({ status: 'failed', loaded: 10, hasMore: false });
    expect(cli.calls.filter((path) => path === page2)).toHaveLength(retry.maxAttempts);

    failures[page2] = 0;
    resumeProgressiveDiscovery(state, 'dlos');
    await drain(state);

    expect(progressiveSnapshot(state).dlos).toHaveLength(200);
    expect(progressiveSnapshot(state).progress?.state).toBe('complete');
    expect(cli.calls.filter((path) => path === page2)).toHaveLength(retry.maxAttempts + 1);
  });

  it('stops a repeated-cursor loop instead of duplicating rows', async () => {
    const page1 = JSON.stringify({
      records: [{ apiName: 'Loop_DLO__dll', fields: [] }],
      pagination: { nextToken: 'loop-token', total: 2 },
    });
    const cli = fakeCli({
      [dloPath]: page1,
      [`${dloPath}?nextToken=loop-token`]: page1,
    });
    const state = await createProgressiveDiscovery({ cli, alias: org.alias, org, retry });
    await drain(state);

    expect(progressiveSnapshot(state).dlos).toHaveLength(1);
    expect(progressiveSnapshot(state).warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'dlos', code: 'CONTINUATION_LOOP' }),
    ]));
    expect(progressiveSnapshot(state).capabilities.find((capability) => capability.family === 'dlos'))
      .toMatchObject({ status: 'partial', itemCount: 1 });
    expect(progressiveSnapshot(state).progress?.state).toBe('complete');
  });

  it('terminates a progressive session when API-version discovery is unsupported', async () => {
    const cli: RestClient = {
      restGet: async () => {
        throw new CliError('COMMAND_FAILED', 'ERROR running api request rest: (404) Not Found');
      },
    };
    const state = await createProgressiveDiscovery({ cli, alias: org.alias, org, retry });
    const snapshot = progressiveSnapshot(state);

    expect(snapshot.apiVersion).toBeNull();
    expect(snapshot.capabilities.find((capability) => capability.family === 'api-versions'))
      .toMatchObject({ status: 'unsupported' });
    expect(snapshot.capabilities.filter((capability) => capability.family !== 'api-versions')
      .every((capability) => capability.status === 'unsupported')).toBe(true);
    expect(snapshot.progress?.state).toBe('failed');
    expect(isProgressiveDiscoveryActive(state)).toBe(false);
  });

  it('does not let resume clear a forbidden family', async () => {
    const cli = fakeCli({}, {}, { [dloPath]: 'ERROR running api request rest: 403 Forbidden' });
    const state = await createProgressiveDiscovery({ cli, alias: org.alias, org, retry });
    const before = progressiveSnapshot(state);

    expect(before.capabilities.find((capability) => capability.family === 'dlos')?.status).toBe('forbidden');
    expect(before.progress?.families.find((family) => family.family === 'dlos'))
      .toMatchObject({ status: 'failed', errorStatus: 'forbidden' });

    resumeProgressiveDiscovery(state, 'dlos');
    const after = progressiveSnapshot(state);
    expect(after.capabilities.find((capability) => capability.family === 'dlos')?.status).toBe('forbidden');
    expect(after.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'dlos', code: 'FORBIDDEN' }),
    ]));
  });

  it('stamps later pages and the snapshot with page retrieval time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T00:00:00.000Z'));
    try {
      const state = await createProgressiveDiscovery({ cli: fakeCli(), alias: org.alias, org, retry });
      const firstPageTime = progressiveSnapshot(state).dlos[0]?.provenance.retrievedAt;

      vi.setSystemTime(new Date('2026-11-18T00:05:00.000Z'));
      await advanceProgressiveDiscovery(state);

      const lastItem = progressiveSnapshot(state).dlos.at(-1);
      expect(firstPageTime).toBe('2026-11-18T00:00:00.000Z');
      expect(lastItem?.provenance.retrievedAt).toBe('2026-11-18T00:05:00.000Z');
      expect(state.generatedAt).toBe('2026-11-18T00:05:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes when no DMOs exist and mapping lookup is intentionally skipped', async () => {
    const cli = fakeCli({
      [dmoPath]: JSON.stringify({ records: [] }),
    });
    const state = await createProgressiveDiscovery({ cli, alias: org.alias, org, retry });
    await drain(state);
    const snapshot = progressiveSnapshot(state);

    expect(snapshot.dmos).toHaveLength(0);
    expect(snapshot.progress?.state).toBe('complete');
    expect(snapshot.progress?.families.find((family) => family.family === 'mappings'))
      .toMatchObject({ status: 'not-started', loaded: 0, hasMore: false });
    expect(snapshot.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'mappings', code: 'MAPPINGS_SKIPPED' }),
    ]));
  });

  it('loads DMO offset pages without a continuation token', async () => {
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
    const state = await createProgressiveDiscovery({ cli, alias: org.alias, org, retry });
    await drain(state);
    const snapshot = progressiveSnapshot(state);

    expect(snapshot.dmos).toHaveLength(101);
    expect(cli.calls.filter((path) => path === nextPath)).toHaveLength(1);
    expect(snapshot.capabilities.find((capability) => capability.family === 'dmos')).toMatchObject({
      status: 'available',
      itemCount: 101,
    });
    expect(snapshot.warnings.every((warning) => warning.severity !== 'error')).toBe(true);
  });

  it('follows nextPageUrl for live stream responses', async () => {
    const streamPage1 = JSON.stringify({
      currentPageUrl: '/services/data/v65.0/ssot/data-streams?limit=10&offset=1',
      dataStreams: [{
        name: 'Account_Stream',
        connectorInfo: {
          connectorType: 'SalesforceDotCom',
          connectorDetails: { name: 'SalesforceDotCom_Home', type: 'SalesforceDotCom' },
        },
        dataSource: 'Salesforce_Home',
        dataLakeObjectInfo: { name: 'Account_DLO__dll' },
      }],
      nextPageUrl: '/services/data/v65.0/ssot/data-streams?limit=10&offset=11',
      totalSize: 2,
    });
    const streamPage2 = JSON.stringify({
      dataStreams: [{ name: 'Order_Stream', dataLakeObjectInfo: { name: 'Order_DLO__dll' } }],
      totalSize: 2,
    });
    const cli = fakeCli({
      [`${base}/data-streams`]: streamPage1,
      [`${base}/data-streams?limit=10&offset=11`]: streamPage2,
    });
    const state = await createProgressiveDiscovery({ cli, alias: org.alias, org, retry });
    await drain(state);
    const snapshot = progressiveSnapshot(state);

    expect(snapshot.dataStreams.map((stream) => stream.apiName)).toEqual(['Account_Stream', 'Order_Stream']);
    expect(snapshot.dataStreams[0]).toMatchObject({
      sourceConnector: 'SalesforceDotCom',
      sourceConnectorLabel: 'Salesforce CRM',
      sourceConnectionLabel: 'EPIC OrgFarm',
    });
    expect(snapshot.capabilities.find((capability) => capability.family === 'data-streams')?.itemCount).toBe(2);
  });

  it('does not mark a DMO-specific mapping NOT_FOUND as a failed family', async () => {
    const cli = fakeCli({}, {}, {
      [buildMappingPath('Account_DMO__dlm', '65.0', 'default')]: mappingNotFoundOutput,
    });
    const state = await createProgressiveDiscovery({ cli, alias: org.alias, org, retry });
    await drain(state);
    const snapshot = progressiveSnapshot(state);

    expect(snapshot.warnings.every((warning) => warning.severity !== 'error')).toBe(true);
    expect(snapshot.capabilities.find((capability) => capability.family === 'mappings')).toMatchObject({
      status: 'available',
      itemCount: 2,
    });
  });

  it('loads the same per-DMO relationships as one-shot discovery', async () => {
    const relationshipPath = buildDmoRelationshipsPath('Account_DMO__dlm', '65.0', 'default');
    const cli = fakeCli({ [relationshipPath]: dmoRelationshipsJson });
    const state = await createProgressiveDiscovery({ cli, alias: org.alias, org, retry });
    await drain(state);
    const snapshot = progressiveSnapshot(state);

    expect(cli.calls).toContain(relationshipPath);
    expect(snapshot.relationships).toEqual(expect.arrayContaining([
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
    expect(snapshot.progress?.state).toBe('complete');
  });

  it('retries transient page failures with bounded attempts', async () => {
    let attempts = 0;
    const result = await withPageRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw new CliError('COMMAND_FAILED', 'ERROR: 429 rate limit');
      return 'ok';
    }, retry);

    expect(result.value).toBe('ok');
    expect(result.attempts).toBe(3);
    expect(result.retried).toBe(true);
    expect(attempts).toBe(3);
  });

  it('publishes a snapshot after every committed page', async () => {
    const loadedCounts: number[] = [];
    await createProgressiveDiscovery({
      cli: fakeCli(),
      alias: org.alias,
      org,
      retry,
      onProgress: (current) => {
        const progress = progressiveSnapshot(current).progress;
        if (progress) loadedCounts.push(progress.loaded);
      },
    });

    expect(loadedCounts.length).toBeGreaterThan(1);
    expect(loadedCounts.at(-1)).toBeGreaterThan(loadedCounts[0]!);
  });

  it('ends visibly when the discovery deadline is reached', async () => {
    const state = await createProgressiveDiscovery({
      cli: fakeCli(),
      alias: org.alias,
      org,
      retry,
      maxDurationMs: 0,
    });
    const snapshot = progressiveSnapshot(state);

    expect(isProgressiveDiscoveryActive(state)).toBe(false);
    expect(snapshot.progress?.state).toBe('complete');
    expect(snapshot.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DISCOVERY_DEADLINE' }),
    ]));
  });

  it('resumes a deadline-stopped session with a fresh window and its loaded rows', async () => {
    const state = await initializeProgressiveDiscovery({ cli: fakeCli(), alias: org.alias, org, retry });
    state.deadlineAt = Date.now() - 1;
    await advanceProgressiveDiscovery(state);
    expect(progressiveSnapshot(state).progress?.state).toBe('complete');

    resumeProgressiveDiscovery(state);
    expect(isProgressiveDiscoveryActive(state)).toBe(true);
    expect(progressiveSnapshot(state).warnings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DISCOVERY_DEADLINE' }),
    ]));

    await drain(state);
    expect(progressiveSnapshot(state).progress?.state).toBe('complete');
    expect(progressiveSnapshot(state).dlos.length).toBeGreaterThan(10);
  });

  it('resumes a background interruption without discarding earlier pages', async () => {
    const state = await initializeProgressiveDiscovery({ cli: fakeCli(), alias: org.alias, org, retry });
    await advanceProgressiveDiscovery(state);
    const loadedBefore = progressiveSnapshot(state).dlos.length;
    interruptProgressiveDiscovery(state, 'test failure');
    expect(isProgressiveDiscoveryActive(state)).toBe(false);

    resumeProgressiveDiscovery(state);
    expect(isProgressiveDiscoveryActive(state)).toBe(true);
    await drain(state);

    expect(progressiveSnapshot(state).progress?.state).toBe('complete');
    expect(progressiveSnapshot(state).warnings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DISCOVERY_INTERRUPTED' }),
    ]));
    expect(progressiveSnapshot(state).dlos.length).toBeGreaterThan(loadedBefore);
  });

  it('does not keep polling a deadline-stopped family with an unmet expected count', async () => {
    const state = await initializeProgressiveDiscovery({ cli: fakeCli(), alias: org.alias, org, retry });
    const dlos = state.families.dlos;
    dlos.expectedTotal = 999;
    dlos.expectedTotalSource = 'response';
    dlos.pageIndex = 1;
    state.deadlineAt = Date.now() - 1;

    const result = await advanceProgressiveDiscovery(state);

    expect(result.active).toBe(false);
    expect(isProgressiveDiscoveryActive(state)).toBe(false);
    expect(progressiveSnapshot(state).progress?.state).toBe('complete');
  });

  it('terminalizes active cursors after a background interruption', async () => {
    const state = await initializeProgressiveDiscovery({ cli: fakeCli(), alias: org.alias, org, retry });
    interruptProgressiveDiscovery(state, 'test failure');
    const snapshot = progressiveSnapshot(state);

    expect(isProgressiveDiscoveryActive(state)).toBe(false);
    expect(snapshot.progress?.state).toBe('complete');
    expect(snapshot.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DISCOVERY_INTERRUPTED' }),
    ]));
  });
});
