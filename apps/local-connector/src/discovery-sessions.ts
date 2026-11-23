import { randomBytes } from 'node:crypto';
import type { InventorySnapshot, OrgSummary, ResourceFamily } from '@dcat/core';
import { CliError } from '@dcat/salesforce-cli';
import {
  advanceProgressiveDiscovery,
  createProgressiveDiscovery,
  isProgressiveDiscoveryActive,
  progressiveSnapshot,
  resumeProgressiveDiscovery,
} from '@dcat/data360-api';
import type { AppState, DiscoverySessionRecord } from './state.ts';
import { demoInventory } from '@dcat/test-fixtures';

const SESSION_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 20;
const BATCH_DELAY_MS = 25;

export interface DiscoverySessionResult {
  sessionId: string;
  snapshot: InventorySnapshot;
}

export interface DiscoverySessionOptions {
  sessionId?: string;
  refresh?: boolean;
  resume?: boolean;
  family?: ResourceFamily;
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

async function runSession(state: AppState, record: DiscoverySessionRecord): Promise<void> {
  record.running = true;
  try {
    while (isCurrent(state, record) && isProgressiveDiscoveryActive(record.state)) {
      await advanceProgressiveDiscovery(record.state);
      // A refresh, mode switch, or TTL prune may have replaced this session while
      // the CLI call was in flight. Never let an old worker overwrite new cache.
      if (!isCurrent(state, record)) break;
      record.latest = progressiveSnapshot(record.state);
      record.updatedAt = Date.now();
      state.inventoryCache = { at: Date.now(), alias: record.alias, inventory: record.latest };
      if (!isProgressiveDiscoveryActive(record.state)) break;
      await sleep(BATCH_DELAY_MS, record.controller.signal);
    }
  } catch (error) {
    if (!isCurrent(state, record)) return;
    // A malformed snapshot must not silently become an empty inventory. Keep the
    // last valid snapshot and surface the failure on the next status poll.
    record.state.warnings.push({
      family: 'api-versions',
      code: 'DISCOVERY_INTERRUPTED',
      message: `Background discovery stopped: ${error instanceof Error ? error.message : 'unknown error'}`,
      severity: 'error',
    });
    record.latest = progressiveSnapshot(record.state);
    record.updatedAt = Date.now();
  } finally {
    record.running = false;
  }
}

function ensureRunner(state: AppState, record: DiscoverySessionRecord): void {
  if (record.running || !isProgressiveDiscoveryActive(record.state)) return;
  void runSession(state, record);
}

/** Start (or reuse) a progressive discovery session and return its first batch. */
export async function startDiscoverySession(
  state: AppState,
  org: OrgSummary,
  options: DiscoverySessionOptions = {},
): Promise<DiscoverySessionResult> {
  if (state.mode === 'demo') return { sessionId: 'demo', snapshot: demoInventory };
  pruneSessions(state);

  const reusedId = options.sessionId ?? state.discoveryByAlias.get(org.alias);
  if (reusedId && !options.refresh) {
    const existing = state.discoverySessions.get(reusedId);
    if (existing && existing.alias === org.alias && !isExpired(existing)) {
      return resultOf(existing);
    }
  }

  const previousId = state.discoveryByAlias.get(org.alias);
  if (previousId) {
    const previous = state.discoverySessions.get(previousId);
    if (previous) stopSession(state, previous);
  }

  // A caller-supplied id must not silently replace another org's live session.
  const conflicting = options.sessionId ? state.discoverySessions.get(options.sessionId) : undefined;
  if (conflicting && conflicting.alias !== org.alias) {
    throw new CliError('INVALID_ARGUMENT', 'This discovery session belongs to another org.');
  }
  if (conflicting) stopSession(state, conflicting);

  const sessionId = options.sessionId ?? newId();
  const generation = `${Date.now().toString(36)}-${newId().slice(0, 8)}`;
  const controller = new AbortController();
  const progressive = await createProgressiveDiscovery({
    cli: state.cli,
    alias: org.alias,
    org,
    sessionId,
    generation,
    signal: controller.signal,
  });
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
  state.inventoryCache = { at: Date.now(), alias: org.alias, inventory: record.latest };
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
    record.latest = progressiveSnapshot(record.state);
    record.updatedAt = Date.now();
  }
  ensureRunner(state, record);
  return resultOf(record);
}

/** Mode changes and workspace resets must abort every in-flight CLI batch. */
export function clearDiscoverySessions(state: AppState): void {
  for (const record of [...state.discoverySessions.values()]) stopSession(state, record);
}
