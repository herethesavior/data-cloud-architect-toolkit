import { inferOrgEnvironment, RELAY_OPERATION_TIMEOUT_MS } from '@dcat/core';
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

async function postJson<T>(
  path: string,
  body: unknown,
  options: Pick<RequestOptions, 'signal' | 'timeoutMs'> = {},
): Promise<T> {
  return requestWithToken<T>(path, { method: 'POST', body, ...options });
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
  const session = await getSession();
  let token = session.token;

  /**
   * Discovery polls for minutes. A session replaced while it runs invalidates
   * the token captured at the start, so every request refreshes it once instead
   * of failing an otherwise valid operation at the next poll.
   */
  const relayRequest = async <T>(path: string, options: RequestOptions): Promise<T> => {
    try {
      return await request<T>(path, { ...options, token });
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'INVALID_SESSION_TOKEN') throw error;
      clearCachedSession();
      token = (await getSession()).token;
      return request<T>(path, { ...options, token });
    }
  };

  // Abort releases the UI, then best-effort cancels the queued relay request so
  // a reload cannot hit BRIDGE_BUSY behind an abandoned operation.
  let activeRequestId: string | null = null;
  let cancelSent = false;
  const cancelRelayRequest = (id: string) => {
    if (cancelSent) return;
    cancelSent = true;
    // Long-running operations refresh the token mid-flight. Cancelling with the
    // original token would leave the bridge operation running until its deadline.
    const send = (cancelToken: string) => request('/api/relay/cancel', {
      method: 'POST',
      token: cancelToken,
      body: { requestId: id },
      timeoutMs: SESSION_TIMEOUT_MS,
    });
    void send(token).catch(async (error) => {
      if (!(error instanceof ApiError) || error.code !== 'INVALID_SESSION_TOKEN') return;
      clearCachedSession();
      token = (await getSession()).token;
      await send(token);
    }).catch(() => undefined);
  };
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      if (activeRequestId) cancelRelayRequest(activeRequestId);
      reject(new ApiError('ABORTED', 'Request cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  const execute = async (): Promise<T> => {
    if (signal?.aborted) throw new ApiError('ABORTED', 'Request cancelled.');
    if (isHosted() && await hostedUsesFixtures() && operation.operation !== 'cli.status') {
      throw new ApiError('INVALID_ARGUMENT', 'Switch to live mode to use the local bridge.');
    }
    const deadline = Date.now() + RELAY_OPERATION_TIMEOUT_MS[operation.operation];
    const createRequest = () => relayRequest<{ id: string }>('/api/relay/requests', {
      method: 'POST',
      body: operation,
      signal,
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
    activeRequestId = created.id;
    if (signal?.aborted) {
      cancelRelayRequest(created.id);
      throw new ApiError('ABORTED', 'Request cancelled.');
    }

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new ApiError('ABORTED', 'Request cancelled.');
      let state: RelayRequestState;
      try {
        // The Durable Object holds this read until the request settles, so
        // progressive discovery costs one session read per status poll.
        state = await relayRequest<RelayRequestState>(`/api/relay/requests/${encodeURIComponent(created.id)}?wait=1`, {
          signal,
          timeoutMs: RELAY_POLL_TIMEOUT_MS,
        });
      } catch (error) {
        if (signal?.aborted) throw new ApiError('ABORTED', 'Request cancelled.');
        // A slow status poll is recoverable until the operation deadline. Keep
        // polling so a bridge that answers late still completes the user action.
        if (error instanceof ApiError && error.code === 'TIMEOUT' && Date.now() < deadline) {
          await wait(Math.min(1_200, Math.max(0, deadline - Date.now())), signal);
          continue;
        }
        throw error;
      }
      if (signal?.aborted) throw new ApiError('ABORTED', 'Request cancelled.');
      if (state.status === 'completed') return state.result as T;
      if (state.status === 'failed' || state.status === 'expired') {
        throw new ApiError(state.error?.code ?? 'RELAY_FAILED', state.error?.message ?? 'The local bridge request failed.');
      }
      await wait(Math.min(1_200, Math.max(0, deadline - Date.now())), signal);
    }

    throw new ApiError('RELAY_TIMEOUT', 'The local bridge did not answer in time. Check that it is still running.');
  };

  const result = relayChain.then(execute);
  relayChain = result.catch(() => undefined);
  try {
    return await Promise.race([result, cancellation]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    activeRequestId = null;
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
    timeoutMs: RELAY_OPERATION_TIMEOUT_MS['inventory.start'],
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
      timeoutMs: RELAY_OPERATION_TIMEOUT_MS['inventory.status'],
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
        timeoutMs: RELAY_OPERATION_TIMEOUT_MS['inventory.get'],
      })
    : request<InventorySnapshot>(path, {
        signal: options.signal,
        timeoutMs: RELAY_OPERATION_TIMEOUT_MS['inventory.get'],
      });
}

/** Only explicit capability gaps may fall back; transport and relay failures must surface. */
function isUnsupportedProgressiveError(error: unknown, hostedLive: boolean): boolean {
  if (!(error instanceof ApiError)) return false;
  const message = error.message.toLowerCase();
  if (error.code === 'INVALID_ARGUMENT') return message.includes('unsupported bridge operation');
  if (!hostedLive && error.code === 'NOT_FOUND') return message.includes('unknown api route');
  return false;
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
  // A terminal `partial` snapshot has no active cursors; polling it again can
  // never add rows and would keep the shared spinner alive indefinitely.
  while (snapshot.progress?.state === 'running') {
    await wait(PROGRESS_POLL_MS, options.signal);
    result = await readInventorySession(alias, result.sessionId, pollOptions, hostedLive);
    snapshot = snapshotWithOrg(result.snapshot);
    options.onSnapshot?.(snapshot);
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
    working: false,
    canRepairPairing: false,
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
        time: new Date().toISOString(),
        cli: status.cli,
      };
    }
    return request<ConnectorHealth>('/api/health');
  },
  orgs: async (options: { signal?: AbortSignal } = {}): Promise<OrgSummary[]> => {
    if (isHosted() && !await hostedUsesFixtures()) {
      return normalizeOrgs(await relayCall<OrgSummary[]>({ operation: 'org.list' }, options.signal));
    }
    return normalizeOrgs(await request<OrgSummary[]>('/api/orgs', { signal: options.signal }));
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
      // operations yet. Preserve the previous all-at-once behavior only for that
      // explicit capability gap, never for a failed request or relay mismatch.
      if (!isUnsupportedProgressiveError(error, hostedLive)) throw error;
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
      { signal: options.signal, timeoutMs: RELAY_OPERATION_TIMEOUT_MS['transform.get'] },
    );
  },
  refreshOrgs: async (options: { signal?: AbortSignal } = {}): Promise<OrgSummary[]> => {
    if (isHosted() && !await hostedUsesFixtures()) {
      return normalizeOrgs(await relayCall<OrgSummary[]>({ operation: 'org.list' }, options.signal));
    }
    return normalizeOrgs(await postJson<OrgSummary[]>('/api/orgs/refresh', {}, { signal: options.signal }));
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
    options: { signal?: AbortSignal } = {},
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
      }, options.signal);
      return normalizeOrg({ ...connected, instanceUrl: connected.instanceUrl ?? instanceUrl ?? null });
    }
    const connected = await postJson<OrgSummary>('/api/orgs/connect', {
      alias,
      ...(instanceUrl ? { instanceUrl } : {}),
      ...(browser ? { browser } : {}),
    }, { signal: options.signal });
    return normalizeOrg({ ...connected, instanceUrl: connected.instanceUrl ?? instanceUrl ?? null });
  },
  bridgeStatus,
  relayPairing: (): Promise<RelayPairing> => requestWithToken<RelayPairing>('/api/relay/pairing', { method: 'POST' }),
  unpairBridge: (): Promise<{ paired: false }> => postJson<{ paired: false }>('/api/relay/unpair', {}),
};
