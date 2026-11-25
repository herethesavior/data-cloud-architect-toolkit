import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELAY_OPERATION_TIMEOUT_MS, createApiVersionStatus } from '@dcat/core';
import app from './index.ts';
import { getBridgeUpdateStatus, resetNpmVersionCache } from './relay.ts';
import { createSession } from './session.ts';
import { FakeKV, FakeRelayDO, makeTestEnv } from './test-support.ts';
import type { Env } from './types.ts';

function makeEnv(kv: FakeKV = new FakeKV()): Env {
  return makeTestEnv(kv);
}

interface StartedSession {
  token: string;
  cookie: string;
  headers: Record<string, string>;
}

async function startSession(env: Env): Promise<StartedSession> {
  const response = await app.request('/api/session', {}, env);
  const body = (await response.json()) as { token: string; mode: string };
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0]!;
  return { token: body.token, cookie, headers: { cookie, 'x-dcat-token': body.token } };
}

async function postJson<T>(path: string, body: unknown, headers: Record<string, string>, env: Env): Promise<T> {
  const response = await app.request(path, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, env);
  return (await response.json()) as T;
}

const cli = { installed: true, version: '2.116.6', error: null };
const npmLatestUrl = 'https://registry.npmjs.org/@dcat-toolkit/bridge/latest';

function stubRelayDo(responder: (request: Request) => Promise<Response>): Env['RELAY_DO'] {
  return {
    idFromString: (id) => ({ toString: () => id }),
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({ fetch: (request: Request) => Promise.resolve(responder(request)) }),
  };
}

function relayError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubNpmVersion(version: string, status = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(npmLatestUrl);
    return new Response(JSON.stringify({ version }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function pairedSession(version: string) {
  const session = createSession('live');
  session.relay.agentToken = 'agent-token-1234567890';
  session.relay.agentVersion = version;
  session.relay.lastSeenAt = Date.now();
  return session;
}

beforeEach(() => {
  resetNpmVersionCache();
  stubNpmVersion('0.1.3');
});

afterEach(() => {
  resetNpmVersionCache();
  vi.unstubAllGlobals();
});

describe('hosted session contract', () => {
  it('issues a CSRF token and switches mode only with the token', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    expect(session.token).toMatch(/\S/);
    expect(session.cookie).toContain('dcat_session=');

    const denied = await app.request('/api/mode', {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'demo' }),
    }, env);
    expect(denied.status).toBe(401);

    const allowedResponse = await app.request('/api/mode', {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'demo' }),
    }, env);
    expect(await allowedResponse.json()).toEqual({ mode: 'demo' });
    expect(allowedResponse.headers.get('set-cookie')).toMatch(/Max-Age=2592000/);
  });

  it('serves labelled demo fixtures without a bridge', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    await postJson('/api/mode', { mode: 'demo' }, session.headers, env);

    const orgs = await app.request('/api/orgs', { headers: session.headers }, env);
    expect((await orgs.json() as Array<{ source: string }>)[0]?.source).toBe('demo-fixture');

    const inventory = await app.request('/api/orgs/demo-uat/inventory', { headers: session.headers }, env);
    expect((await inventory.json() as { mode: string }).mode).toBe('demo');
  });

  it('no longer exposes OAuth routes', async () => {
    const env = makeEnv();
    for (const path of ['/api/auth/login', '/api/auth/callback', '/api/auth/status', '/api/auth/logout']) {
      const response = await app.request(path, {}, env);
      expect(response.status).toBe(404);
    }
  });
});

