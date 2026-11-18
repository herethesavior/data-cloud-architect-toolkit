// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgSummary, SessionInfo } from '@dcat/core';
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
});
