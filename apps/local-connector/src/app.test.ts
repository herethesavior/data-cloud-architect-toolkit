import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFamilyPath } from '@dcat/data360-api';
import type { ProcessRunner, RunOptions } from '@dcat/salesforce-cli';
import {
  cliVersionOutput,
  connectorCatalogJson,
  connectorConnectionsJson,
  dataSpacesJson,
  dataStreamsJson,
  dataTransformsJson,
  dlosJson,
  dmosJson,
  mappingsJson,
  orgListJson,
  transformDetailJson,
  transformHistoriesJson,
  transformLiveDetailJson,
  transformRunHistoryJson,
  transformScheduleJson,
  versionsJson,
} from '@dcat/test-fixtures';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const localHeaders = { host: 'localhost:3847' };
const testCompatibilityPath = join(tmpdir(), 'dcat-app-test-compatibility.json');

function testConfig(mode: 'demo' | 'live') {
  return {
    ...loadConfig({ DCAT_API_COMPATIBILITY_PATH: testCompatibilityPath }, []),
    mode,
    sessionToken: 'phase1-test-token',
  };
}

beforeEach(() => rmSync(testCompatibilityPath, { force: true }));
afterEach(() => rmSync(testCompatibilityPath, { force: true }));

async function demoApp() {
  const config = testConfig('demo');
  // Starting in demo must not call it, but switching to live refreshes status.
  return buildApp({ config, runner: liveCliRunner() });
}

/** Fake CLI that answers version, org-list, and every Data 360 REST path. */
function liveCliRunner(transformBodies: { detail?: string; runHistory?: string } = {}): ProcessRunner {
  const restBodies: Record<string, string> = { '/services/data/': versionsJson };
  for (const version of ['65.0', '67.0']) {
    const base = `/services/data/v${version}/ssot`;
    Object.assign(restBodies, {
      [`${base}/data-spaces`]: dataSpacesJson,
      [`${base}/data-lake-objects`]: dlosJson,
      [`${base}/data-model-objects?limit=10&offset=0`]: dmosJson,
      [`${base}/data-model-object-mappings`]: mappingsJson,
      [`${base}/data-streams`]: dataStreamsJson,
      [`${base}/connectors`]: connectorCatalogJson,
      [`${base}/connections?connectorType=SalesforceDotCom`]: connectorConnectionsJson,
      [`/${buildFamilyPath('data-transforms', version)}`]: dataTransformsJson,
      [`${base}/data-transforms/Account_Transform`]: transformBodies.detail ?? transformDetailJson,
      [`${base}/data-transforms/Account_Transform?filterGroup=Big`]: transformBodies.detail ?? transformDetailJson,
      [`${base}/data-transforms/Account_Transform/run-history`]: transformBodies.runHistory ?? transformRunHistoryJson,
      [`${base}/data-transforms/Account_Transform/schedule`]: transformScheduleJson,
    });
  }
  const restBody = (path: string): string | undefined => restBodies[path]
    ?? (/^\/services\/data\/v(?:65|67)\.0\/ssot\/data-model-object-mappings\?/.test(path)
      && path.includes('dmoDeveloperName=')
      ? mappingsJson
      : path.includes('/relationships?')
        ? ''
        : undefined);
  return {
    run: vi.fn(async (args: readonly string[], _options?: RunOptions) => {
      if (args[0] === '--version') {
        return { stdout: cliVersionOutput, stderr: '', exitCode: 0 };
      }
      if (args[0] === 'org' && args[1] === 'list') {
        return { stdout: orgListJson, stderr: '', exitCode: 0 };
      }
      if (args[0] === 'org' && args[1] === 'login' && args[2] === 'web') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'api' && args[1] === 'request' && args[2] === 'rest') {
        const body = restBody(args[3] ?? '');
        if (body === undefined) {
          return { stdout: '', stderr: `Unexpected REST path: ${args[3] ?? ''}`, exitCode: 1 };
        }
        return { stdout: body, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `Unexpected CLI command: ${args.join(' ')}`, exitCode: 1 };
    }),
  };
}