describe('hosted bridge relay', () => {
  it('derives the relay object id from a name inside the namespace', async () => {
    const env = makeEnv();
    const base = new FakeRelayDO();
    const idFromName = vi.fn((name: string) => base.idFromName(name));
    const idFromString = vi.fn((id: string) => base.idFromString(id));
    env.RELAY_DO = { idFromName, idFromString, get: (id) => base.get(id) };

    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);

    expect(paired.agentToken).toMatch(/\S/);
    expect(idFromString).not.toHaveBeenCalled();
    expect(idFromName).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  it('pairs an outbound agent, runs one typed operation, and returns a redacted result', async () => {
    const env = makeEnv();
    const session = await startSession(env);

    const denied = await app.request('/api/relay/requests', {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'org.list' }),
    }, env);
    expect(denied.status).toBe(409);

    const pairing = await postJson<{ code: string; installCommand: string }>('/api/relay/pairing', {}, session.headers, env);
    expect(pairing.code).toMatch(/^[A-Za-z0-9_-]{12,}$/);
    expect(pairing.installCommand).toContain(pairing.code);
    expect(pairing.installCommand).toContain('--relay');

    const compatibility = createApiVersionStatus();
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      version: '0.1.0',
      cli,
      compatibility,
    }, {}, env);
    expect(paired.agentToken).toMatch(/\S/);

    const replay = await app.request('/api/relay/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, cli }),
    }, env);
    expect(replay.status).toBe(400);

    const waiting = await app.request('/api/relay/status', { headers: session.headers }, env);
    expect(await waiting.json()).toMatchObject({ paired: true, relay: 'waiting', cli, compatibility });

    const firstPoll = await postJson<{ tasks: unknown[] }>('/api/relay/poll', {
      agentToken: paired.agentToken,
      cli,
      compatibility,
    }, {}, env);
    expect(firstPoll.tasks).toEqual([]);

    const connected = await app.request('/api/relay/status', { headers: session.headers }, env);
    expect((await connected.json() as { relay: string }).relay).toBe('connected');

    const created = await postJson<{ id: string }>('/api/relay/requests', {
      operation: 'org.list',
    }, session.headers, env);
    expect(created.id).toMatch(/\S/);

    const busy = await app.request('/api/relay/requests', {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'cli.status' }),
    }, env);
    expect(busy.status).toBe(409);

    const taskPoll = await postJson<{ tasks: Array<{ id: string; operation: { operation: string } }> }>('/api/relay/poll', {
      agentToken: paired.agentToken,
      cli,
    }, {}, env);
    expect(taskPoll.tasks).toHaveLength(1);
    expect(taskPoll.tasks[0]).toMatchObject({ id: created.id, operation: { operation: 'org.list' } });

    const running = await app.request(`/api/relay/requests/${created.id}`, { headers: session.headers }, env);
    expect((await running.json() as { status: string }).status).toBe('running');

    const result = [{ alias: 'prod-org', source: 'salesforce-cli' }];
    await postJson('/api/relay/respond', {
      agentToken: paired.agentToken,
      response: { id: created.id, ok: true, result },
    }, {}, env);

    const completed = await app.request(`/api/relay/requests/${created.id}`, { headers: session.headers }, env);
    expect(await completed.json()).toMatchObject({ id: created.id, status: 'completed', result });

    const unpair = await postJson('/api/relay/unpair', {}, session.headers, env);
    expect(unpair).toEqual({ paired: false });

    const staleAgent = await app.request('/api/relay/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentToken: paired.agentToken, cli }),
    }, env);
    expect(staleAgent.status).toBe(401);
  });

  it('keeps agent heartbeats and responses from overwriting browser session state', async () => {
    const kv = new FakeKV();
    const env = makeEnv(kv);
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      version: '0.1.4',
      cli,
    }, {}, env);
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);

    const sessionWritesAfterPair = kv.puts.filter((key) => key.startsWith('session:')).length;
    const created = await postJson<{ id: string }>('/api/relay/requests', {
      operation: 'cli.status',
    }, session.headers, env);
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);
    await postJson('/api/relay/respond', {
      agentToken: paired.agentToken,
      response: { id: created.id, ok: true, result: cli },
    }, {}, env);
    const status = await app.request('/api/relay/status', { headers: session.headers }, env);
    expect((await status.json() as { mode: string }).mode).toBe('live');

    expect(kv.puts.filter((key) => key.startsWith('session:'))).toHaveLength(sessionWritesAfterPair);
    expect(kv.puts.some((key) => key.startsWith('relay:'))).toBe(false);
    expect(kv.puts.some((key) => key.startsWith('agent:'))).toBe(false);
    expect(kv.deletes.some((key) => key.startsWith('relay:'))).toBe(false);
  });

  it('refreshes bridge liveness when a long task posts its result', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);
    const created = await postJson<{ id: string }>('/api/relay/requests', {
      operation: 'cli.status',
    }, session.headers, env);
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);

    const nowSpy = vi.spyOn(Date, 'now');
    const now = Date.now();
    nowSpy.mockReturnValue(now + 61_000);
    try {
      await postJson('/api/relay/respond', {
        agentToken: paired.agentToken,
        response: { id: created.id, ok: true, result: cli },
      }, {}, env);

      // The bridge could not poll while it was busy, but its result is proof of
      // life. The next request must not be rejected as an offline bridge.
      const next = await postJson<{ id: string }>('/api/relay/requests', {
        operation: 'org.list',
      }, session.headers, env);
      expect(next.id).not.toBe(created.id);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('performs zero KV operations while an agent polls', async () => {
    const kv = new FakeKV();
    const env = makeEnv(kv);
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);

    for (let index = 0; index < 50; index += 1) {
      await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);
    }
    await postJson<{ id: string }>('/api/relay/requests', { operation: 'cli.status' }, session.headers, env);

    // Browser routes still read the session once; only agent polls are KV-free.
    const reads = kv.reads;
    const writes = kv.writes;
    const removals = kv.removals;
    for (let index = 0; index < 10; index += 1) {
      await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);
    }

    expect(kv.reads).toBe(reads);
    expect(kv.writes).toBe(writes);
    expect(kv.removals).toBe(removals);
  });

  it('wakes an idle long poll as soon as the browser queues work', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);

    const poll = postJson<{ tasks: Array<{ id: string }> }>('/api/relay/poll', {
      agentToken: paired.agentToken,
      cli,
      wait: true,
    }, {}, env);
    const created = await postJson<{ id: string }>('/api/relay/requests', {
      operation: 'org.list',
    }, session.headers, env);

    expect((await poll).tasks).toMatchObject([{ id: created.id, operation: { operation: 'org.list' } }]);
  });

  it('serves current agent CLI state and cancels relayed requests when the mode changes', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);
    const updatedCli = { installed: true, version: '2.159.7', error: null };
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli: updatedCli }, {}, env);

    const cliStatus = await app.request('/api/cli/status', { headers: session.headers }, env);
    expect(await cliStatus.json()).toEqual(updatedCli);

    const created = await postJson<{ id: string }>('/api/relay/requests', {
      operation: 'cli.status',
    }, session.headers, env);
    await postJson('/api/mode', { mode: 'demo' }, session.headers, env);
    const cancelled = await app.request(`/api/relay/requests/${created.id}`, {
      headers: session.headers,
    }, env);
    expect(await cancelled.json()).toMatchObject({
      id: created.id,
      status: 'failed',
      error: { code: 'CANCELLED' },
    });
  });

  it('keeps a concurrent mode change when a browser queues a request', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);

    const [created, mode] = await Promise.all([
      postJson<{ id: string }>('/api/relay/requests', { operation: 'cli.status' }, session.headers, env),
      postJson<{ mode: string }>('/api/mode', { mode: 'demo' }, session.headers, env),
    ]);

    expect(created.id).toMatch(/\S/);
    expect(mode).toEqual({ mode: 'demo' });
    const status = await app.request('/api/relay/status', { headers: session.headers }, env);
    expect((await status.json() as { mode: string }).mode).toBe('demo');
  });

  it('rejects unsupported operations and mismatched responses without queueing work', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);

    const invalid = await app.request('/api/relay/requests', {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'shell.exec', command: 'whoami' }),
    }, env);
    expect(invalid.status).toBe(400);

    const mismatch = await postJson<{ ok?: boolean }>('/api/relay/respond', {
      agentToken: paired.agentToken,
      response: { id: 'not-a-request', ok: true, result: null },
    }, {}, env);
    expect(mismatch.ok).toBeUndefined();

    const status = await app.request('/api/relay/status', { headers: session.headers }, env);
    expect((await status.json() as { paired: boolean }).paired).toBe(true);
  });

  it('rejects an oversized bridge result before it is retained', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);
    const created = await postJson<{ id: string }>('/api/relay/requests', {
      operation: 'cli.status',
    }, session.headers, env);
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);

    const response = await app.request('/api/relay/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentToken: paired.agentToken,
        response: { id: created.id, ok: true, result: 'x'.repeat(5 * 1024 * 1024) },
      }),
    }, env);
    expect(response.status).toBe(413);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('RESPONSE_TOO_LARGE');

    const failed = await app.request(`/api/relay/requests/${created.id}`, { headers: session.headers }, env);
    expect(await failed.json()).toMatchObject({
      id: created.id,
      status: 'failed',
      error: { code: 'RESPONSE_TOO_LARGE', message: 'The bridge result is too large to relay.' },
    });
  });

  it('delivers an oversized inventory in consecutive chunks instead of failing', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);
    const created = await postJson<{ id: string }>('/api/relay/requests', {
      operation: 'cli.status',
    }, session.headers, env);
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);

    const provenance = {
      orgId: '00D',
      orgAlias: 'test',
      sourceEndpoint: '/ssot/dlos',
      apiVersion: '67.0',
      retrievedAt: '2026-01-01T00:00:00.000Z',
      confidence: 'source',
    };
    const result = {
      sessionId: 'session-1',
      snapshot: {
        org: {
          alias: 'test',
          username: null,
          orgId: '00D',
          instanceUrl: null,
          loginUrl: null,
          environment: 'unknown',
          connectedStatus: null,
          isDefault: true,
          isDevHub: false,
          source: 'salesforce-cli',
        },
        apiVersion: '67.0',
        generatedAt: '2026-01-01T00:00:00.000Z',
        mode: 'live',
        capabilities: [],
        dataSpaces: [],
        dlos: Array.from({ length: 60 }, (_, index) => ({
          apiName: `DLO_${index}__dll`,
          label: 'x'.repeat(120_000),
          fields: [],
          provenance,
        })),
        dmos: [],
        mappings: [],
        dataStreams: [],
        dataTransforms: [],
        relationships: [],
        warnings: [],
        progress: {
          sessionId: 'session-1',
          generation: 'generation-1',
          state: 'complete',
          loaded: 60,
          total: 60,
          families: [],
          message: 'All discovered metadata is loaded.',
        },
      },
    };
    const responded = await app.request('/api/relay/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentToken: paired.agentToken, response: { id: created.id, ok: true, result } }),
    }, env);
    expect(responded.status).toBe(200);

    // A bridge status read must not consume the browser's queued chunks.
    await app.request('/api/relay/status', { headers: session.headers }, env);

    const firstResponse = await app.request(`/api/relay/requests/${created.id}`, { headers: session.headers }, env);
    const first = await firstResponse.json() as {
      status: string;
      chunked?: boolean;
      hasMore?: boolean;
      result?: { snapshot?: { dlos: unknown[] } };
    };
    expect(first).toMatchObject({ status: 'running', chunked: true, hasMore: true });
    expect(first.result?.snapshot?.dlos.length).toBeGreaterThan(0);

    const secondResponse = await app.request(`/api/relay/requests/${created.id}`, { headers: session.headers }, env);
    const second = await secondResponse.json() as {
      status: string;
      chunked?: boolean;
      hasMore?: boolean;
      result?: { snapshot?: { dlos: unknown[] } };
    };
    expect(second).toMatchObject({ status: 'completed', chunked: true, hasMore: false });
    expect((first.result?.snapshot?.dlos.length ?? 0) + (second.result?.snapshot?.dlos.length ?? 0)).toBe(60);
  });

  it('invalidates an unused pairing code when the browser unpairs', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const firstPairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    await postJson('/api/relay/unpair', {}, session.headers, env);

    const stalePair = await app.request('/api/relay/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: firstPairing.code, version: '0.1.6', cli }),
    }, env);
    expect(stalePair.status).toBe(400);
    expect((await stalePair.json() as { error: { code: string } }).error.code).toBe('INVALID_PAIRING_CODE');

    const secondPairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: secondPairing.code,
      version: '0.1.6',
      cli,
    }, {}, env);
    expect(paired.agentToken).toMatch(/\S/);
  });

  it('recovers a session whose bridge pairing predates the Durable Object', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const firstPairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: firstPairing.code,
      cli,
    }, {}, env);

    // Simulate deploying the DO-backed relay over an older paired session.
    env.RELAY_DO = new FakeRelayDO();

    const freshPairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    expect(freshPairing.code).toMatch(/\S/);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: freshPairing.code,
      cli,
    }, {}, env);
    expect(paired.agentToken).toMatch(/\S/);
  });

  it('gives a status poll enough time for a slow CLI org refresh', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);

    let queued: { createdAt: number; expiresAt: number } | null = null;
    env.RELAY_DO = stubRelayDo(async (request) => {
      queued = await request.json() as { createdAt: number; expiresAt: number };
      return new Response(JSON.stringify({ id: 'req-status', status: 'pending' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await postJson('/api/relay/requests', {
      operation: 'inventory.status',
      alias: 'prod-org',
      sessionId: 'session-1',
    }, session.headers, env);

    expect(queued).not.toBeNull();
    expect(queued!.expiresAt - queued!.createdAt).toBe(RELAY_OPERATION_TIMEOUT_MS['inventory.status']);
    expect(RELAY_OPERATION_TIMEOUT_MS['inventory.status']).toBeGreaterThanOrEqual(120_000);
  });

  it('uses the shared transform-id validator for relayed requests', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);

    const invalid = await app.request('/api/relay/requests', {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'transform.get', alias: 'demo-uat', id: 'a..b' }),
    }, env);
    expect(invalid.status).toBe(400);

    const valid = await postJson<{ id: string }>('/api/relay/requests', {
      operation: 'transform.get',
      alias: 'demo-uat',
      id: 'Team~Transform',
    }, session.headers, env);
    expect(valid.id).toMatch(/\S/);
  });

  it('offers pairing repair when a bridge never checks in', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);

    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now + 121_000);
    try {
      const status = await app.request('/api/relay/status', { headers: session.headers }, env);
      expect(await status.json()).toMatchObject({ paired: true, relay: 'stale', canRepairPairing: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits since the last check-in before offering repair for a stale bridge', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);

    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(now + 61_000);
      const stale = await app.request('/api/relay/status', { headers: session.headers }, env);
      expect(await stale.json()).toMatchObject({ paired: true, relay: 'stale', canRepairPairing: false });

      vi.setSystemTime(now + 121_000);
      const repairable = await app.request('/api/relay/status', { headers: session.headers }, env);
      expect(await repairable.json()).toMatchObject({ paired: true, relay: 'stale', canRepairPairing: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows working instead of stale while a claimed task runs', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);
    const created = await postJson<{ id: string }>('/api/relay/requests', {
      operation: 'org.connect',
      alias: 'prod-org',
    }, session.headers, env);
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);

    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now + 61_000);
    try {
      const status = await app.request('/api/relay/status', { headers: session.headers }, env);
      expect(await status.json()).toMatchObject({ paired: true, relay: 'working', working: true });

      // The same operation can still be re-queued: busy state wins over stale.
      const again = await postJson<{ id: string }>('/api/relay/requests', {
        operation: 'org.connect',
        alias: 'prod-org',
      }, session.headers, env);
      expect(again.id).toBe(created.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops an orphaned bridge when the shared session deadline passes', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);

    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now + 31 * 24 * 60 * 60 * 1000);
    try {
      const poll = await app.request('/api/relay/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentToken: paired.agentToken, cli }),
      }, env);
      expect(poll.status).toBe(401);
      expect((await poll.json() as { error: { code: string } }).error.code).toBe('INVALID_AGENT_TOKEN');

      const status = await app.request('/api/relay/status', { headers: session.headers }, env);
      expect(await status.json()).toMatchObject({ paired: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('can replace a pairing when the relay status check is unavailable', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    await postJson('/api/relay/pair', { code: pairing.code, cli }, {}, env);

    const workingRelay = env.RELAY_DO;
    env.RELAY_DO = stubRelayDo(async () => relayError('RELAY_UNAVAILABLE', 'Relay restarting.', 503));

    const status = await app.request('/api/relay/status', { headers: session.headers }, env);
    expect(await status.json()).toMatchObject({
      paired: true,
      relay: 'unavailable',
      working: false,
      canRepairPairing: true,
    });

    const fresh = await postJson<{ code: string; installCommand: string }>(
      '/api/relay/pairing', {}, session.headers, env,
    );
    expect(fresh.code).toMatch(/\S/);
    expect(fresh.installCommand).toContain(fresh.code);

    // A new pairing must work once the relay is reachable again.
    env.RELAY_DO = workingRelay;
    const repaired = await postJson<{ agentToken: string }>('/api/relay/pair', { code: fresh.code, cli }, {}, env);
    expect(repaired.agentToken).toMatch(/\S/);
  });

  it('clears a pairing when the relay explicitly reports it as unpaired', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    await postJson('/api/relay/pair', { code: pairing.code, cli }, {}, env);

    env.RELAY_DO = stubRelayDo(async () => new Response(JSON.stringify({ paired: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const status = await app.request('/api/relay/status', { headers: session.headers }, env);
    expect(await status.json()).toMatchObject({ paired: false, relay: 'waiting' });
  });

  it('reports a reset pairing distinctly instead of telling the user to set up a bridge', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    await postJson('/api/relay/pair', { code: pairing.code, cli }, {}, env);

    env.RELAY_DO = stubRelayDo(async () => relayError(
      'INVALID_AGENT_TOKEN',
      'The bridge pairing is no longer active.',
      401,
    ));

    const queued = await app.request('/api/relay/requests', {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'org.list' }),
    }, env);
    expect(queued.status).toBe(409);
    expect((await queued.json() as { error: { code: string } }).error.code).toBe('BRIDGE_PAIRING_RESET');

    const polled = await app.request('/api/relay/requests/request-1234', { headers: session.headers }, env);
    expect(polled.status).toBe(409);
    expect((await polled.json() as { error: { code: string } }).error.code).toBe('BRIDGE_PAIRING_RESET');
  });

  it('invalidates the pairing code when relay initialization fails', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const base = new FakeRelayDO();
    env.RELAY_DO = {
      idFromString: (id) => base.idFromString(id),
      idFromName: (name) => base.idFromName(name),
      get: (id) => {
        const stub = base.get(id);
        return {
          fetch: async (request: Request) => new URL(request.url).pathname === '/init'
            ? relayError('RELAY_UNAVAILABLE', 'Relay unreachable.', 500)
            : stub.fetch(request),
        };
      },
    };

    const failed = await app.request('/api/relay/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, cli }),
    }, env);
    expect(failed.status).toBe(502);
    expect((await failed.json() as { error: { code: string } }).error.code).toBe('BRIDGE_RELAY_UNAVAILABLE');

    const replay = await app.request('/api/relay/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, cli }),
    }, env);
    expect(replay.status).toBe(400);
    const status = await app.request('/api/relay/status', { headers: session.headers }, env);
    expect(await status.json()).toMatchObject({ paired: false });
  });

  it('cancels a queued request and exposes the flag to the bridge', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);
    const created = await postJson<{ id: string }>('/api/relay/requests', {
      operation: 'cli.status',
    }, session.headers, env);
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);

    const cancelled = await postJson<{ cancelled: boolean }>('/api/relay/cancel', {
      requestId: created.id,
    }, session.headers, env);
    expect(cancelled.cancelled).toBe(true);

    const state = await app.request(`/api/relay/requests/${created.id}`, { headers: session.headers }, env);
    expect(await state.json()).toMatchObject({ status: 'failed', error: { code: 'CANCELLED' } });
    const bridgeCheck = await postJson<{ cancelled: boolean }>('/api/relay/cancelled', {
      agentToken: paired.agentToken,
      requestId: created.id,
    }, {}, env);
    expect(bridgeCheck.cancelled).toBe(true);
  });

  it('frees a cancelled request that the bridge has not claimed yet', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);
    const created = await postJson<{ id: string }>('/api/relay/requests', {
      operation: 'cli.status',
    }, session.headers, env);

    const cancelled = await postJson<{ cancelled: boolean }>('/api/relay/cancel', {
      requestId: created.id,
    }, session.headers, env);
    expect(cancelled.cancelled).toBe(true);

    const next = await postJson<{ id: string }>('/api/relay/requests', {
      operation: 'org.list',
    }, session.headers, env);
    expect(next.id).not.toBe(created.id);

    const poll = await postJson<{ tasks: Array<{ id: string }> }>('/api/relay/poll', {
      agentToken: paired.agentToken,
      cli,
    }, {}, env);
    expect(poll.tasks.map((task) => task.id)).toEqual([next.id]);
  });

  it('holds a browser status poll until the bridge responds', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      cli,
    }, {}, env);
    const created = await postJson<{ id: string }>('/api/relay/requests', {
      operation: 'cli.status',
    }, session.headers, env);
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);

    const pending = app.request(`/api/relay/requests/${created.id}?wait=1`, { headers: session.headers }, env);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await postJson('/api/relay/respond', {
      agentToken: paired.agentToken,
      response: { id: created.id, ok: true, result: cli },
    }, {}, env);

    expect(await (await pending).json()).toMatchObject({ id: created.id, status: 'completed', result: cli });
  });

  it('answers the liveness probe without any KV or relay state', async () => {
    const kv = new FakeKV();
    const env = makeEnv(kv);

    const before = Date.now();
    const response = await app.request('/api/health', {}, env);
    const after = Date.now();
    const body = await response.json() as { status: string; time: string };

    expect(body.status).toBe('ok');
    expect(Date.parse(body.time)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(body.time)).toBeLessThanOrEqual(after);
    expect(kv.reads).toBe(0);
    expect(kv.writes).toBe(0);
  });

  it('surfaces npm update availability on relay status', async () => {
    const env = makeEnv();
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    await postJson('/api/relay/pair', {
      code: pairing.code,
      version: '0.1.4',
      cli,
    }, {}, env);
    stubNpmVersion('0.2.0');

    const response = await app.request('/api/relay/status', { headers: session.headers }, env);
    expect(await response.json()).toMatchObject({
      paired: true,
      agentVersion: '0.1.4',
      latestVersion: '0.2.0',
      updateAvailable: true,
      selfUpdateSupported: true,
    });
  });
});

