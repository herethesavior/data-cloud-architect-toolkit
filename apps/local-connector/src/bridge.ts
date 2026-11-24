import type { CliStatus, OrgSummary, RelayOperation, RelayRequestState, RelayResponse, RelayTask } from '@dcat/core';
import { relayOperationSchema } from '@dcat/core';
import { fetchTransformBundle, validateTransformId } from '@dcat/data360-api';
import { CliError, safeErrorMessage, validateAlias } from '@dcat/salesforce-cli';
import { clearDiscoverySessions, getDiscoverySession, startDiscoverySession } from './discovery-sessions.ts';
import { refreshCliStatus } from './state.ts';
import type { AppState } from './state.ts';
import { invalidateOrgState, resolveInventory, resolveOrgs } from './routes/orgs.ts';

export interface RelayHttp {
  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T>;
}

/** A missing pairing cannot recover without a new setup code, so the agent must stop. */
export class RelayAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayAuthError';
  }
}

export class FetchRelayHttp implements RelayHttp {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await response.json().catch(() => null)) as
      | T
      | { error?: { code?: string; message?: string } }
      | null;
    if (!response.ok) {
      const error = payload as { error?: { code?: string; message?: string } } | null;
      const message = error?.error?.message ?? `Relay request failed with status ${response.status}.`;
      if (response.status === 401 || error?.error?.code === 'INVALID_AGENT_TOKEN') {
        throw new RelayAuthError(message);
      }
      throw new CliError('COMMAND_FAILED', message);
    }
    return payload as T;
  }
}

interface PairResult {
  agentToken: string;
}

interface PollResult {
  tasks: RelayTask[];
  status: 'ok' | 'unpaired';
}

