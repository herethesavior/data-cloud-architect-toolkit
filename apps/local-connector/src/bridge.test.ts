import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliStatus, InventorySnapshot, OrgSummary, RelayTask, TransformBundle } from '@dcat/core';
import type { ProcessRunner, RunOptions } from '@dcat/salesforce-cli';
import { CliError } from '@dcat/salesforce-cli';
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
  transformRunHistoryJson,
  transformScheduleJson,
  versionsJson,
} from '@dcat/test-fixtures';
import {
  executeRelayOperation,
  FetchRelayHttp,
  RelayAuthError,
  RelayTerminalError,
  runBridge,
  type RelayHttp,
} from './bridge.ts';
import { loadConfig } from './config.ts';
import { loadApiVersionSelection } from './api-compatibility-store.ts';
import { createAppState, type AppState, type DiscoverySessionRecord } from './state.ts';

const restBodies: Record<string, string> = { '/services/data/': versionsJson };
for (const version of ['65.0', '67.0']) {
  const base = `/services/data/v${version}/ssot`;
  Object.assign(restBodies, {
    [`${base}/data-spaces`]: dataSpacesJson,
    [`${base}/data-lake-objects`]: dlosJson,
    [`${base}/data-model-objects?limit=100&offset=0`]: dmosJson,
    [`${base}/data-model-object-mappings`]: mappingsJson,
    [`${base}/data-streams`]: dataStreamsJson,
    [`${base}/connectors`]: connectorCatalogJson,
    [`${base}/connections?connectorType=SalesforceDotCom`]: connectorConnectionsJson,
    [`${base}/data-transforms`]: dataTransformsJson,
    [`${base}/data-transforms/Account_Transform`]: transformDetailJson,
    [`${base}/data-transforms/Account_Transform/run-history`]: transformRunHistoryJson,
    [`${base}/data-transforms/Account_Transform/schedule`]: transformScheduleJson,
  });
}

function restBody(path: string): string | undefined {
  return restBodies[path]
    ?? (/^\/services\/data\/v(?:65|67)\.0\/ssot\/data-model-object-mappings\?/.test(path)
      && path.includes('dmoDeveloperName=')
      ? mappingsJson
      : path.includes('/relationships?')
        ? ''
        : undefined);
}

function createRunner(loginResult?: { stdout: string; stderr: string; exitCode: number }): ProcessRunner {
  return {
    run: vi.fn(async (args: readonly string[], _options?: RunOptions) => {
      if (args[0] === '--version') return { stdout: cliVersionOutput, stderr: '', exitCode: 0 };
      if (args[0] === 'org' && args[1] === 'list') return { stdout: orgListJson, stderr: '', exitCode: 0 };
      if (args[0] === 'org' && args[1] === 'login' && args[2] === 'web') {
        return loginResult ?? { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'api' && args[1] === 'request' && args[2] === 'rest') {
        const body = restBody(args[3] ?? '');
        return body === undefined
          ? { stdout: '', stderr: `Unexpected REST path: ${args[3] ?? ''}`, exitCode: 1 }
          : { stdout: body, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `Unexpected CLI command: ${args.join(' ')}`, exitCode: 1 };
    }),
  };
}

const testCompatibilityPath = join(tmpdir(), 'dcat-bridge-test-compatibility.json');

beforeEach(() => rmSync(testCompatibilityPath, { force: true }));
afterEach(() => rmSync(testCompatibilityPath, { force: true }));

function createState(runner = createRunner()): AppState {
  const config = {
    ...loadConfig({ DCAT_API_COMPATIBILITY_PATH: testCompatibilityPath }, []),
    mode: 'live' as const,
    sessionToken: 'bridge-test-token',
  };
  return createAppState(config, runner);
}

async function operation<T>(state: AppState, value: unknown): Promise<T> {
  return (await executeRelayOperation(state, value)) as T;
}

function task(operation: RelayTask['operation']): RelayTask {
  return { id: 'task-1', operation, createdAt: '2026-11-18T00:00:00.000Z' };
}

class FakeRelayHttp implements RelayHttp {
  readonly calls: Array<{ path: string; body: unknown }> = [];

  constructor(
    private readonly tasks: RelayTask[],
    private readonly controller: AbortController,
  ) {}

  async post<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ path, body });
    if (path === '/api/relay/pair') return { agentToken: 'agent-token' } as T;
    if (path === '/api/relay/cancelled') return { cancelled: false } as T;
    if (path === '/api/relay/poll') return { status: 'ok', tasks: this.tasks.splice(0) } as T;
    if (path === '/api/relay/respond') {
      this.controller.abort();
      return { ok: true } as T;
    }
    throw new Error(`Unexpected relay path: ${path}`);
  }
}

