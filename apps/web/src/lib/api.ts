import { inferOrgEnvironment } from '@dcat/core';
import type {
  BridgeStatus,
  CliStatus,
  ConnectorHealth,
  InventorySnapshot,
  OrgSummary,
  RelayOperation,
  RelayPairing,
  RelayRequestState,
  ResourceFamily,
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
  timeoutMs?: number;
}

const SESSION_TIMEOUT_MS = 15_000;
const RELAY_POLL_TIMEOUT_MS = 10_000;

interface TimedSignal {
  signal?: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
}

/** Combine caller cancellation with a hard deadline so no request can hang forever. */
function createTimedSignal(signal: AbortSignal | undefined, timeoutMs?: number): TimedSignal {
  if (!signal && !timeoutMs) return { signal: undefined, didTimeout: () => false, cleanup: () => {} };

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', onAbort, { once: true });

  const timer = timeoutMs === undefined ? undefined : window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timer !== undefined) window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** Older bridges return `unknown`; upgrade them from the same safe URL metadata. */
function normalizeOrg(org: OrgSummary): OrgSummary {
  const environment = inferOrgEnvironment(org);
  return environment === org.environment ? org : { ...org, environment };
}

function normalizeOrgs(orgs: OrgSummary[]): OrgSummary[] {
  return orgs.map(normalizeOrg);
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const timed = createTimedSignal(options.signal, options.timeoutMs);
  try {
    const response = await fetch(path, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.token ? { 'x-dcat-token': options.token } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: timed.signal,
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
  } catch (error) {
    if (timed.didTimeout()) throw new ApiError('TIMEOUT', 'The request took too long. Try again.');
    if (options.signal?.aborted) throw new ApiError('ABORTED', 'Request cancelled.');
    throw error;
  } finally {
    timed.cleanup();
  }
}

let cachedSession: Promise<SessionInfo> | null = null;

export function getSession(): Promise<SessionInfo> {
  cachedSession ??= request<SessionInfo>('/api/session', { timeoutMs: SESSION_TIMEOUT_MS }).catch((error: unknown) => {
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

const PROGRESS_POLL_MS = 750;

interface InventorySessionResult {
  sessionId: string;
  snapshot: InventorySnapshot;
}

export interface InventoryRequestOptions {
  force?: boolean;
  signal?: AbortSignal;
  sessionId?: string;
  resume?: boolean;
  family?: ResourceFamily;
  /** Called for every partial snapshot so the UI can render rows immediately. */
  onSnapshot?: (snapshot: InventorySnapshot) => void;
}

const OPERATION_TIMEOUT_MS: Record<RelayOperation['operation'], number> = {
  'cli.status': 30_000,
  'org.list': 120_000,
  'org.connect': 6 * 60_000,
  // Keep the browser deadline aligned with the Worker so a timed-out retry
  // cannot hit BRIDGE_BUSY while the original request is still running.
  'inventory.get': 60_000,
  'inventory.start': 60_000,
  'inventory.status': 30_000,
  'transform.get': 60_000,
  'mode.set': 30_000,
  'bridge.update': 5 * 60_000,
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
  if (signal?.aborted) throw new ApiError('ABORTED', 'Request cancelled.');

  // A cancelled browser fetch does not cancel the bridge task. The caller is
  // released immediately, but the queued execution keeps draining the request
  // so the next operation cannot hit BRIDGE_BUSY while the old one is active.
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ApiError('ABORTED', 'Request cancelled.'));
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  const execute = async (): Promise<T> => {
    if (signal?.aborted) throw new ApiError('ABORTED', 'Request cancelled.');
    if (isHosted() && await hostedUsesFixtures() && operation.operation !== 'cli.status') {
      throw new ApiError('INVALID_ARGUMENT', 'Switch to live mode to use the local bridge.');
    }
    const session = await getSession();
    const deadline = Date.now() + OPERATION_TIMEOUT_MS[operation.operation];
    const createRequest = () => request<{ id: string }>('/api/relay/requests', {
      method: 'POST',
      token: session.token,
      body: operation,
      timeoutMs: RELAY_POLL_TIMEOUT_MS,
    });

    let created: { id: string };
    try {
      created = await createRequest();
    } catch (error) {
      // A slow creation response is recoverable: the Worker reuses the id of an
      // identical active request, so retrying cannot enqueue a duplicate.
      if (!(error instanceof ApiError && error.code === 'TIMEOUT') || Date.now() >= deadline) throw error;
      created = await createRequest();
    }

    while (Date.now() < deadline) {
      let state: RelayRequestState;
      try {
        state = await request<RelayRequestState>(`/api/relay/requests/${encodeURIComponent(created.id)}`, {
          token: session.token,
          timeoutMs: RELAY_POLL_TIMEOUT_MS,
        });
      } catch (error) {
        // A slow status poll is recoverable until the operation deadline. Keep
        // polling so a bridge that answers late still completes the user action.
        if (error instanceof ApiError && error.code === 'TIMEOUT' && Date.now() < deadline) {
          await wait(Math.min(1_200, Math.max(0, deadline - Date.now())));
          continue;
        }
        throw error;
      }
      if (state.status === 'completed') return state.result as T;
      if (state.status === 'failed' || state.status === 'expired') {
        throw new ApiError(state.error?.code ?? 'RELAY_FAILED', state.error?.message ?? 'The local bridge request failed.');
      }
      await wait(Math.min(1_200, Math.max(0, deadline - Date.now())));
    }

    throw new ApiError('RELAY_TIMEOUT', 'The local bridge did not answer in time. Check that it is still running.');
  };

  const result = relayChain.then(execute);
  relayChain = result.catch(() => undefined);
  try {
    return await Promise.race([result, cancellation]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

function snapshotWithOrg(snapshot: InventorySnapshot): InventorySnapshot {
  return { ...snapshot, org: normalizeOrg(snapshot.org) };
}

async function startInventorySession(
  alias: string,
  options: InventoryRequestOptions,
  hostedLive: boolean,
): Promise<InventorySessionResult> {
  const operation: RelayOperation = {
    operation: 'inventory.start',
    alias,
    sessionId: options.sessionId,
    refresh: options.force,
  };
  if (hostedLive) return relayCall<InventorySessionResult>(operation, options.signal);
  return requestWithToken<InventorySessionResult>(`/api/orgs/${encodeURIComponent(alias)}/inventory/session`, {
    method: 'POST',
    body: { sessionId: options.sessionId, refresh: options.force },
    signal: options.signal,
    timeoutMs: OPERATION_TIMEOUT_MS['inventory.start'],
  });
}

async function readInventorySession(
  alias: string,
  sessionId: string,
  options: InventoryRequestOptions,
  hostedLive: boolean,
): Promise<InventorySessionResult> {
  const operation: RelayOperation = {
    operation: 'inventory.status',
    alias,
    sessionId,
    resume: options.resume,
    family: options.family,
  };
  if (hostedLive) return relayCall<InventorySessionResult>(operation, options.signal);
  return requestWithToken<InventorySessionResult>(
    `/api/orgs/${encodeURIComponent(alias)}/inventory/session/${encodeURIComponent(sessionId)}`,
    {
      method: 'POST',
      body: { resume: options.resume, family: options.family },
      signal: options.signal,
      timeoutMs: OPERATION_TIMEOUT_MS['inventory.status'],
    },
  );
}

async function legacyInventory(
  alias: string,
  options: InventoryRequestOptions,
  hostedLive: boolean,
): Promise<InventorySnapshot> {
  if (hostedLive) {
    return relayCall<InventorySnapshot>({ operation: 'inventory.get', alias, refresh: options.force }, options.signal);
  }
  const path = `/api/orgs/${encodeURIComponent(alias)}/inventory`;
  return options.force
    ? requestWithToken<InventorySnapshot>(`${path}?refresh=1`, {
        signal: options.signal,
        timeoutMs: OPERATION_TIMEOUT_MS['inventory.get'],
      })
    : request<InventorySnapshot>(path, {
        signal: options.signal,
        timeoutMs: OPERATION_TIMEOUT_MS['inventory.get'],
      });
}

/** Start once, then poll the connector's accumulated snapshot until it settles. */
async function progressiveInventory(
  alias: string,
  options: InventoryRequestOptions,
  hostedLive: boolean,
): Promise<InventorySnapshot> {
  let result = options.sessionId
    ? await readInventorySession(alias, options.sessionId, options, hostedLive)
    : await startInventorySession(alias, options, hostedLive);
  let snapshot = snapshotWithOrg(result.snapshot);
  options.onSnapshot?.(snapshot);

  // A resume clears failed families once. Repeating it on every poll would hide
  // a second failure and turn a bounded retry into an endless retry loop.
  const pollOptions: InventoryRequestOptions = { ...options, resume: false };
  while (snapshot.progress && snapshot.progress.state !== 'complete') {
    if (snapshot.progress.state === 'failed' && !options.resume) break;
    await wait(PROGRESS_POLL_MS, options.signal);
    result = await readInventorySession(alias, result.sessionId, pollOptions, hostedLive);
    snapshot = snapshotWithOrg(result.snapshot);
    options.onSnapshot?.(snapshot);
    if (snapshot.progress?.state === 'failed') break;
  }
  return snapshot;
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
    agentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    selfUpdateSupported: false,
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
    if (isHosted() && !await hostedUsesFixtures()) return normalizeOrgs(await relayCall<OrgSummary[]>({ operation: 'org.list' }));
    return normalizeOrgs(await request<OrgSummary[]>('/api/orgs'));
  },
  org: async (alias: string): Promise<OrgSummary> => {
    if (isHosted() && !await hostedUsesFixtures()) {
      const orgs = normalizeOrgs(await relayCall<OrgSummary[]>({ operation: 'org.list' }));
      const found = orgs.find((entry) => entry.alias === alias);
      if (!found) throw new ApiError('ORG_NOT_FOUND', 'Org alias is not authenticated.');
      return found;
    }
    return normalizeOrg(await request<OrgSummary>(`/api/orgs/${encodeURIComponent(alias)}`));
  },
  inventory: async (alias: string, options: InventoryRequestOptions = {}): Promise<InventorySnapshot> => {
    const hostedLive = isHosted() && !await hostedUsesFixtures();
    try {
      return await progressiveInventory(alias, options, hostedLive);
    } catch (error) {
      // An expired session is normal after a long-lived tab. Start a fresh one
      // instead of silently dropping to an all-at-once legacy discovery.
      if (error instanceof ApiError && error.code === 'SESSION_EXPIRED' && options.sessionId) {
        return progressiveInventory(alias, { ...options, sessionId: undefined }, hostedLive);
      }
      if (error instanceof ApiError && error.code === 'SESSION_EXPIRED' && !options.sessionId) {
        return progressiveInventory(alias, { ...options, sessionId: undefined, force: true }, hostedLive);
      }
      // An older local bridge or connector may not expose the progressive
      // operations yet. Preserve the previous all-at-once behavior in that case.
      const unsupported = error instanceof ApiError
        && (error.code === 'INVALID_ARGUMENT' || error.code === 'REQUEST_FAILED' || error.code === 'NOT_FOUND');
      if (!unsupported) throw error;
      const snapshot = snapshotWithOrg(await legacyInventory(alias, options, hostedLive));
      options.onSnapshot?.(snapshot);
      return snapshot;
    }
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
    if (isHosted() && !await hostedUsesFixtures()) return normalizeOrgs(await relayCall<OrgSummary[]>({ operation: 'org.list' }));
    return normalizeOrgs(await postJson<OrgSummary[]>('/api/orgs/refresh', {}));
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
      const connected = await relayCall<OrgSummary>({
        operation: 'org.connect',
        alias,
        ...(instanceUrl ? { instanceUrl } : {}),
        ...(browser ? { browser } : {}),
      });
      return normalizeOrg({ ...connected, instanceUrl: connected.instanceUrl ?? instanceUrl ?? null });
    }
    const connected = await postJson<OrgSummary>('/api/orgs/connect', {
      alias,
      ...(instanceUrl ? { instanceUrl } : {}),
      ...(browser ? { browser } : {}),
    });
    return normalizeOrg({ ...connected, instanceUrl: connected.instanceUrl ?? instanceUrl ?? null });
  },
  bridgeStatus,
  updateBridge: (): Promise<{ updated: true; restarting: true; message: string }> =>
    relayCall({ operation: 'bridge.update' }),
  relayPairing: (): Promise<RelayPairing> => requestWithToken<RelayPairing>('/api/relay/pairing', { method: 'POST' }),
  unpairBridge: (): Promise<{ paired: false }> => postJson<{ paired: false }>('/api/relay/unpair', {}),
};
