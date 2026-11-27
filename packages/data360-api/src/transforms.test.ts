import { describe, expect, it, vi } from 'vitest';
import type { DataTransform } from '@dcat/core';
import { transformBundleSchema } from '@dcat/core';
import { CliError } from '@dcat/salesforce-cli';
import {
  forbiddenRestOutput,
  transformDetailJson,
  transformHistoriesJson,
  transformLiveDetailJson,
  transformRunHistoryJson,
  transformScheduleEmptyJson,
  transformScheduleJson,
  unsupportedRestOutput,
} from '@dcat/test-fixtures';
import type { RestClient } from './discover.ts';
import {
  fetchTransformBundle,
  createUnsupportedTransformBundle,
  MAX_TRANSFORM_METADATA_BYTES,
  MAX_TRANSFORM_RUN_PAGES,
} from './transforms.ts';

const base = 'services/data/v65.0/ssot/data-transforms/Account_Transform';
const detailPath = `${base}?filterGroup=Big`;
const runPath = `${base}/run-history`;
const schedulePath = `${base}/schedule`;

interface FakeClient extends RestClient {
  calls: string[];
}

function fakeClient(paths: Record<string, string | Error | string[]>): FakeClient {
  const calls: string[] = [];
  const indexes = new Map<string, number>();
  return {
    calls,
    restGet: vi.fn(async (_alias: string, path: string) => {
      calls.push(path);
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

const seed: DataTransform = {
  apiName: 'Account_Transform',
  id: '0TfTEST000000001AAA',
  label: 'List-provided Transform',
  status: 'Active',
  provenance: {
    orgId: '00DTEST000000000AAA',
    orgAlias: 'test-org',
    sourceEndpoint: 'services/data/v65.0/ssot/data-transforms',
    apiVersion: '65.0',
    retrievedAt: '2026-11-18T00:00:00.000Z',
    confidence: 'source',
  },
};

function options(client: RestClient, overrides: Partial<Parameters<typeof fetchTransformBundle>[0]> = {}) {
  return { client, alias: 'test-org', apiVersion: '65.0', id: 'Account_Transform', ...overrides };
}

describe('lazy transform bundle retrieval', () => {
  it('normalizes detail, run history, and schedule from only the allowlisted GET paths', async () => {
    const client = fakeClient({
      [detailPath]: transformDetailJson,
      [runPath]: transformRunHistoryJson,
      [schedulePath]: transformScheduleJson,
    });

    const bundle = await fetchTransformBundle(options(client));
    expect(bundle.sections).toEqual({ detail: 'available', runHistory: 'available', schedule: 'available' });
    expect(bundle.transform).toMatchObject({
      apiName: 'Account_Transform',
      type: 'Batch',
      status: 'Active',
      lastRunStatus: 'Success',
      inputs: ['Account_DLO__dll', 'Order_DLO__dll'],
      outputs: ['Account_DMO__dlm'],
      schedule: 'Daily at 02:00 UTC',
      dataSpace: 'default',
      owner: 'architect@example.invalid',
    });
    expect(bundle.transform?.provenance.sourceEndpoint).toBe(detailPath);
    expect(bundle.runs.map((run) => run.id)).toEqual(['run-1', 'run-2']);
    expect(bundle.runs[0]).toMatchObject({ durationMs: 195000, recordsProcessed: 12840, status: 'Success' });
    expect(bundle.runs[1]?.message).toBe('Source object was temporarily unavailable.');
    expect(bundle.runs.every((run) => run.provenance.sourceEndpoint === runPath)).toBe(true);
    expect(bundle.schedule).toMatchObject({ cadence: 'Daily', timezone: 'UTC', enabled: true });
    expect(bundle.schedule?.provenance.sourceEndpoint).toBe(schedulePath);
    expect(client.calls).toEqual([detailPath, runPath, schedulePath]);
    expect(transformBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it('reads live Big definitions and documented histories into the detail tabs', async () => {
    const client = fakeClient({
      [detailPath]: transformLiveDetailJson,
      [runPath]: transformHistoriesJson,
      [schedulePath]: transformScheduleJson,
    });

    const bundle = await fetchTransformBundle(options(client));

    expect(bundle.sections).toEqual({ detail: 'available', runHistory: 'available', schedule: 'available' });
    expect(bundle.transform).toMatchObject({
      apiName: 'AccountTransform',
      label: 'Account Transform',
      type: 'Batch',
      inputs: ['Account_Home__dll'],
      outputs: ['Account_Cleaned__dll'],
    });
    expect(bundle.transform?.definition).toContain('Account_Cleaned__dll');
    expect(bundle.transform?.visualDefinition?.nodes.map((node) => node.id)).toEqual(['LOAD_DATASET0', 'OUTPUT0']);
    expect(bundle.transform?.visualDefinition?.edges).toHaveLength(1);
    expect(bundle.runs).toMatchObject([{
      id: 'req-1dtg7000001XCY5AAO',
      status: 'Success',
      recordsProcessed: 1130,
      startedAt: '2026-11-26T02:53:50.000Z',
      endedAt: '2026-11-26T02:53:55.000Z',
    }]);
    expect(bundle.messages.runHistory).toMatch(/Retrieved 1 run/);
    expect(transformBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it('treats an empty documented history collection as an explicit empty run history', async () => {
    const client = fakeClient({
      [detailPath]: transformDetailJson,
      [runPath]: JSON.stringify({ histories: [], totalSize: 0 }),
      [schedulePath]: transformScheduleJson,
    });

    const bundle = await fetchTransformBundle(options(client));

    expect(bundle.sections.runHistory).toBe('available');
    expect(bundle.runs).toEqual([]);
    expect(bundle.messages.runHistory).toMatch(/no runs/);
  });

  it('omits an oversized transform definition instead of producing an unrelayable bundle', async () => {
    const detail = JSON.parse(transformDetailJson) as { result: Record<string, unknown> };
    delete detail.result.transformDefinition;
    detail.result.definitions = 'x'.repeat(MAX_TRANSFORM_METADATA_BYTES + 1);
    detail.result.notes = 'y'.repeat(MAX_TRANSFORM_METADATA_BYTES + 1);
    const client = fakeClient({
      [detailPath]: JSON.stringify(detail),
      [runPath]: transformRunHistoryJson,
      [schedulePath]: transformScheduleJson,
    });

    const bundle = await fetchTransformBundle(options(client));

    expect(bundle.sections.detail).toBe('partial');
    expect(bundle.messages.detail).toMatch(/metadata was omitted/i);
    expect(bundle.transform?.definition).toMatch(/omitted/i);
    expect(JSON.stringify(bundle.transform?.raw)).toMatch(/omitted/i);
    expect(new TextEncoder().encode(JSON.stringify(bundle)).byteLength).toBeLessThan(MAX_TRANSFORM_METADATA_BYTES);
    expect(transformBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it('uses the list seed when detail is forbidden without blanking other sections', async () => {
    const client = fakeClient({
      [detailPath]: new CliError('COMMAND_FAILED', forbiddenRestOutput),
      [runPath]: transformRunHistoryJson,
      [schedulePath]: transformScheduleJson,
    });

    const bundle = await fetchTransformBundle(options(client, { seed }));
    expect(bundle.sections).toEqual({ detail: 'forbidden', runHistory: 'available', schedule: 'available' });
    expect(bundle.transform).toEqual(seed);
    expect(bundle.messages.detail).toMatch(/Access denied/);
    expect(bundle.messages.detail).toMatch(/inventory list/);
    expect(bundle.runs).toHaveLength(2);
    expect(bundle.schedule?.enabled).toBe(true);
  });

  it('keeps unsupported and empty states explicit instead of inventing runs or a schedule', async () => {
    const client = fakeClient({
      [detailPath]: transformDetailJson,
      [runPath]: new CliError('COMMAND_FAILED', unsupportedRestOutput),
      [schedulePath]: transformScheduleEmptyJson,
    });

    const bundle = await fetchTransformBundle(options(client));
    expect(bundle.sections).toEqual({ detail: 'available', runHistory: 'unsupported', schedule: 'available' });
    expect(bundle.runs).toEqual([]);
    expect(bundle.schedule).toBeNull();
    expect(bundle.messages.runHistory).toMatch(/unavailable for this org or API version/);
    expect(bundle.messages.schedule).toMatch(/no schedule metadata/);
  });

  it('falls back to the list seed when the detail response is malformed', async () => {
    const client = fakeClient({
      [detailPath]: 'not json',
      [runPath]: transformRunHistoryJson,
      [schedulePath]: transformScheduleJson,
    });

    const bundle = await fetchTransformBundle(options(client, { seed }));
    expect(bundle.sections.detail).toBe('error');
    expect(bundle.messages.detail).toMatch(/not valid JSON/);
    expect(bundle.messages.detail).toMatch(/inventory list/);
    expect(bundle.transform).toEqual(seed);
  });

  it('bounds run-history pagination without affecting other sections', async () => {
    // Use a distinct cursor and record on every page so the cap, not dedupe
    // or loop detection, is what stops retrieval.
    const pages: Record<string, string> = {
      [runPath]: JSON.stringify({ records: [{ runId: 'run-0' }], nextToken: 'token-1' }),
    };
    for (let page = 1; page < MAX_TRANSFORM_RUN_PAGES; page += 1) {
      pages[`${runPath}?nextToken=token-${page}`] = JSON.stringify({
        records: [{ runId: `run-${page}` }],
        // Keep a cursor on the final page so the cap, not exhaustion, is hit.
        nextToken: `token-${page + 1}`,
      });
    }
    const client = fakeClient({
      [detailPath]: transformDetailJson,
      ...pages,
      [schedulePath]: transformScheduleJson,
    });

    const bundle = await fetchTransformBundle(options(client));
    expect(MAX_TRANSFORM_RUN_PAGES).toBe(20);
    expect(bundle.runs).toHaveLength(20);
    expect(bundle.sections.runHistory).toBe('partial');
    expect(bundle.messages.runHistory).toMatch(/Pagination stopped after 20 page/);
    expect(client.calls.filter((path) => path.startsWith(runPath))).toHaveLength(20);
    expect(bundle.sections.schedule).toBe('available');
  });

  it('redacts credential-shaped values from live definition text', async () => {
    const detail = JSON.parse(transformLiveDetailJson) as { result: { definitions: Array<Record<string, unknown>> } };
    detail.result.definitions[0]!.clientSecret = 'fake-definition-secret';
    const client = fakeClient({
      [detailPath]: JSON.stringify(detail),
      [runPath]: transformHistoriesJson,
      [schedulePath]: transformScheduleJson,
    });

    const bundle = await fetchTransformBundle(options(client));

    expect(bundle.transform?.definition).toContain('[REDACTED]');
    expect(JSON.stringify(bundle)).not.toContain('fake-definition-secret');
  });

  it('prefers requestId and drops duplicate history rows', async () => {
    const client = fakeClient({
      [detailPath]: transformDetailJson,
      [runPath]: JSON.stringify({
        histories: [
          { requestId: 'req-1', id: 'parent-transform', status: 'Success' },
          { requestId: 'req-1', status: 'Failure' },
          { requestId: 'req-2', status: 'Success' },
        ],
        totalSize: 3,
      }),
      [schedulePath]: transformScheduleJson,
    });

    const bundle = await fetchTransformBundle(options(client));

    expect(bundle.runs.map((run) => run.id)).toEqual(['req-1', 'req-2']);
    expect(bundle.runs[0]?.status).toBe('Success');
  });

  it('redacts credential-shaped values from raw metadata', async () => {
    const token = '00DDEMOTOKEN_NOT_REAL_DO_NOT_USE_000000000000000000000000';
    const client = fakeClient({
      [detailPath]: JSON.stringify({
        apiName: 'Account_Transform',
        status: 'Active',
        accessToken: token,
        nested: { clientSecret: 'fake-secret', safeValue: 'keep me' },
      }),
      [runPath]: transformRunHistoryJson,
      [schedulePath]: transformScheduleJson,
    });

    const bundle = await fetchTransformBundle(options(client));
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('fake-secret');
    expect(serialized).toContain('[REDACTED]');
    expect(bundle.transform?.raw).toMatchObject({ nested: { safeValue: 'keep me' } });
  });

  it('rejects invalid ids and versions before any request is made', async () => {
    const client = fakeClient({});
    await expect(fetchTransformBundle(options(client, { id: '../other' }))).rejects.toThrow(CliError);
    await expect(fetchTransformBundle(options(client, { apiVersion: 'latest' }))).rejects.toThrow(CliError);
    expect(client.calls).toEqual([]);
  });

  it('creates an explicit unsupported bundle when no API version is available', () => {
    const bundle = createUnsupportedTransformBundle(seed, 'No API version is available.');
    expect(bundle.transform).toEqual(seed);
    expect(bundle.runs).toEqual([]);
    expect(bundle.schedule).toBeNull();
    expect(bundle.sections).toEqual({ detail: 'unsupported', runHistory: 'unsupported', schedule: 'unsupported' });
    expect(bundle.messages.detail).toMatch(/inventory list/);
    expect(bundle.messages.runHistory).toMatch(/not requested/);
    expect(transformBundleSchema.safeParse(bundle).success).toBe(true);
  });
});
