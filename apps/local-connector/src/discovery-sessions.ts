import { randomBytes } from 'node:crypto';
import { RESOURCE_FAMILIES } from '@dcat/core';
import type { InventorySnapshot, OrgSummary, ResourceFamily } from '@dcat/core';
import { CliError } from '@dcat/salesforce-cli';
import {
  advanceProgressiveDiscovery,
  initializeProgressiveDiscovery,
  interruptProgressiveDiscovery,
  interruptProgressiveFamilies,
  isProgressiveDiscoveryActive,
  progressiveSnapshot,
  restartProgressiveDiscovery,
  resumeProgressiveDiscovery,
} from '@dcat/data360-api';
import { recordApiVersionResolution } from './state.ts';
import type { AppState, DiscoverySessionRecord } from './state.ts';
import { demoInventory } from '@dcat/test-fixtures';

const SESSION_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 20;
const BATCH_DELAY_MS = 25;

// A session is not registered until its API version probe finishes. Serialize
// starts per state so two overlapping requests cannot both build a runner for
// the same alias and publish competing generations into the shared cache.
const startsByState = new WeakMap<AppState, Map<string, Promise<void>>>();

interface CallerAbortLink {
  signal: AbortSignal;
  handler: () => void;
}

// A reused session can be refreshed from several callers. Keep only the latest
// abort binding so one cancelled poll cannot stop a later refresh's runner.
const callerAborts = new WeakMap<DiscoverySessionRecord, CallerAbortLink>();

function unbindCallerAbort(record: DiscoverySessionRecord): void {
  const previous = callerAborts.get(record);
  if (previous) previous.signal.removeEventListener('abort', previous.handler);
  callerAborts.delete(record);
}

function bindCallerAbort(
  state: AppState,
  record: DiscoverySessionRecord,
  signal?: AbortSignal,
  scope: 'session' | 'families' = 'session',
  families: readonly ResourceFamily[] = [],
): void {
  unbindCallerAbort(record);
  if (!signal) return;
  const handler = () => {
    if (scope === 'families') {
      unbindCallerAbort(record);
      if (!isCurrent(state, record)) return;
      interruptProgressiveFamilies(record.state, families, 'page refresh cancelled');
      publish(state, record);
      return;
    }
    stopSession(state, record);
  };
  if (signal.aborted) handler();
  else {
    signal.addEventListener('abort', handler, { once: true });
    callerAborts.set(record, { signal, handler });
  }
}

function serializeStart<T>(state: AppState, alias: string, operation: () => Promise<T>): Promise<T> {
  let byAlias = startsByState.get(state);
  if (!byAlias) {
    byAlias = new Map();
    startsByState.set(state, byAlias);
  }
  const previous = byAlias.get(alias) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.then(() => undefined, () => undefined);
  byAlias.set(alias, settled);
  void settled.finally(() => {
    if (byAlias.get(alias) === settled) byAlias.delete(alias);
  });
  return current;
}

export interface DiscoverySessionResult {
  sessionId: string;
  snapshot: InventorySnapshot;
}

export interface DiscoverySessionOptions {
  sessionId?: string;
  refresh?: boolean;
  resume?: boolean;
  family?: ResourceFamily;
  /** Families to re-run inside an existing session; omitted means all of them. */
  families?: readonly ResourceFamily[];
  /** Request cancellation, including the version probe before a session exists. */
  signal?: AbortSignal;
}

function newId(): string {
  return randomBytes(12).toString('base64url');
}

function resultOf(record: DiscoverySessionRecord): DiscoverySessionResult {
  return { sessionId: record.id, snapshot: record.latest };
}

function isExpired(record: DiscoverySessionRecord): boolean {
  return Date.now() - record.updatedAt > SESSION_TTL_MS;
}

function stopSession(state: AppState, record: DiscoverySessionRecord): void {
  unbindCallerAbort(record);
  record.controller.abort();
  state.discoverySessions.delete(record.id);
  if (state.discoveryByAlias.get(record.alias) === record.id) {
    state.discoveryByAlias.delete(record.alias);
  }
}

function pruneSessions(state: AppState): void {
  for (const record of [...state.discoverySessions.values()]) {
    if (isExpired(record)) stopSession(state, record);
  }
  while (state.discoverySessions.size > MAX_SESSIONS) {
    const oldest = [...state.discoverySessions.values()]
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!oldest) break;
    stopSession(state, oldest);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isCurrent(state: AppState, record: DiscoverySessionRecord): boolean {
  return state.discoverySessions.get(record.id) === record && !record.controller.signal.aborted;
}

function publish(
  state: AppState,
  record: DiscoverySessionRecord,
  current = record.state,
): void {
  if (!isCurrent(state, record)) return;
  record.latest = progressiveSnapshot(current);
  record.updatedAt = Date.now();
  state.inventoryCache = { at: Date.now(), alias: record.alias, inventory: record.latest };
}

async function runSession(state: AppState, record: DiscoverySessionRecord): Promise<void> {
  record.running = true;
  try {
    while (isCurrent(state, record) && isProgressiveDiscoveryActive(record.state)) {
      await advanceProgressiveDiscovery(record.state, {
        // Each committed page is visible immediately, even while the same batch
        // continues with count probes or per-DMO lookups.
        onProgress: (current) => publish(state, record, current),
      });
      publish(state, record);
      if (!isProgressiveDiscoveryActive(record.state)) break;
      await sleep(BATCH_DELAY_MS, record.controller.signal);
    }
  } catch (error) {
    if (!isCurrent(state, record)) return;
    // Terminalize active cursors so a repeated runner exception cannot keep the
    // session alive and make the browser poll forever.
    const reason = error instanceof Error ? error.message : 'unknown error';
    interruptProgressiveDiscovery(record.state, reason);
    publish(state, record);
  } finally {
    record.running = false;
  }
}

function ensureRunner(state: AppState, record: DiscoverySessionRecord): void {
  if (record.running || !isProgressiveDiscoveryActive(record.state)) return;
  void runSession(state, record);
}

/** Start (or reuse) a progressive discovery session and return its first batch. */
export function startDiscoverySession(
  state: AppState,
  org: OrgSummary,
  options: DiscoverySessionOptions = {},
): Promise<DiscoverySessionResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new CliError('COMMAND_FAILED', 'Discovery request was cancelled.'));
  }
  return serializeStart(state, org.alias, () => startDiscoverySessionNow(state, org, options));
}