export interface BridgeOptions {
  relayUrl: string;
  state: AppState;
  code?: string;
  token?: string;
  pollIntervalMs?: number;
  http?: RelayHttp;
  signal?: AbortSignal;
  logger?: (message: string) => void;
  onPaired?: (token: string) => void | Promise<void>;
  /** Supplied by the bridge CLI: installs the latest npm package and restarts the agent. */
  onUpdate?: () => Promise<unknown>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CliError('COMMAND_FAILED', 'Bridge stopped.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CliError('COMMAND_FAILED', 'Bridge stopped.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorResponse(id: string, error: unknown): RelayResponse {
  const code = error instanceof CliError ? error.code : 'REQUEST_FAILED';
  return { id, ok: false, error: { code, message: safeErrorMessage(error) } };
}

async function findOrg(state: AppState, alias: string): Promise<OrgSummary> {
  const safeAlias = validateAlias(alias);
  const orgs = await resolveOrgs(state);
  const org = orgs.find((entry) => entry.alias === safeAlias);
  if (!org) throw new CliError('INVALID_ARGUMENT', 'Select an authenticated org first.');
  return org;
}

/** Execute one allowlisted operation. The operation shape is always re-validated. */
export async function executeRelayOperation(
  state: AppState,
  operation: unknown,
  onUpdate?: () => Promise<unknown>,
): Promise<unknown> {
  const parsed = relayOperationSchema.safeParse(operation);
  if (!parsed.success) throw new CliError('INVALID_ARGUMENT', 'Unsupported bridge operation.');
  const task = parsed.data;

  switch (task.operation) {
    case 'cli.status':
      await refreshCliStatus(state);
      return state.cliStatus satisfies CliStatus;
    case 'org.list':
      return resolveOrgs(state, true);
    case 'org.connect': {
      const alias = validateAlias(task.alias);
      await state.cli.loginOrg(alias, task.instanceUrl, task.browser);
      invalidateOrgState(state);
      // `loginOrg` can finish as soon as the CLI writes the authorization, so
      // use the fast local listing to answer instead of a slow network probe.
      const local = await state.cli.listOrgsLocal().catch(() => []);
      const connected = local.find((entry) => entry.alias === alias);
      if (connected) return { ...connected, connectedStatus: 'Connected' } satisfies OrgSummary;
      const orgs = await resolveOrgs(state, true);
      return orgs.find((entry) => entry.alias === alias) ?? {
        alias,
        username: null,
        orgId: null,
        environment: 'unknown',
        connectedStatus: 'Connected',
        isDefault: true,
        isDevHub: false,
        source: 'salesforce-cli',
      } satisfies OrgSummary;
    }
    case 'inventory.get': {
      const org = await findOrg(state, task.alias);
      return resolveInventory(state, org, task.refresh === true);
    }
    case 'inventory.start': {
      const org = await findOrg(state, task.alias);
      return startDiscoverySession(state, org, { sessionId: task.sessionId, refresh: task.refresh });
    }
    case 'inventory.status': {
      const org = await findOrg(state, task.alias);
      return getDiscoverySession(state, org, {
        sessionId: task.sessionId,
        resume: task.resume,
        family: task.family,
      });
    }
    case 'transform.get': {
      const alias = validateAlias(task.alias);
      const id = validateTransformId(task.id);
      const org = await findOrg(state, alias);
      const inventory = await resolveInventory(state, org);
      const seed = inventory.dataTransforms.find((transform) => transform.apiName === id || transform.id === id) ?? null;
      if (!inventory.apiVersion) {
        throw new CliError('UNEXPECTED_RESPONSE', 'No API version is available for this org.');
      }
      return fetchTransformBundle({ client: state.cli, alias, apiVersion: inventory.apiVersion, id, seed });
    }
    case 'mode.set':
      state.mode = task.mode;
      state.orgsCache = null;
      state.inventoryCache = null;
      clearDiscoverySessions(state);
      return { mode: state.mode };
    case 'bridge.update':
      if (!onUpdate) throw new CliError('INVALID_ARGUMENT', 'Bridge updates require the installed bridge CLI.');
      return onUpdate();
  }
}

function isRestarting(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'restarting' in result && result.restarting === true;
}

/** Long-lived outbound agent. It never opens a listener or accepts inbound connections. */
export async function runBridge(options: BridgeOptions): Promise<void> {
  const logger = options.logger ?? (() => {});
  const http = options.http ?? new FetchRelayHttp(options.relayUrl);
  const state = options.state;
  await refreshCliStatus(state);

  let token = options.token;
  if (!token) {
    if (!options.code) throw new CliError('INVALID_ARGUMENT', 'A pairing code is required to set up the bridge.');
    const paired = await http.post<PairResult>('/api/relay/pair', {
      code: options.code,
      version: state.config.version,
      cli: state.cliStatus,
    });
    token = paired.agentToken;
    await options.onPaired?.(token);
    logger('DCAT bridge paired with the site.');
  }

  const interval = options.pollIntervalMs ?? 2000;
  logger('DCAT bridge is running. Press Ctrl+C to stop.');

  while (!options.signal?.aborted) {
    try {
      const poll = await http.post<PollResult>('/api/relay/poll', {
        agentToken: token,
        version: state.config.version,
        cli: state.cliStatus,
      }, options.signal);
      if (poll.status === 'unpaired') {
        throw new RelayAuthError('The site reset this bridge pairing. Run setup again.');
      }

      for (const task of poll.tasks) {
        let response: RelayResponse;
        try {
          const result = await executeRelayOperation(state, task.operation, options.onUpdate);
          response = { id: task.id, ok: true, result };
        } catch (error) {
          response = errorResponse(task.id, error);
        }
        await http.post('/api/relay/respond', { agentToken: token, response }, options.signal);
        if (response.ok && isRestarting(response.result)) {
          logger('Bridge updated. Restarting with the latest version…');
          return;
        }
      }
    } catch (error) {
      if (options.signal?.aborted) break;
      if (error instanceof RelayAuthError) {
        logger(`Bridge stopped: ${safeErrorMessage(error)}`);
        return;
      }
      logger(`Bridge request failed: ${safeErrorMessage(error)}. Retrying.`);
    }

    try {
      await sleep(interval, options.signal);
    } catch {
      break;
    }
  }
}

export type { RelayRequestState };
