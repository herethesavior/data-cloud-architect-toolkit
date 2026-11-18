import { describe, expect, it } from 'vitest';
import {
  dataSpacesJson,
  dataStreamsJson,
  dataTransformsJson,
  demoOrgs,
  dmosJson,
  mappingsJson,
  versionsJson,
} from '@dcat/test-fixtures';
import { CliError } from '@dcat/salesforce-cli';
import type { RestClient } from './discover.ts';
import { buildMappingPath } from './endpoints.ts';
import {
  advanceProgressiveDiscovery,
  createProgressiveDiscovery,
  isProgressiveDiscoveryActive,
  progressiveSnapshot,
  resumeProgressiveDiscovery,
  withPageRetry,
} from './progressive.ts';

const org = demoOrgs[0]!;
const base = 'services/data/v65.0/ssot';
const dloPath = `${base}/data-lake-objects`;
const dmoNames = ['Account_DMO__dlm', 'Contact_DMO__dlm', 'Order_DMO__dlm'];

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

function fakeCli(overrides: Record<string, string> = {}, failures: Record<string, number> = {}): FakeCli {
  const calls: string[] = [];
  const attempts = new Map<string, number>();
  const paths: Record<string, string> = {
    'services/data/': versionsJson,
    [`${base}/data-spaces`]: dataSpacesJson,
    [dloPath]: pagedDlos()[dloPath]!,
    ...pagedDlos(),
    [`${base}/data-model-objects`]: dmosJson,
    [`${base}/data-streams`]: dataStreamsJson,
    [`${base}/data-transforms`]: dataTransformsJson,
    ...Object.fromEntries(dmoNames.map((name) => [buildMappingPath(name, '65.0'), mappingsJson])),
    ...overrides,
  };
  return {
    calls,
    failures,
    restGet: async (_alias, path) => {
      calls.push(path);
      const count = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, count);
      if ((failures[path] ?? 0) >= count) {
        throw new CliError('COMMAND_FAILED', 'ERROR: 500 Server Error');
      }
      const value = paths[path];
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
    expect(cli.calls.filter((path) => path.startsWith(dloPath))).toHaveLength(1);

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
    expect(cli.calls.filter((path) => path.startsWith(dloPath))).toHaveLength(20);
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
  });

  it('completes when no DMOs exist and mapping lookup is intentionally skipped', async () => {
    const cli = fakeCli({
      [`${base}/data-model-objects`]: JSON.stringify({ records: [] }),
    });
    const state = await createProgressiveDiscovery({ cli, alias: org.alias, org, retry });
    await drain(state);
    const snapshot = progressiveSnapshot(state);

    expect(snapshot.dmos).toHaveLength(0);
    expect(snapshot.progress?.state).toBe('complete');
    expect(snapshot.progress?.families.find((family) => family.family === 'mappings'))
      .toMatchObject({ status: 'complete', loaded: 0, hasMore: false });
    expect(snapshot.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'mappings', code: 'MAPPINGS_SKIPPED' }),
    ]));
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
});
