// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgSummary, SessionInfo } from '@dcat/core';
import { demoInventory } from '@dcat/test-fixtures';
import { api, clearCachedSession, getSession } from './api.ts';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const session: SessionInfo = { token: 'old-token', mode: 'demo' };

describe('web API session handling', () => {
  beforeEach(() => {
    clearCachedSession();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('does not cache a failed session request', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('connector offline'))
      .mockResolvedValueOnce(jsonResponse(session));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getSession()).rejects.toThrow('connector offline');
    await expect(getSession()).resolves.toMatchObject({ token: 'old-token' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses a fixed, encoded path for read-only transform bundles', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ transform: null }));
    vi.stubGlobal('fetch', fetchMock);

    await api.transformBundle('prod org', 'Transform/One', { signal: new AbortController().signal });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(path).toBe('/api/orgs/prod%20org/data-transforms/Transform%2FOne');
    expect(options.method ?? 'GET').toBe('GET');
    expect((options.headers as Record<string, string>)['x-dcat-token']).toBeUndefined();
  });

  it('refreshes the token once after a rejected mutation', async () => {
    const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string> | undefined;
      if (path === '/api/session') {
        const token = fetchMock.mock.calls.filter(([url]) => url === '/api/session').length === 1
          ? 'old-token'
          : 'new-token';
        return jsonResponse({ ...session, token });
      }
      if (headers?.['x-dcat-token'] === 'old-token') {
        return jsonResponse({ error: { code: 'INVALID_SESSION_TOKEN', message: 'Stale token.' } }, 401);
      }
      return jsonResponse({ mode: 'live' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.setMode('live')).resolves.toEqual({ mode: 'live' });
    const postHeaders = fetchMock.mock.calls
      .filter(([url, options]) => url === '/api/mode' && options?.method === 'POST')
      .map(([, options]) => (options?.headers as Record<string, string>)['x-dcat-token']);
    expect(postHeaders).toEqual(['old-token', 'new-token']);
  });

  it('reads hosted bridge status from the relay endpoint without a token', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    const status = {
      paired: false,
      mode: 'live',
      version: '0.1.0',
      cli: { installed: false, version: null, error: null },
      lastSeenAt: null,
      relay: 'waiting',
      pairing: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.bridgeStatus()).resolves.toEqual(status);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(path).toBe('/api/relay/status');
    expect((options?.headers as Record<string, string>)['x-dcat-token']).toBeUndefined();
  });

  it('uses the current time for hosted health checks', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    const lastSeenAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/relay/status') {
        return jsonResponse({
          paired: true,
          mode: 'live',
          version: '0.1.0',
          cli: { installed: true, version: '2.116.6', error: null },
          lastSeenAt,
          relay: 'stale',
          pairing: null,
          agentVersion: '0.1.6',
          latestVersion: '0.1.6',
          updateAvailable: false,
          selfUpdateSupported: true,
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const before = Date.now();
    const health = await api.health();
    const after = Date.now();

    expect(Date.parse(health.time)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(health.time)).toBeLessThanOrEqual(after);
    expect(health.time).not.toBe(lastSeenAt);
  });

  it('serializes hosted relay calls instead of creating overlapping bridge requests', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/session') return jsonResponse({ ...session, mode: 'live' });
      if (path === '/api/relay/requests') {
        const count = fetchMock.mock.calls.filter(([url]) => url === '/api/relay/requests').length;
        return jsonResponse({ id: `req-${count}` });
      }
      if (path.startsWith('/api/relay/requests/')) {
        return jsonResponse({ id: path.split('/').pop(), status: 'completed', result: [] });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([api.orgs(), api.connectOrg('new-org')]);

    const relayPaths = fetchMock.mock.calls
      .map(([url]) => url as string)
      .filter((url) => url.startsWith('/api/relay'));
    expect(relayPaths).toEqual([
      '/api/relay/requests',
      '/api/relay/requests/req-1',
      '/api/relay/requests',
      '/api/relay/requests/req-2',
    ]);
  });

  it('keeps hosted relay serialization after a cancelled refresh', async () => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_HOSTED', 'true');
    let relayPosts = 0;
    let firstDone = false;
    const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === '/api/session') return jsonResponse({ ...session, mode: 'live' });
      if (path === '/api/relay/requests' && options?.method === 'POST') {
        relayPosts += 1;
        return jsonResponse({ id: `req-${relayPosts}` });
      }
      if (path.startsWith('/api/relay/requests/')) {
        const id = path.split('/').pop();
        return jsonResponse({
          id,
          status: id === 'req-1' && !firstDone ? 'running' : 'completed',
          result: [],
          error: null,
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const cancelled = api.inventory('prod-org', { force: true, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'ABORTED' });

    const next = api.orgs();
    await vi.advanceTimersByTimeAsync(0);
    expect(relayPosts, 'the abandoned bridge request still owns the relay').toBe(1);

    firstDone = true;
    await vi.advanceTimersByTimeAsync(1_300);
    await expect(next).resolves.toEqual([]);
    expect(relayPosts).toBe(2);
  });

  it('upgrades unknown live org environments from CLI URL metadata', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    const org: OrgSummary = {
      alias: 'uat-org',
      username: 'uat@example.invalid',
      orgId: null,
      instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
      loginUrl: null,
      environment: 'unknown',
      connectedStatus: 'Connected',
      isDefault: true,
      isDevHub: false,
      source: 'salesforce-cli',
    };
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/session') return jsonResponse({ ...session, mode: 'live' });
      if (path === '/api/relay/requests') return jsonResponse({ id: 'req-env' });
      if (path === '/api/relay/requests/req-env') return jsonResponse({ status: 'completed', result: [org] });
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.orgs()).resolves.toMatchObject([{ alias: 'uat-org', environment: 'sandbox' }]);
  });

  it('creates a pairing with the session token and no credential fields', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    const pairing = {
      code: 'ABC123DEF456',
      expiresAt: '2026-11-18T01:00:00.000Z',
      installCommand: 'npx -y @dcat-toolkit/bridge@latest setup --relay https://dcat.example --code ABC123DEF456',
    };
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/session') return jsonResponse(session);
      return jsonResponse(pairing);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.relayPairing()).resolves.toEqual(pairing);

    const pairingCall = fetchMock.mock.calls.find(([url]) => url === '/api/relay/pairing')!;
    const options = (pairingCall as unknown as [string, RequestInit | undefined])[1];
    expect(options?.method).toBe('POST');
    expect((options?.headers as Record<string, string>)['x-dcat-token']).toBe('old-token');
    expect(options?.body).toBeUndefined();
  });

  it('bounds a hanging inventory refresh with a hard timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((path: string, options?: RequestInit) => {
      if (path === '/api/session') return Promise.resolve(jsonResponse(session));
      return new Promise((_resolve, reject) => {
        if (options?.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = api.inventory('prod-org', { force: true });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it('aborts an inventory refresh when the caller cancels', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((path: string, options?: RequestInit) => {
      if (path === '/api/session') return Promise.resolve(jsonResponse(session));
      return new Promise((_resolve, reject) => {
        if (options?.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = api.inventory('prod-org', { force: true, signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('starts a fresh progressive session after an expired-session response', async () => {
    let starts = 0;
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/session') return jsonResponse(session);
      if (path === '/api/orgs/prod-org/inventory/session') {
        starts += 1;
        if (starts === 1) {
          return jsonResponse({ error: { code: 'SESSION_EXPIRED', message: 'Session expired.' } }, 502);
        }
        return jsonResponse({ sessionId: 'fresh-session', snapshot: demoInventory });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.inventory('prod-org')).resolves.toMatchObject({ apiVersion: demoInventory.apiVersion });
    expect(starts).toBe(2);
  });

  it('falls back for an explicitly unsupported local inventory operation', async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/session') return jsonResponse(session);
      if (path === '/api/orgs/prod-org/inventory/session') {
        return jsonResponse({ error: { code: 'INVALID_ARGUMENT', message: 'Unsupported bridge operation.' } }, 400);
      }
      if (path === '/api/orgs/prod-org/inventory') return jsonResponse(demoInventory);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.inventory('prod-org')).resolves.toMatchObject({ apiVersion: demoInventory.apiVersion });
    expect(fetchMock).toHaveBeenCalledWith('/api/orgs/prod-org/inventory', expect.any(Object));
  });

  it('does not hide a failed local discovery request behind the legacy inventory route', async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/session') return jsonResponse(session);
      if (path === '/api/orgs/prod-org/inventory/session') {
        return jsonResponse({ error: { code: 'REQUEST_FAILED', message: 'CLI probe failed.' } }, 502);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.inventory('prod-org')).rejects.toMatchObject({ code: 'REQUEST_FAILED' });
    expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain('/api/orgs/prod-org/inventory');
  });

  it('does not treat a hosted relay mismatch as a legacy capability gap', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/session') return jsonResponse({ ...session, mode: 'live' });
      if (path === '/api/relay/requests') return jsonResponse({ id: 'req-1' });
      if (path === '/api/relay/requests/req-1') {
        return jsonResponse({
          id: 'req-1',
          status: 'failed',
          error: { code: 'NOT_FOUND', message: 'The bridge response does not match a pending request.' },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.inventory('prod-org')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/relay/requests')).toHaveLength(1);
  });

  it('applies resume only to the first status poll', async () => {
    vi.useFakeTimers();
    const running = {
      ...demoInventory,
      progress: {
        sessionId: 'session-1',
        generation: 'gen-1',
        state: 'running' as const,
        loaded: 1,
        total: null,
        families: [],
        message: 'Loading metadata in small batches.',
      },
    };
    const complete = {
      ...running,
      progress: {
        ...running.progress,
        state: 'complete' as const,
        message: 'All discovered metadata is loaded.',
      },
    };
    let statusCalls = 0;
    const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === '/api/session') return jsonResponse(session);
      if (path === '/api/orgs/prod-org/inventory/session/session-1') {
        statusCalls += 1;
        return jsonResponse({ sessionId: 'session-1', snapshot: statusCalls === 1 ? running : complete });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = api.inventory('prod-org', { sessionId: 'session-1', resume: true, family: 'dlos' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(750);

    await expect(pending).resolves.toMatchObject({ progress: { state: 'complete' } });
    const statusBodies = fetchMock.mock.calls
      .filter(([path]) => path === '/api/orgs/prod-org/inventory/session/session-1')
      .map(([, options]) => JSON.parse(String(options?.body ?? '{}')));
    expect(statusBodies).toEqual([
      { resume: true, family: 'dlos' },
      { resume: false, family: 'dlos' },
    ]);
  });
});