describe('bridge npm update status', () => {
  it('reports no update when the paired agent matches npm latest', async () => {
    const fetchMock = stubNpmVersion('0.1.4');

    const status = await getBridgeUpdateStatus(pairedSession('0.1.4'), 'https://dcat.example');

    expect(status).toMatchObject({
      paired: true,
      agentVersion: '0.1.4',
      latestVersion: '0.1.4',
      updateAvailable: false,
      selfUpdateSupported: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe(npmLatestUrl);
  });

  it('reports a newer npm release and reuses the one-hour cache', async () => {
    const fetchMock = stubNpmVersion('0.2.0');
    const session = pairedSession('0.1.4');

    const first = await getBridgeUpdateStatus(session, 'https://dcat.example');
    const second = await getBridgeUpdateStatus(session, 'https://dcat.example');

    expect(first).toMatchObject({
      latestVersion: '0.2.0',
      updateAvailable: true,
      selfUpdateSupported: true,
    });
    expect(second.updateAvailable).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('shares one in-flight registry check across concurrent status requests', async () => {
    let releaseFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);
    const session = pairedSession('0.1.4');

    const first = getBridgeUpdateStatus(session, 'https://dcat.example');
    const second = getBridgeUpdateStatus(session, 'https://dcat.example');

    expect(fetchMock).toHaveBeenCalledOnce();
    releaseFetch(new Response(JSON.stringify({ version: '0.2.0' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ latestVersion: '0.2.0', updateAvailable: true }),
      expect.objectContaining({ latestVersion: '0.2.0', updateAvailable: true }),
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('compares numeric version components instead of strings', async () => {
    stubNpmVersion('0.1.10');

    await expect(getBridgeUpdateStatus(pairedSession('0.1.4'), 'https://dcat.example'))
      .resolves.toMatchObject({ updateAvailable: true });
  });

  it('marks published bridges below the self-update minimum as manual-only', async () => {
    stubNpmVersion('0.2.0');

    await expect(getBridgeUpdateStatus(pairedSession('0.1.3'), 'https://dcat.example'))
      .resolves.toMatchObject({
        agentVersion: '0.1.3',
        updateAvailable: true,
        selfUpdateSupported: false,
      });
  });

  it('does not check npm until a bridge reports its version', async () => {
    const fetchMock = stubNpmVersion('0.2.0');

    await expect(getBridgeUpdateStatus(createSession('live'), 'https://dcat.example'))
      .resolves.toMatchObject({
        paired: false,
        agentVersion: null,
        latestVersion: null,
        updateAvailable: false,
        selfUpdateSupported: false,
      });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the update unavailable when the registry check fails', async () => {
    stubNpmVersion('0.2.0', 503);

    await expect(getBridgeUpdateStatus(pairedSession('0.1.4'), 'https://dcat.example'))
      .resolves.toMatchObject({
        latestVersion: null,
        updateAvailable: false,
        selfUpdateSupported: true,
      });
  });
});
