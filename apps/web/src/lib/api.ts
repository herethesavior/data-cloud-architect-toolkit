import type {
  BridgeStatus,
  CliStatus,
  ConnectorHealth,
  InventorySnapshot,
  OrgSummary,
  RelayOperation,
  RelayPairing,
  RelayRequestState,
  SessionInfo,
  TransformBundle,
} from '@dcat/core';
import { isHosted } from './hosted.ts';

export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

interface ErrorPayload {
  error?: { code?: string; message?: string };
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { 'x-dcat-token': options.token } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    credentials: 'same-origin',
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ErrorPayload | null;
    throw new ApiError(
      payload?.error?.code ?? 'REQUEST_FAILED',
      payload?.error?.message ?? `Request failed with status ${response.status}.`,
    );
  }

  return (await response.json()) as T;
}

let cachedSession: Promise<SessionInfo> | null = null;

export function getSession(): Promise<SessionInfo> {
  cachedSession ??= request<SessionInfo>('/api/session').catch((error: unknown) => {
    // A failed request must not poison the cache: "Try again" has to work.
    cachedSession = null;
    throw error;
  });
  return cachedSession;
}

export function setCachedSession(session: SessionInfo): void {
  cachedSession = Promise.resolve(session);
}

export function clearCachedSession(): void {
  cachedSession = null;
}

/** Token-authenticated call that retries once if the connector restarted. */
async function requestWithToken<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const session = await getSession();
  const withToken: RequestOptions = { ...options, token: session.token };
  try {
    return await request<T>(path, withToken);
  } catch (error) {
    // The local connector rotates its token on every run. A restart while the UI
    // is open invalidates the cached one, so refresh once and retry the call.
    if (!(error instanceof ApiError) || error.code !== 'INVALID_SESSION_TOKEN') throw error;
    clearCachedSession();
    const refreshed = await getSession();
    return request<T>(path, { ...withToken, token: refreshed.token });
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  return requestWithToken<T>(path, { method: 'POST', body });
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new ApiError('ABORTED', 'Request cancelled.'));
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new ApiError('ABORTED', 'Request cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const OPERATION_TIMEOUT_MS: Record<RelayOperation['operation'], number> = {
  'cli.status': 30_000,
  'org.list': 120_000,
  'org.connect': 6 * 60_000,
  'inventory.get': 120_000,
  'transform.get': 120_000,
  'mode.set': 30_000,
};

// The Worker relay accepts one operation at a time. React Query can fire an
// org-list refresh while an inventory load or org login is still in flight, so
// serialize calls here instead of surfacing BRIDGE_BUSY for ordinary navigation.
let relayChain: Promise<unknown> = Promise.resolve();

async function hostedUsesFixtures(): Promise<boolean> {
  return (await getSession()).mode === 'demo';
}

/** Send one typed operation to the paired local bridge and wait for its result. */
async function relayCall<T>(operation: RelayOperation, signal?: AbortSignal): Promise<T> {
  const execute = async (): Promise<T> => {
    if (signal?.aborted) throw new ApiError('ABORTED', 'Request cancelled.');
    if (isHosted() && await hostedUsesFixtures() && operation.operation !== 'cli.status') {
      throw new ApiError('INVALID_ARGUMENT', 'Switch to live mode to use the local bridge.');
    }
    const session = await getSession();
    const created = await request<{ id: string }>('/api/relay/requests', {
      method: 'POST',
      token: session.token,
      body: operation,
      signal,
    });
    const deadline = Date.now() + OPERATION_TIMEOUT_MS[operation.operation];

    while (Date.now() < deadline) {
      const state = await request<RelayRequestState>(`/api/relay/requests/${encodeURIComponent(created.id)}`, {
        token: session.token,
        signal,
      });
      if (state.status === 'completed') return state.result as T;
      if (state.status === 'failed' || state.status === 'expired') {
        throw new ApiError(state.error?.code ?? 'RELAY_FAILED', state.error?.message ?? 'The local bridge request failed.');
      }
      await wait(1200, signal);
    }

    throw new ApiError('RELAY_TIMEOUT', 'The local bridge did not answer in time. Check that it is still running.');
  };

  const result = relayChain.then(execute);
  relayChain = result.catch(() => undefined);
  return result;
}