function respondBody(http: FakeRelayHttp) {
  const call = http.calls.find((entry) => entry.path === '/api/relay/respond');
  return call?.body as { agentToken: string; response: { id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } } };
}

describe('executeRelayOperation', () => {
  it('runs each allowlisted operation with fixed CLI arguments', async () => {
    const runner = createRunner();
    const state = createState(runner);

    await expect(operation<CliStatus>(state, { operation: 'cli.status' })).resolves.toMatchObject({
      installed: true,
      version: '2.116.6',
    });
    await expect(operation<OrgSummary[]>(state, { operation: 'org.list' })).resolves.toMatchObject([
      { alias: 'demo-uat', source: 'salesforce-cli' },
    ]);

    const connected = await operation<OrgSummary>(state, {
      operation: 'org.connect',
      alias: 'demo-uat',
      instanceUrl: 'https://demo--uat.sandbox.my.salesforce.com',
    });
    expect(connected.alias).toBe('demo-uat');
    expect(runner.run).toHaveBeenCalledWith(
      ['org', 'login', 'web', '--alias', 'demo-uat', '--set-default', '--instance-url', 'https://demo--uat.sandbox.my.salesforce.com'],
      expect.objectContaining({ timeoutMs: 5 * 60_000 }),
    );
    expect(runner.run).toHaveBeenCalledWith(
      ['org', 'list', '--skip-connection-status', '--json'],
      { timeoutMs: 15_000 },
    );
    expect(connected.connectedStatus).toBe('Connected');

    const inventory = await operation<InventorySnapshot>(state, { operation: 'inventory.get', alias: 'demo-uat' });
    expect(inventory).toMatchObject({ mode: 'live', apiVersion: '67.0' });
    expect(inventory.warnings).toEqual([]);

    const bundle = await operation<TransformBundle>(state, {
      operation: 'transform.get',
      alias: 'demo-uat',
      id: 'Account_Transform',
    });
    expect(bundle.sections).toEqual({ detail: 'available', runHistory: 'available', schedule: 'available' });

    await expect(operation<{ mode: string }>(state, { operation: 'mode.set', mode: 'demo' })).resolves.toEqual({ mode: 'demo' });
    expect(state.mode).toBe('demo');
  });

  it('drops org-scoped caches and sessions when an alias is reconnected', async () => {
    const state = createState();
    state.inventoryCache = {
      at: Date.now(),
      alias: 'demo-uat',
      inventory: { mode: 'live' } as InventorySnapshot,
    };
    state.discoverySessions.set('old-session', {
      id: 'old-session',
      alias: 'demo-uat',
      controller: new AbortController(),
    } as unknown as DiscoverySessionRecord);
    state.discoveryByAlias.set('demo-uat', 'old-session');

    await operation(state, { operation: 'org.connect', alias: 'demo-uat' });

    expect(state.orgsCache).toBeNull();
    expect(state.inventoryCache).toBeNull();
    expect(state.discoverySessions.size).toBe(0);
    expect(state.discoveryByAlias.size).toBe(0);
  });

  it('refuses a caller-supplied session id that belongs to another org', async () => {
    const state = createState();
    await expect(operation(state, {
      operation: 'inventory.start',
      alias: 'demo-uat',
      sessionId: 'shared',
    })).resolves.toMatchObject({ sessionId: 'shared' });

    await expect(operation(state, {
      operation: 'inventory.start',
      alias: 'demo-alt',
      sessionId: 'shared',
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // The rejected request must not abort the valid session it tried to borrow.
    await expect(operation(state, {
      operation: 'inventory.status',
      alias: 'demo-uat',
      sessionId: 'shared',
    })).resolves.toMatchObject({ sessionId: 'shared' });

    await operation(state, { operation: 'mode.set', mode: 'demo' });
  });

  it('changes the bridge-local API version through a typed relay operation', async () => {
    const state = createState();
    const saved = await operation(state, {
      operation: 'compatibility.set',
      selection: { mode: 'latest' },
    });
    expect(saved).toMatchObject({ selection: { mode: 'latest' }, recommended: '67.0' });
    expect(loadApiVersionSelection(testCompatibilityPath)).toEqual({ mode: 'latest' });

    const inventory = await operation<InventorySnapshot>(state, {
      operation: 'inventory.get',
      alias: 'demo-uat',
    });
    expect(inventory.apiVersion).toBe('65.0');
  });

  it('runs a bridge update only through the injected CLI hook', async () => {
    const state = createState();
    const onUpdate = vi.fn(async () => ({ updated: true, restarting: true, message: 'Bridge updated and restarting.' }));

    await expect(executeRelayOperation(state, { operation: 'bridge.update' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(executeRelayOperation(state, { operation: 'bridge.update' }, onUpdate)).resolves.toMatchObject({
      restarting: true,
    });
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('rejects unsupported operations, aliases, and login endpoints before spawning a command', async () => {
    const runner = createRunner();
    const state = createState(runner);

    await expect(executeRelayOperation(state, { operation: 'shell.exec', command: 'whoami' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: 'Unsupported bridge operation.' });
    await expect(executeRelayOperation(state, { operation: 'org.connect', alias: 'bad alias' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(executeRelayOperation(state, {
      operation: 'org.connect',
      alias: 'demo-uat',
      instanceUrl: 'https://evil.example',
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe('runBridge', () => {
  it('pairs an outbound agent, executes one task, and posts a redacted-free result', async () => {
    const controller = new AbortController();
    const http = new FakeRelayHttp([task({ operation: 'cli.status' })], controller);
    const state = createState();
    const onPaired = vi.fn();
    const logger = vi.fn();

    await runBridge({
      relayUrl: 'https://dcat.example',
      code: 'PAIR12345678',
      state,
      http,
      signal: controller.signal,
      pollIntervalMs: 1,
      logger,
      onPaired,
    });

    expect(onPaired).toHaveBeenCalledWith('agent-token');
    expect(http.calls.map((call) => call.path)).toEqual([
      '/api/relay/pair',
      '/api/relay/poll',
      '/api/relay/cancelled',
      '/api/relay/respond',
    ]);
    expect(respondBody(http)).toMatchObject({
      agentToken: 'agent-token',
      response: { id: 'task-1', ok: true, result: { installed: true, version: '2.116.6' } },
    });
    expect(JSON.stringify(http.calls)).not.toMatch(/password|accessToken|refreshToken|sfdxAuthUrl/i);
    expect(http.calls.find((call) => call.path === '/api/relay/poll')?.body).toMatchObject({
      version: state.config.version,
      compatibility: state.compatibility,
      wait: true,
    });
  });

  it('retries a dropped result POST so completed work is not lost', async () => {
    const controller = new AbortController();
    const relay = new FakeRelayHttp([task({ operation: 'cli.status' })], controller);
    let respondCalls = 0;
    const http: RelayHttp = {
      async post<T>(path: string, body: unknown): Promise<T> {
        if (path === '/api/relay/respond') {
          respondCalls += 1;
          if (respondCalls === 1) throw new Error('Connection reset.');
        }
        return relay.post<T>(path, body);
      },
    };

    vi.useFakeTimers();
    try {
      const running = runBridge({
        relayUrl: 'https://dcat.example',
        token: 'agent-token',
        state: createState(),
        http,
        signal: controller.signal,
        pollIntervalMs: 1,
        logger: () => {},
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await running;
    } finally {
      vi.useRealTimers();
    }

    expect(respondCalls).toBe(2);
    expect(respondBody(relay).response).toMatchObject({
      id: 'task-1',
      ok: true,
      result: { installed: true, version: '2.116.6' },
    });
  });

  it('responds to a bridge update and stops the old agent after the restart handoff', async () => {
    const controller = new AbortController();
    const http = new FakeRelayHttp([task({ operation: 'bridge.update' })], controller);
    const state = createState();
    const logger = vi.fn();
    const onUpdate = vi.fn(async () => ({ updated: true, restarting: true, message: 'Bridge updated and restarting.' }));

    await runBridge({
      relayUrl: 'https://dcat.example',
      token: 'agent-token',
      state,
      http,
      signal: controller.signal,
      pollIntervalMs: 1,
      logger,
      onUpdate,
    });

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(respondBody(http).response).toMatchObject({ ok: true, result: { restarting: true } });
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Bridge updated'));
    expect(http.calls.filter((call) => call.path === '/api/relay/respond')).toHaveLength(1);
  });

  it('posts a redacted failure when an allowlisted command fails with credential-shaped output', async () => {
    const secret = `Bearer ${'sensitive-value-1234567890'}`;
    const runner = createRunner({ stdout: '', stderr: `Login failed: ${secret}`, exitCode: 1 });
    const state = createState(runner);
    const controller = new AbortController();
    const http = new FakeRelayHttp([task({ operation: 'org.connect', alias: 'demo-uat' })], controller);

    await runBridge({
      relayUrl: 'https://dcat.example',
      token: 'agent-token',
      state,
      http,
      signal: controller.signal,
      pollIntervalMs: 1,
      logger: () => {},
    });

    const response = respondBody(http).response;
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('COMMAND_FAILED');
    expect(response.error?.message).toContain('[REDACTED]');
    expect(JSON.stringify(http.calls)).not.toContain('sensitive-value-1234567890');
  });

  it('requires a pairing code for a new bridge', async () => {
    const state = createState();
    await expect(runBridge({ relayUrl: 'https://dcat.example', state })).rejects.toBeInstanceOf(CliError);
  });

  it('preserves a relay authentication failure from an HTTP response', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'INVALID_AGENT_TOKEN', message: 'The site reset this bridge pairing.' },
    }), { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const http = new FetchRelayHttp('https://dcat.example', fetchFn);

    await expect(http.post('/api/relay/poll', { agentToken: 'revoked-token' }))
      .rejects.toBeInstanceOf(RelayAuthError);
  });

  it('treats an oversized relay result as terminal instead of retryable', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'RESPONSE_TOO_LARGE', message: 'The bridge result is too large to relay.' },
    }), { status: 413, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const http = new FetchRelayHttp('https://dcat.example', fetchFn);

    const call = http.post('/api/relay/respond', {
      agentToken: 'agent-token',
      response: { id: 'task-1', ok: true, result: 'x'.repeat(16) },
    });
    await expect(call).rejects.toBeInstanceOf(RelayTerminalError);
    await expect(call).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('skips a task that the site cancelled before execution', async () => {
    const controller = new AbortController();
    const respond = vi.fn();
    const http: RelayHttp = {
      async post<T>(path: string): Promise<T> {
        if (path === '/api/relay/poll') return { status: 'ok', tasks: [task({ operation: 'cli.status' })] } as T;
        if (path === '/api/relay/cancelled') {
          controller.abort();
          return { cancelled: true } as T;
        }
        if (path === '/api/relay/respond') return respond() as T;
        throw new Error(`Unexpected relay path: ${path}`);
      },
    };
    const logger = vi.fn();

    await runBridge({
      relayUrl: 'https://dcat.example',
      token: 'agent-token',
      state: createState(),
      http,
      signal: controller.signal,
      pollIntervalMs: 1,
      logger,
    });

    expect(respond).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('cancelled request'));
  });

  it('stops polling when the relay reports an unpaired bridge', async () => {
    const controller = new AbortController();
    let calls = 0;
    const http: RelayHttp = {
      async post<T>() {
        calls += 1;
        if (calls === 2) controller.abort();
        return { status: 'unpaired', tasks: [] } as T;
      },
    };
    const logger = vi.fn();

    await runBridge({
      relayUrl: 'https://dcat.example',
      token: 'revoked-token',
      state: createState(),
      http,
      signal: controller.signal,
      pollIntervalMs: 1,
      logger,
    });

    expect(calls).toBe(1);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Bridge stopped'));
  });

  it('stops polling when the site invalidates the bridge pairing', async () => {
    const controller = new AbortController();
    let calls = 0;
    const http: RelayHttp = {
      async post() {
        calls += 1;
        if (calls === 2) controller.abort();
        throw new RelayAuthError('The site reset this bridge pairing. Run setup again.');
      },
    };
    const logger = vi.fn();

    await runBridge({
      relayUrl: 'https://dcat.example',
      token: 'revoked-token',
      state: createState(),
      http,
      signal: controller.signal,
      pollIntervalMs: 1,
      logger,
    });

    expect(calls).toBe(1);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Bridge stopped'));
    expect(logger).not.toHaveBeenCalledWith(expect.stringContaining('Retrying'));
  });
});
