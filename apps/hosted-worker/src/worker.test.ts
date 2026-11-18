import { afterEach, describe, expect, it, vi } from 'vitest';
import app from './index.ts';
import type { Env, KVNamespaceLike } from './types.ts';

class FakeKV implements KVNamespaceLike {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
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

afterEach(() => {
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
});