async function bridgeStatus(): Promise<BridgeStatus> {
  if (isHosted()) return request<BridgeStatus>('/api/relay/status');
  const [health, session] = await Promise.all([api.health(), getSession()]);
  return {
    paired: true,
    mode: session.mode,
    version: health.version,
    cli: health.cli,
    lastSeenAt: health.time,
    relay: 'connected',
    pairing: null,
  };
}

export const api = {
  health: async (): Promise<ConnectorHealth> => {
    if (isHosted()) {
      const status = await bridgeStatus();
      return {
        status: status.mode === 'demo' || status.relay === 'connected' ? 'ok' : 'degraded',
        mode: status.mode,
        version: status.version,
        time: status.lastSeenAt ?? new Date().toISOString(),
        cli: status.cli,
      };
    }
    return request<ConnectorHealth>('/api/health');
  },
  orgs: async (): Promise<OrgSummary[]> => {
    if (isHosted() && !await hostedUsesFixtures()) return relayCall({ operation: 'org.list' });
    return request<OrgSummary[]>('/api/orgs');
  },
  org: async (alias: string): Promise<OrgSummary> => {
    if (isHosted() && !await hostedUsesFixtures()) {
      const orgs = await relayCall<OrgSummary[]>({ operation: 'org.list' });
      const found = orgs.find((entry) => entry.alias === alias);
      if (!found) throw new ApiError('ORG_NOT_FOUND', 'Org alias is not authenticated.');
      return found;
    }
    return request<OrgSummary>(`/api/orgs/${encodeURIComponent(alias)}`);
  },
  inventory: async (alias: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<InventorySnapshot> => {
    if (isHosted() && !await hostedUsesFixtures()) {
      return relayCall<InventorySnapshot>({ operation: 'inventory.get', alias, refresh: options.force }, options.signal);
    }
    const path = `/api/orgs/${encodeURIComponent(alias)}/inventory`;
    // A forced refresh bypasses the server cache and is token-protected.
    return options.force
      ? requestWithToken<InventorySnapshot>(`${path}?refresh=1`, { signal: options.signal })
      : request<InventorySnapshot>(path, { signal: options.signal });
  },
  transformBundle: async (alias: string, id: string, options: { signal?: AbortSignal } = {}): Promise<TransformBundle> => {
    if (isHosted() && !await hostedUsesFixtures()) {
      return relayCall<TransformBundle>({ operation: 'transform.get', alias, id }, options.signal);
    }
    return request<TransformBundle>(
      `/api/orgs/${encodeURIComponent(alias)}/data-transforms/${encodeURIComponent(id)}`,
      { signal: options.signal },
    );
  },
  refreshOrgs: async (): Promise<OrgSummary[]> => {
    if (isHosted() && !await hostedUsesFixtures()) return relayCall({ operation: 'org.list' });
    return postJson<OrgSummary[]>('/api/orgs/refresh', {});
  },
  refreshCli: async (): Promise<CliStatus> => {
    if (isHosted()) {
      const status = await bridgeStatus();
      return status.cli;
    }
    return postJson<CliStatus>('/api/cli/refresh', {});
  },
  setMode: async (mode: 'live' | 'demo'): Promise<{ mode: 'live' | 'demo' }> => {
    const result = await postJson<{ mode: 'live' | 'demo' }>('/api/mode', { mode });
    clearCachedSession();
    return result;
  },
  connectOrg: async (
    alias: string,
    instanceUrl?: string,
    browser?: 'chrome' | 'edge' | 'firefox',
  ): Promise<OrgSummary> => {
    if (isHosted() && await hostedUsesFixtures()) {
      throw new ApiError('INVALID_ARGUMENT', 'Switch to live mode before connecting an org.');
    }
    if (isHosted()) {
      return relayCall<OrgSummary>({
        operation: 'org.connect',
        alias,
        ...(instanceUrl ? { instanceUrl } : {}),
        ...(browser ? { browser } : {}),
      });
    }
    return postJson<OrgSummary>('/api/orgs/connect', {
      alias,
      ...(instanceUrl ? { instanceUrl } : {}),
      ...(browser ? { browser } : {}),
    });
  },
  bridgeStatus,
  relayPairing: (): Promise<RelayPairing> => requestWithToken<RelayPairing>('/api/relay/pairing', { method: 'POST' }),
  unpairBridge: (): Promise<{ paired: false }> => postJson<{ paired: false }>('/api/relay/unpair', {}),
};
