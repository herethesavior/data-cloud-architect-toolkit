import type { CliStatus, OrgSummary, RelayOperation, RelayRequestState, RelayResponse, RelayTask } from '@dcat/core';
import { relayOperationSchema } from '@dcat/core';
import { fetchTransformBundle, validateTransformId } from '@dcat/data360-api';
import { CliError, safeErrorMessage, validateAlias } from '@dcat/salesforce-cli';
import {
  createBridgeLogger,
  createFailureReporter,
  formatDuration,
  type BridgeLogLevel,
} from './bridge-logging.ts';
import { clearDiscoverySessions, getDiscoverySession, startDiscoverySession } from './discovery-sessions.ts';
import { resolveTransformContext } from './transform-context.ts';
import { refreshCliStatus, setApiVersionSelection } from './state.ts';
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

/** A rejected result cannot succeed for this stored request; the bridge must not spin on it. */
export class RelayTerminalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RelayTerminalError';
    this.code = code;
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
      const code = error?.error?.code;
      if (response.status === 413 || code === 'RESPONSE_TOO_LARGE') {
        throw new RelayTerminalError(code ?? 'RESPONSE_TOO_LARGE', message);
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
  logLevel?: BridgeLogLevel;
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

const RELAY_TIMEOUT_MESSAGE = 'The relay did not respond in time. Check the site connection.';
const PAIR_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 45_000;
const CANCEL_TIMEOUT_MS = 10_000;
const RESPOND_TIMEOUT_MS = 30_000;

/**
 * A hung socket must not strand an always-on agent. The worker holds an idle
 * poll for 20 seconds, so the poll deadline leaves room for a slow network.
 */
function postWithDeadline<T>(
  http: RelayHttp,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new CliError('COMMAND_FAILED', 'Bridge stopped.'));
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    void Promise.resolve()
      .then(() => http.post<T>(path, body, controller.signal))
      .then(resolve, (error: unknown) => {
        reject(timedOut ? new CliError('COMMAND_FAILED', RELAY_TIMEOUT_MESSAGE) : error);
      })
      .finally(cleanup);
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
      return startDiscoverySession(state, org, {
        sessionId: task.sessionId,
        refresh: task.refresh,
        families: task.families,
      });
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
      const context = await resolveTransformContext(state, org, id, task.apiVersion);
      if (!context.apiVersion) {
        throw new CliError('UNEXPECTED_RESPONSE', 'No API version is available for this org.');
      }
      return fetchTransformBundle({
        client: state.cli,
        alias,
        apiVersion: context.apiVersion,
        id,
        seed: context.seed,
      });
    }
    case 'mode.set':
      state.mode = task.mode;
      state.orgsCache = null;
      state.inventoryCache = null;
      clearDiscoverySessions(state);
      return { mode: state.mode };
    case 'compatibility.set': {
      const compatibility = setApiVersionSelection(state, task.selection);
      invalidateOrgState(state);
      return compatibility;
    }
    case 'bridge.update':
      if (!onUpdate) throw new CliError('INVALID_ARGUMENT', 'Bridge updates require the installed bridge CLI.');
      return onUpdate();
  }
}

function isRestarting(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'restarting' in result && result.restarting === true;
}

async function taskCancelled(http: RelayHttp, token: string, taskId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const state = await postWithDeadline<{ cancelled?: boolean }>(http, '/api/relay/cancelled', {
      agentToken: token,
      requestId: taskId,
    }, signal, CANCEL_TIMEOUT_MS);
    return state.cancelled === true;
  } catch {
    // A status check must never block an otherwise valid task.
    return false;
  }
}

const RESPOND_ATTEMPTS = 3;
const RESPOND_RETRY_MS = 250;

/**
 * Work already done is worth delivering. A dropped respond POST would otherwise
 * leave the request claimed forever and time the browser out; the relay accepts
 * a repeat response for the same id while it has no stored result.
 */
async function postResponse(http: RelayHttp, token: string, response: RelayResponse, signal?: AbortSignal): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await postWithDeadline(http, '/api/relay/respond', { agentToken: token, response }, signal, RESPOND_TIMEOUT_MS);
      return;
    } catch (error) {
      if (signal?.aborted || error instanceof RelayTerminalError || error instanceof RelayAuthError) throw error;
      if (attempt >= RESPOND_ATTEMPTS) throw error;
      await sleep(RESPOND_RETRY_MS * 2 ** (attempt - 1), signal);
    }
  }
}