async function startDiscoverySessionNow(
  state: AppState,
  org: OrgSummary,
  options: DiscoverySessionOptions = {},
): Promise<DiscoverySessionResult> {
  if (state.mode === 'demo') return { sessionId: 'demo', snapshot: demoInventory };
  pruneSessions(state);

  // A scoped refresh reuses the live session and restarts only the requested
  // families. Without a reusable session there is no DMO/DLO seed for derived
  // families such as mappings, so the caller gets a normal first load instead.
  const scopedFamilies = options.families?.filter((family) => RESOURCE_FAMILIES.includes(family));
  if (options.refresh && scopedFamilies?.length && scopedFamilies.length < RESOURCE_FAMILIES.length && !options.sessionId) {
    const activeId = state.discoveryByAlias.get(org.alias);
    const active = activeId ? state.discoverySessions.get(activeId) : undefined;
    if (active && active.alias === org.alias && !isExpired(active)
      && !active.controller.signal.aborted && active.state.apiVersion) {
      restartProgressiveDiscovery(active.state, scopedFamilies);
      active.generation = active.state.generation;
      publish(state, active);
      // Cancelling a page-level refresh must not discard the reused session:
      // rows from other families are still valid and may still be loading.
      bindCallerAbort(state, active, options.signal, 'families', scopedFamilies);
      ensureRunner(state, active);
      return resultOf(active);
    }
  }

  const reusedId = options.sessionId ?? state.discoveryByAlias.get(org.alias);
  if (reusedId && !options.refresh) {
    const existing = state.discoverySessions.get(reusedId);
    if (existing && existing.alias === org.alias && !isExpired(existing)) {
      return resultOf(existing);
    }
  }

  // Validate a caller-supplied id before stopping any existing work: a rejected
  // request must not abort the target org's current discovery session.
  const conflicting = options.sessionId ? state.discoverySessions.get(options.sessionId) : undefined;
  if (conflicting && conflicting.alias !== org.alias) {
    throw new CliError('INVALID_ARGUMENT', 'This discovery session belongs to another org.');
  }

  const previousId = state.discoveryByAlias.get(org.alias);
  if (previousId) {
    const previous = state.discoverySessions.get(previousId);
    if (previous) stopSession(state, previous);
  }
  if (conflicting) stopSession(state, conflicting);

  const sessionId = options.sessionId ?? newId();
  const generation = `${Date.now().toString(36)}-${newId().slice(0, 8)}`;
  const controller = new AbortController();
  if (options.signal?.aborted) {
    throw new CliError('COMMAND_FAILED', 'Discovery request was cancelled.');
  }
  // A disconnected browser must not leave the per-alias start lock held by a
  // slow version probe. Once the session exists, bindCallerAbort owns this.
  const abortProbe = () => controller.abort();
  options.signal?.addEventListener('abort', abortProbe, { once: true });
  // Return as soon as the API version is known. The runner publishes every
  // family page to the shared cache, so status polls see rows as they land.
  let progressive;
  try {
    progressive = await initializeProgressiveDiscovery({
      cli: state.cli,
      alias: org.alias,
      org,
      sessionId,
      generation,
      signal: controller.signal,
      apiVersionSelection: state.compatibility.selection,
      onApiVersionResolved: recordApiVersionResolution(state),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new CliError('COMMAND_FAILED', 'Discovery request was cancelled.', { cause: error });
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortProbe);
  }
  const record: DiscoverySessionRecord = {
    id: sessionId,
    alias: org.alias,
    generation,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: progressive,
    latest: progressiveSnapshot(progressive),
    controller,
    running: false,
  };
  state.discoverySessions.set(sessionId, record);
  state.discoveryByAlias.set(org.alias, sessionId);
  bindCallerAbort(state, record, options.signal);
  publish(state, record);
  ensureRunner(state, record);
  return resultOf(record);
}

/** Read the latest partial/complete snapshot for an opaque session id. */
export async function getDiscoverySession(
  state: AppState,
  org: OrgSummary,
  options: DiscoverySessionOptions,
): Promise<DiscoverySessionResult> {
  if (state.mode === 'demo') return { sessionId: 'demo', snapshot: demoInventory };
  if (!options.sessionId) throw new CliError('INVALID_ARGUMENT', 'A discovery session id is required.');
  pruneSessions(state);
  const record = state.discoverySessions.get(options.sessionId);
  if (!record || record.alias !== org.alias) {
    throw new CliError('SESSION_EXPIRED', 'This discovery session expired. Starting a fresh inventory load.');
  }

  if (options.resume) {
    resumeProgressiveDiscovery(record.state, options.family);
    publish(state, record);
  }
  ensureRunner(state, record);
  return resultOf(record);
}

/** Mode changes and workspace resets must abort every in-flight CLI batch. */
export function clearDiscoverySessions(state: AppState): void {
  for (const record of [...state.discoverySessions.values()]) stopSession(state, record);
}
