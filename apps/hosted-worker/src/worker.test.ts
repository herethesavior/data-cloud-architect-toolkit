import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from './index.ts';
import { getBridgeUpdateStatus, resetNpmVersionCache } from './relay.ts';
import { createSession } from './session.ts';
import type { Env, KVNamespaceLike } from './types.ts';

class FakeKV implements KVNamespaceLike {
  readonly store = new Map<string, string>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.puts.push(key);
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.store.delete(key);
  }
}

function makeEnv(kv: FakeKV = new FakeKV()): Env {
  return { DCAT_SESSIONS: kv };
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

    const allowed = await postJson<{ mode: string }>('/api/mode', { mode: 'demo' }, session.headers, env);
    expect(allowed).toEqual({ mode: 'demo' });
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

    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      version: '0.1.0',
      cli,
    }, {}, env);
    expect(paired.agentToken).toMatch(/\S/);

    const replay = await app.request('/api/relay/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, cli }),
    }, env);
    expect(replay.status).toBe(400);

    const waiting = await app.request('/api/relay/status', { headers: session.headers }, env);
    expect(await waiting.json()).toMatchObject({ paired: true, relay: 'waiting', cli });

    const firstPoll = await postJson<{ tasks: unknown[] }>('/api/relay/poll', {
      agentToken: paired.agentToken,
      cli,
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
    expect(kv.puts).toContain(`relay:request:${session.cookie.slice('dcat_session='.length).split(';')[0]}`);
    expect(kv.puts).toContain(`relay:claim:${created.id}`);
    expect(kv.puts).toContain(`relay:response:${created.id}`);
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
    const health = await app.request('/api/health', { headers: session.headers }, env);
    expect((await health.json() as { cli: { version: string } }).cli.version).toBe('2.159.7');

    const created = await postJson<{ id: string }>('/api/relay/requests', {
      operation: 'cli.status',
    }, session.headers, env);
    await postJson('/api/mode', { mode: 'demo' }, session.headers, env);
    const cancelled = await app.request(`/api/relay/requests/${created.id}`, {
      headers: session.headers,
    }, env);
    expect(cancelled.status).toBe(404);
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

  it('reports the health check time instead of the bridge heartbeat', async () => {
    const kv = new FakeKV();
    const env = makeEnv(kv);
    const session = await startSession(env);
    const pairing = await postJson<{ code: string }>('/api/relay/pairing', {}, session.headers, env);
    const paired = await postJson<{ agentToken: string }>('/api/relay/pair', {
      code: pairing.code,
      version: '0.1.6',
      cli,
    }, {}, env);
    await postJson('/api/relay/poll', { agentToken: paired.agentToken, cli }, {}, env);

    const sessionId = session.cookie.slice('dcat_session='.length).split(';')[0]!;
    const oldHeartbeat = Date.now() - 60 * 60_000;
    await kv.put(`relay:agent:${sessionId}`, JSON.stringify({
      lastSeenAt: oldHeartbeat,
      agentVersion: '0.1.6',
      cli,
    }));

    const before = Date.now();
    const response = await app.request('/api/health', { headers: session.headers }, env);
    const after = Date.now();
    const body = await response.json() as { time: string };

    expect(Date.parse(body.time)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(body.time)).toBeLessThanOrEqual(after);
    expect(Date.parse(body.time)).toBeGreaterThan(oldHeartbeat);
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