/** Long-lived outbound agent. It never opens a listener or accepts inbound connections. */
export async function runBridge(options: BridgeOptions): Promise<void> {
  const logger = createBridgeLogger(options.logger ?? (() => {}), options.logLevel ?? 'info');
  const failures = createFailureReporter(logger);
  const http = options.http ?? new FetchRelayHttp(options.relayUrl);
  const state = options.state;
  // The installer has already probed `sf`; avoid a second probe on every start.
  if (!state.cliStatus.installed) await refreshCliStatus(state);

  let token = options.token;
  if (!token) {
    if (!options.code) throw new CliError('INVALID_ARGUMENT', 'A pairing code is required to set up the bridge.');
    const paired = await postWithDeadline<PairResult>(http, '/api/relay/pair', {
      code: options.code,
      version: state.config.version,
      cli: state.cliStatus,
      compatibility: state.compatibility,
    }, options.signal, PAIR_TIMEOUT_MS);
    token = paired.agentToken;
    await options.onPaired?.(token);
    logger.info('paired with the site', { relay: options.relayUrl });
  }

  // Idle polls are held open by the relay. This delay only backs off failures.
  const interval = options.pollIntervalMs ?? 2_000;
  logger.info('ready; press Ctrl+C to stop', {
    version: state.config.version,
    cli: state.cliStatus.version ?? 'unknown',
  });

  while (!options.signal?.aborted) {
    try {
      logger.debug('polling the relay for work');
      const poll = await postWithDeadline<PollResult>(http, '/api/relay/poll', {
        agentToken: token,
        version: state.config.version,
        cli: state.cliStatus,
        compatibility: state.compatibility,
        // The relay holds this request until work arrives, so a queued browser
        // action reaches the bridge without a two-second polling delay.
        wait: true,
      }, options.signal, POLL_TIMEOUT_MS);
      logger.debug(`relay returned ${poll.tasks.length} ${poll.tasks.length === 1 ? 'task' : 'tasks'}`);
      if (poll.status === 'unpaired') {
        throw new RelayAuthError('The site reset this bridge pairing. Run setup again.');
      }
      failures.success();
      // A successful empty long-poll ends only when the relay woke it for a
      // status probe or its 20s window expired. Re-poll immediately so the
      // probe sees liveness within its short window; failures and executed
      // tasks keep the normal backoff below.
      if (poll.tasks.length === 0) continue;

      for (const task of poll.tasks) {
        const operation = task.operation.operation;
        const request = task.id.slice(0, 8);
        // Status polls happen about once per second during discovery. Logging
        // each one at info level would dominate a long-running agent's output.
        const taskLogger = operation === 'inventory.status' ? logger.debug : logger.info;
        taskLogger(`${operation} started`, { request });
        const startedAt = Date.now();
        if (await taskCancelled(http, token, task.id, options.signal)) {
          logger.info(`${operation} skipped`, { request, reason: 'cancelled' });
          continue;
        }
        let response: RelayResponse;
        try {
          const result = await executeRelayOperation(state, task.operation, options.onUpdate);
          response = { id: task.id, ok: true, result };
          failures.success();
          taskLogger(`${operation} finished`, { request, duration: formatDuration(Date.now() - startedAt) });
        } catch (error) {
          response = errorResponse(task.id, error);
          const message = safeErrorMessage(error);
          failures.report({
            key: `${operation}:${message}`,
            message: `${operation} failed: ${message}`,
            fields: { request, duration: formatDuration(Date.now() - startedAt) },
          });
        }
        try {
          await postResponse(http, token, response, options.signal);
        } catch (error) {
          if (error instanceof RelayTerminalError) {
            // The Worker has stored a terminal failure for the browser; the
            // bridge itself is still healthy and must keep serving new tasks.
            const detail = safeErrorMessage(error).replace(/\.\s*$/, '');
            logger.error(
              `could not deliver ${operation} result: ${detail}. The browser can retry in smaller batches.`,
              { request },
            );
            continue;
          }
          throw error;
        }
        if (response.ok && isRestarting(response.result)) {
          logger.info('update installed; stopping this bridge process');
          return;
        }
      }
    } catch (error) {
      if (options.signal?.aborted) break;
      if (error instanceof RelayAuthError) {
        logger.error(`stopping: ${safeErrorMessage(error)}`);
        return;
      }
      failures.report({
        key: 'relay',
        message: `relay request failed: ${safeErrorMessage(error)}`,
        fields: { retryIn: formatDuration(interval) },
      });
    }

    try {
      await sleep(interval, options.signal);
    } catch {
      break;
    }
  }
}

export type { RelayRequestState };