describe('local connector API', () => {
  it('reports health in demo mode without touching the CLI', async () => {
    const app = await demoApp();
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: localHeaders });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', mode: 'demo' });
    await app.close();
  });

  it('exposes the bridge-local API compatibility setting', async () => {
    const app = await demoApp();
    const response = await app.inject({ method: 'GET', url: '/api/compatibility', headers: localHeaders });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      selection: { mode: 'recommended' },
      recommended: '67.0',
      supported: ['65.0', '66.0', '67.0', '68.0'],
    });
    await app.close();
  });

  it('rejects an arbitrary API version without saving it', async () => {
    const app = await demoApp();
    const denied = await app.inject({
      method: 'POST',
      url: '/api/compatibility',
      payload: { mode: 'specific', version: '99.0' },
      headers: { ...localHeaders, 'x-dcat-token': 'phase1-test-token' },
    });
    expect(denied.statusCode).toBe(400);
    const status = await app.inject({ method: 'GET', url: '/api/compatibility', headers: localHeaders });
    expect(status.json().selection).toEqual({ mode: 'recommended' });
    await app.close();
  });

  it('saves a curated API version behind the session token', async () => {
    const app = await demoApp();
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/compatibility',
      payload: { mode: 'specific', version: '68.0' },
      headers: localHeaders,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const saved = await app.inject({
      method: 'POST',
      url: '/api/compatibility',
      payload: { mode: 'specific', version: '68.0' },
      headers: { ...localHeaders, 'x-dcat-token': 'phase1-test-token' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().selection).toEqual({ mode: 'specific', version: '68.0' });

    const status = await app.inject({ method: 'GET', url: '/api/compatibility', headers: localHeaders });
    expect(status.json().selection).toEqual({ mode: 'specific', version: '68.0' });
    const health = await app.inject({ method: 'GET', url: '/api/health', headers: localHeaders });
    expect(health.json().compatibility.selection).toEqual({ mode: 'specific', version: '68.0' });
    await app.close();
  });

  it('does not probe the CLI when starting in demo mode', async () => {
    const config = testConfig('demo');
    const run = vi.fn(async () => ({ stdout: cliVersionOutput, stderr: '', exitCode: 0 }));
    const app = await buildApp({ config, runner: { run } });

    const response = await app.inject({ method: 'GET', url: '/api/health', headers: localHeaders });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mode: 'demo' });
    expect(run).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires the per-run token for state-changing requests', async () => {
    const app = await demoApp();
    const denied = await app.inject({ method: 'POST', url: '/api/mode', payload: { mode: 'live' }, headers: localHeaders });
    expect(denied.statusCode).toBe(401);
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/mode',
      payload: { mode: 'live' },
      headers: { ...localHeaders, 'x-dcat-token': 'phase1-test-token' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ mode: 'live' });
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: localHeaders });
    expect(session.json().mode).toBe('live');
    await app.close();
  });

  it('requires the per-run token to connect an org and runs only the fixed web login command', async () => {
    const config = testConfig('live');
    const runner = liveCliRunner();
    const app = await buildApp({ config, runner });

    const denied = await app.inject({
      method: 'POST',
      url: '/api/orgs/connect',
      payload: { alias: 'demo-uat' },
      headers: localHeaders,
    });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/orgs/connect',
      payload: { alias: 'demo-uat', instanceUrl: 'https://demo--uat.sandbox.my.salesforce.com' },
      headers: { ...localHeaders, 'x-dcat-token': 'phase1-test-token' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ alias: 'demo-uat', source: 'salesforce-cli' });
    expect(runner.run).toHaveBeenCalledWith(
      ['org', 'login', 'web', '--alias', 'demo-uat', '--set-default', '--instance-url', 'https://demo--uat.sandbox.my.salesforce.com'],
      expect.objectContaining({ timeoutMs: 5 * 60_000 }),
    );
    await app.close();
  });

  it('rejects live org connection in demo mode and validates the instance URL', async () => {
    const demo = await demoApp();
    const deniedDemo = await demo.inject({
      method: 'POST',
      url: '/api/orgs/connect',
      payload: { alias: 'demo-uat' },
      headers: { ...localHeaders, 'x-dcat-token': 'phase1-test-token' },
    });
    expect(deniedDemo.statusCode).toBe(400);
    expect(deniedDemo.json().error.code).toBe('INVALID_ARGUMENT');
    await demo.close();

    const config = testConfig('live');
    const runner = liveCliRunner();
    const live = await buildApp({ config, runner });
    const badUrl = await live.inject({
      method: 'POST',
      url: '/api/orgs/connect',
      payload: { alias: 'demo-uat', instanceUrl: 'https://evil.example' },
      headers: { ...localHeaders, 'x-dcat-token': 'phase1-test-token' },
    });
    expect(badUrl.statusCode).toBe(400);
    expect(badUrl.json().error.code).toBe('INVALID_ARGUMENT');
    expect(runner.run).not.toHaveBeenCalledWith(
      expect.arrayContaining(['login']),
      expect.anything(),
    );
    await live.close();
  });

  it('requires the token even for a GET that forces inventory refresh', async () => {
    const app = await demoApp();
    const denied = await app.inject({
      method: 'GET',
      url: '/api/orgs/demo-uat/inventory?refresh=1',
      headers: localHeaders,
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe('INVALID_SESSION_TOKEN');

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/orgs/demo-uat/inventory?refresh=1',
      headers: { ...localHeaders, 'x-dcat-token': 'phase1-test-token' },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it('serves demo orgs and a clearly labelled demo inventory', async () => {
    const app = await demoApp();
    const orgs = await app.inject({ method: 'GET', url: '/api/orgs', headers: localHeaders });
    expect(orgs.statusCode).toBe(200);
    expect(orgs.json()[0]).toMatchObject({ alias: 'demo-uat', source: 'demo-fixture' });

    const inventory = await app.inject({ method: 'GET', url: '/api/orgs/demo-uat/inventory', headers: localHeaders });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json().mode).toBe('demo');
    expect(inventory.json().dlos.length).toBeGreaterThan(0);
    expect(inventory.json().dmos.length).toBeGreaterThan(0);
    await app.close();
  });

  it('rejects non-loopback hosts and origins', async () => {
    const app = await demoApp();
    const badHost = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example' } });
    expect(badHost.statusCode).toBe(403);
    const badOrigin = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { ...localHeaders, origin: 'https://evil.example' },
    });
    expect(badOrigin.statusCode).toBe(403);
    await app.close();
  });

  it('discovers live inventory through the CLI and labels it live', async () => {
    const config = testConfig('live');
    const app = await buildApp({ config, runner: liveCliRunner() });

    const health = await app.inject({ method: 'GET', url: '/api/health', headers: localHeaders });
    expect(health.json().mode).toBe('live');

    const inventory = await app.inject({
      method: 'GET',
      url: '/api/orgs/demo-uat/inventory',
      headers: localHeaders,
    });
    expect(inventory.statusCode).toBe(200);
    const body = inventory.json();
    expect(body.mode).toBe('live');
    expect(body.apiVersion).toBe('67.0');
    expect(body.dlos.length).toBeGreaterThan(0);
    expect(body.dmos.length).toBeGreaterThan(0);
    expect(body.dataSpaces.length).toBeGreaterThan(0);
    expect(body.capabilities.length).toBeGreaterThanOrEqual(7);
    expect(body.capabilities.every((capability: { status: string }) => capability.status === 'available')).toBe(true);
    expect(body.warnings).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain('DISCOVERY_PENDING');
    expect(body.dlos[0].provenance).toMatchObject({ apiVersion: '67.0', confidence: 'source' });
    await app.close();
  });

  it('validates scoped discovery families on the local session route', async () => {
    const config = testConfig('live');
    const app = await buildApp({ config, runner: liveCliRunner() });
    const headers = { ...localHeaders, 'x-dcat-token': 'phase1-test-token' };

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/orgs/demo-uat/inventory/session',
      payload: { refresh: true, families: ['dlos', 'not-a-family'] },
      headers,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_ARGUMENT');

    const valid = await app.inject({
      method: 'POST',
      url: '/api/orgs/demo-uat/inventory/session',
      payload: { refresh: true, families: ['mappings'] },
      headers,
    });
    expect(valid.statusCode).toBe(200);
    await app.close();
  });

  it('clears live discovery sessions when the mode changes directly', async () => {
    const config = testConfig('live');
    const app = await buildApp({ config, runner: liveCliRunner() });
    const headers = { ...localHeaders, 'x-dcat-token': 'phase1-test-token' };

    const started = await app.inject({
      method: 'POST',
      url: '/api/orgs/demo-uat/inventory/session',
      payload: {},
      headers,
    });
    expect(started.statusCode).toBe(200);
    const sessionId = started.json().sessionId as string;
    expect(sessionId).toBeTruthy();

    const switched = await app.inject({
      method: 'POST',
      url: '/api/mode',
      payload: { mode: 'demo' },
      headers,
    });
    expect(switched.json()).toMatchObject({ mode: 'demo' });

    const switchedBack = await app.inject({
      method: 'POST',
      url: '/api/mode',
      payload: { mode: 'live' },
      headers,
    });
    expect(switchedBack.json()).toMatchObject({ mode: 'live' });

    const status = await app.inject({
      method: 'POST',
      url: `/api/orgs/demo-uat/inventory/session/${encodeURIComponent(sessionId)}`,
      payload: {},
      headers,
    });
    expect(status.statusCode).toBe(502);
    expect(status.json().error.code).toBe('SESSION_EXPIRED');
    await app.close();
  });

  it('serves a labelled demo transform bundle on a plain GET', async () => {
    const app = await demoApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/orgs/demo-uat/data-transforms/Normalize_Contacts',
      headers: localHeaders,
    });

    expect(response.statusCode).toBe(200);
    const bundle = response.json();
    expect(bundle.transform).toMatchObject({ apiName: 'Normalize_Contacts', type: 'Batch', status: 'Active' });
    expect(bundle.transform.status).not.toBe(bundle.transform.lastRunStatus);
    expect(bundle.runs).toHaveLength(2);
    expect(bundle.schedule).toMatchObject({ cadence: 'Daily at 02:00 UTC', enabled: true });
    expect(bundle.sections).toEqual({ detail: 'available', runHistory: 'available', schedule: 'available' });
    expect(JSON.stringify(bundle.messages)).toContain('Demo fixture');
    await app.close();
  });

  it('returns TRANSFORM_NOT_FOUND for an unknown demo transform id', async () => {
    const app = await demoApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/orgs/demo-uat/data-transforms/Not_A_Transform',
      headers: localHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('TRANSFORM_NOT_FOUND');
    await app.close();
  });

  it('fetches a live transform bundle through the allowlisted GET paths without a token', async () => {
    const config = testConfig('live');
    const runner = liveCliRunner();
    const app = await buildApp({ config, runner });

    const response = await app.inject({
      method: 'GET',
      url: '/api/orgs/demo-uat/data-transforms/Account_Transform',
      headers: localHeaders,
    });
    expect(response.statusCode).toBe(200);
    const bundle = response.json();
    expect(bundle.transform).toMatchObject({ apiName: 'Account_Transform', type: 'Batch' });
    expect(bundle.runs).toHaveLength(2);
    expect(bundle.schedule).toMatchObject({ cadence: 'Daily', enabled: true });
    expect(bundle.transform.provenance).toMatchObject({ apiVersion: '67.0', confidence: 'source' });
    expect(bundle.sections).toEqual({ detail: 'available', runHistory: 'available', schedule: 'available' });

    const restPaths = vi.mocked(runner.run).mock.calls
      .map(([args]) => args[3])
      .filter((path) => path?.includes('/data-transforms/'));
    expect(restPaths).toEqual(expect.arrayContaining([
      '/services/data/v67.0/ssot/data-transforms/Account_Transform?filterGroup=Big',
      '/services/data/v67.0/ssot/data-transforms/Account_Transform/run-history',
      '/services/data/v67.0/ssot/data-transforms/Account_Transform/schedule',
    ]));
    await app.close();
  });

  it('normalizes live Big transform detail and documented histories through the connector', async () => {
    const config = testConfig('live');
    const runner = liveCliRunner({
      detail: transformLiveDetailJson,
      runHistory: transformHistoriesJson,
    });
    const app = await buildApp({ config, runner });

    const response = await app.inject({
      method: 'GET',
      url: '/api/orgs/demo-uat/data-transforms/Account_Transform',
      headers: localHeaders,
    });
    expect(response.statusCode).toBe(200);
    const bundle = response.json();
    expect(bundle.transform).toMatchObject({
      apiName: 'AccountTransform',
      inputs: ['Account_Home__dll'],
      outputs: ['Account_Cleaned__dll'],
    });
    expect(bundle.transform.definition).toContain('AccountTransformDefinition');
    expect(bundle.transform.visualDefinition.nodes).toHaveLength(2);
    expect(bundle.runs).toMatchObject([{ id: 'req-1dtg7000001XCY5AAO', status: 'Success' }]);
    expect(bundle.sections).toEqual({ detail: 'available', runHistory: 'available', schedule: 'available' });
    await app.close();
  });

  it('uses a browser-resolved API version without resolving a full inventory first', async () => {
    const config = testConfig('live');
    const runner = liveCliRunner();
    const app = await buildApp({ config, runner });

    const response = await app.inject({
      method: 'GET',
      url: '/api/orgs/demo-uat/data-transforms/Account_Transform?apiVersion=65.0',
      headers: localHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().transform.provenance).toMatchObject({ apiVersion: '65.0' });

    const restPaths = vi.mocked(runner.run).mock.calls
      .map(([args]) => args[3])
      .filter((path): path is string => Boolean(path?.startsWith('/services/data/')));
    expect(restPaths.every((path) => path.includes('/data-transforms/'))).toBe(true);
    expect(restPaths.some((path) => path.includes('/data-spaces'))).toBe(false);
    await app.close();
  });

  it('rejects an invalid transform API version hint before making CLI requests', async () => {
    const config = testConfig('live');
    const runner = liveCliRunner();
    const app = await buildApp({ config, runner });

    const response = await app.inject({
      method: 'GET',
      url: '/api/orgs/demo-uat/data-transforms/Account_Transform?apiVersion=not-a-version',
      headers: localHeaders,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_ARGUMENT');
    expect(vi.mocked(runner.run).mock.calls.some(([args]) => args[0] === 'api')).toBe(false);
    await app.close();
  });

  it('validates alias and transform id before doing any work', async () => {
    const app = await demoApp();
    const badAlias = await app.inject({
      method: 'GET',
      url: '/api/orgs/bad%20alias/data-transforms/Normalize_Contacts',
      headers: localHeaders,
    });
    expect(badAlias.statusCode).toBe(400);
    expect(badAlias.json().error.code).toBe('INVALID_ARGUMENT');

    const badId = await app.inject({
      method: 'GET',
      url: '/api/orgs/demo-uat/data-transforms/bad%21id',
      headers: localHeaders,
    });
    expect(badId.statusCode).toBe(400);
    expect(badId.json().error.code).toBe('INVALID_ARGUMENT');
    await app.close();
  });
});
