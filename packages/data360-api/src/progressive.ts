import type {
  ApiCapability,
  DataModelObject,
  DiscoveryProgress,
  DiscoverySessionState,
  FamilyProgress,
  FamilyProgressState,
  InventorySnapshot,
  OrgSummary,
  RelationshipEdge,
  ResourceFamily,
  RetrievalStatus,
  RetrievalWarning,
} from '@dcat/core';
import { RESOURCE_FAMILIES } from '@dcat/core';
import { safeErrorMessage } from '@dcat/salesforce-cli';
import { classifyRestFailure } from './capabilities.ts';
import type { RestClient } from './discover.ts';
import { extractHttpStatus, isTransientRestFailure, validateInventorySnapshot } from './discover.ts';
import { buildData360Path, buildMappingPath, buildVersionsPath } from './endpoints.ts';
import {
  deriveInferredRelationships,
  extractCollection,
  normalizeDataSpaces,
  normalizeDataStreams,
  normalizeDataTransforms,
  normalizeDlos,
  normalizeDmos,
  normalizeMappings,
  parseJsonResponse,
} from './normalize.ts';
import type { NormalizeContext, NormalizedCollection, NormalizedDmos } from './normalize.ts';
import { buildNextPath, extractContinuation } from './pagination.ts';
import { selectLatestApiVersion } from './versions.ts';

const NON_MAPPING_FAMILIES = [
  'data-spaces',
  'dlos',
  'dmos',
  'data-streams',
  'data-transforms',
] as const;
type NonMappingFamily = (typeof NON_MAPPING_FAMILIES)[number];

/** One CLI call can safely carry a path of this length; cursors are opaque. */
const MAX_REST_PATH_LENGTH = 480;
const MAPPING_CONCURRENCY = 4;

export interface PageRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

interface CursorState {
  basePath: string;
  path: string;
  paths: string[];
  cursor: string | null;
  param: string | null;
  pageIndex: number;
  total: number | null;
  done: boolean;
  failed: boolean;
  error: string | null;
  errorStatus: RetrievalStatus;
  retried: number;
  skipped: number;
  seenKeys: string[];
}

interface FamilyState extends CursorState {
  family: NonMappingFamily;
  items: unknown[];
  relationships: RelationshipEdge[];
}

interface MappingTask extends CursorState {
  dmoName: string;
}

interface MappingState extends CursorState {
  family: 'mappings';
  items: unknown[];
  tasks: MappingTask[];
  queuedDmos: string[];
  failedQueries: number;
  limitHit: boolean;
}

export interface ProgressiveDiscoveryState {
  cli: RestClient;
  sessionId: string;
  generation: string;
  alias: string;
  org: OrgSummary;
  apiVersion: string | null;
  generatedAt: string;
  base: Omit<NormalizeContext, 'apiVersion' | 'endpoint'>;
  options: {
    maxPages: number;
    maxMappingQueries: number;
    retry: PageRetryOptions;
  };
  families: Record<NonMappingFamily, FamilyState>;
  mappings: MappingState;
  capabilities: ApiCapability[];
  warnings: RetrievalWarning[];
  relationships: RelationshipEdge[];
}

export interface ProgressiveDiscoveryOptions {
  cli: RestClient;
  alias: string;
  org: OrgSummary;
  sessionId?: string;
  generation?: string;
  maxPages?: number;
  maxMappingQueries?: number;
  retry?: Partial<PageRetryOptions>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryOptions(overrides: Partial<PageRetryOptions> = {}): PageRetryOptions {
  return {
    maxAttempts: 3,
    baseDelayMs: 150,
    maxDelayMs: 2_000,
    sleep: defaultSleep,
    random: Math.random,
    ...overrides,
  };
}

/** Bounded retries happen per page, so a late failure never discards earlier pages. */
export async function withPageRetry<T>(
  operation: () => Promise<T>,
  options: PageRetryOptions,
): Promise<{ value: T; attempts: number; retried: boolean }> {
  const maxAttempts = Math.max(1, options.maxAttempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return { value: await operation(), attempts: attempt, retried: attempt > 1 };
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientRestFailure(error)) break;
      const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      await options.sleep(Math.max(0, Math.floor(options.random() * ceiling)));
    }
  }
  throw lastError;
}

function pushWarning(
  state: ProgressiveDiscoveryState,
  family: ResourceFamily | 'api-versions',
  code: string,
  message: string,
  severity: RetrievalWarning['severity'],
): void {
  const warning: RetrievalWarning = { family, code, message, severity };
  const duplicate = state.warnings.some((entry) =>
    entry.family === family && entry.code === code && entry.message === message);
  if (!duplicate) state.warnings.push(warning);
}

function makeCursor(basePath: string): CursorState {
  return {
    basePath,
    path: basePath,
    paths: [basePath],
    cursor: null,
    param: null,
    pageIndex: 0,
    total: null,
    done: false,
    failed: false,
    error: null,
    errorStatus: 'error',
    retried: 0,
    skipped: 0,
    seenKeys: [],
  };
}

function makeFamily(family: NonMappingFamily, apiVersion: string): FamilyState {
  return {
    ...makeCursor(buildData360Path(family, apiVersion)),
    family,
    items: [],
    relationships: [],
  };
}

function makeMappingTask(dmoName: string, apiVersion: string): MappingTask {
  return { ...makeCursor(buildMappingPath(dmoName, apiVersion)), dmoName };
}

function contextFor(state: ProgressiveDiscoveryState, family: ResourceFamily): NormalizeContext {
  const endpoint = family === 'mappings'
    ? state.mappings.basePath
    : state.families[family].basePath;
  return { ...state.base, apiVersion: state.apiVersion ?? '', endpoint };
}

function identityFor(family: ResourceFamily, item: unknown): string {
  if (family === 'mappings' && typeof item === 'object' && item !== null) {
    const record = item as Record<string, unknown>;
    const fields = Array.isArray(record.fieldMappings)
      ? record.fieldMappings.map((field) => JSON.stringify(field)).join('|')
      : '';
    return `mapping|${String(record.apiName ?? '')}|${String(record.sourceObject ?? '')}|${String(record.targetObject ?? '')}|${fields}`;
  }
  if (typeof item === 'object' && item !== null) {
    const record = item as Record<string, unknown>;
    if (typeof record.apiName === 'string' && record.apiName) return record.apiName;
    if (typeof record.id === 'string' && record.id) return record.id;
  }
  return JSON.stringify(item);
}

function mergeNormalized<T>(
  state: ProgressiveDiscoveryState,
  family: ResourceFamily,
  cursor: CursorState,
  normalized: NormalizedCollection<T>,
): void {
  const items = family === 'mappings' ? state.mappings.items : state.families[family as NonMappingFamily].items;
  for (const item of normalized.items) {
    const key = identityFor(family, item);
    if (cursor.seenKeys.includes(key)) continue;
    cursor.seenKeys.push(key);
    items.push(item);
  }
  cursor.skipped += normalized.skipped;
}

function markFailure(
  state: ProgressiveDiscoveryState,
  family: ResourceFamily,
  cursor: CursorState,
  error: unknown,
  prefix?: string,
): void {
  const message = safeErrorMessage(error);
  const classified = classifyRestFailure(extractHttpStatus(message), message);
  cursor.failed = true;
  cursor.error = prefix ? `${prefix} ${classified.message}` : classified.message;
  cursor.errorStatus = classified.status;
  pushWarning(state, family, classified.status.toUpperCase(), cursor.error,
    classified.status === 'unsupported' ? 'warning' : 'error');
}

function stopWithWarning(
  state: ProgressiveDiscoveryState,
  family: ResourceFamily,
  cursor: CursorState,
  code: string,
  message: string,
): void {
  cursor.done = true;
  pushWarning(state, family, code, message, 'warning');
}

function applyContinuation(
  state: ProgressiveDiscoveryState,
  family: ResourceFamily,
  cursor: CursorState,
  continuation: ReturnType<typeof extractContinuation>,
): void {
  cursor.pageIndex += 1;
  if (continuation.total !== null) {
    cursor.total = Math.max(cursor.total ?? 0, continuation.total);
  }
  if (!continuation.hasMore) {
    cursor.done = true;
    return;
  }
  if (continuation.uncertain || (!continuation.cursor && !continuation.nextPath)) {
    stopWithWarning(state, family, cursor, 'CONTINUATION_MISSING',
      'The response reported more results but did not include a usable continuation cursor.');
    return;
  }
  if (cursor.pageIndex >= state.options.maxPages) {
    stopWithWarning(state, family, cursor, 'PAGINATION_LIMIT',
      `Pagination stopped after ${state.options.maxPages} page(s); results may be incomplete.`);
    return;
  }

  const nextPath = buildNextPath(cursor.path, continuation);
  if (nextPath.length > MAX_REST_PATH_LENGTH) {
    stopWithWarning(state, family, cursor, 'CONTINUATION_TOO_LONG',
      'The continuation path exceeded the Salesforce CLI REST path limit; earlier results were kept.');
    return;
  }
  if (cursor.paths.includes(nextPath)) {
    stopWithWarning(state, family, cursor, 'CONTINUATION_LOOP',
      'Salesforce repeated a continuation cursor; earlier results were kept to avoid a duplicate-page loop.');
    return;
  }

  cursor.paths.push(nextPath);
  cursor.path = nextPath;
  cursor.cursor = continuation.cursor;
  cursor.param = continuation.param;
}

async function requestPage<T>(
  state: ProgressiveDiscoveryState,
  family: ResourceFamily,
  cursor: CursorState,
  label: string,
  normalize: (raw: unknown[], context: NormalizeContext) => NormalizedCollection<T>,
): Promise<boolean> {
  if (cursor.done || cursor.failed) return false;
  const before = cursor.pageIndex;

  try {
    const attempt = await withPageRetry(async () => {
      const raw = await state.cli.restGet(state.alias, cursor.path);
      return parseJsonResponse(raw, label);
    }, state.options.retry);

    const decoded = attempt.value;
    const entries = extractCollection(decoded, label);
    const normalized = normalize(entries, contextFor(state, family));
    mergeNormalized(state, family, cursor, normalized);
    if (family === 'dmos') {
      const relationships = (normalized as NormalizedCollection<unknown> as NormalizedDmos).relationships ?? [];
      const familyState = state.families.dmos;
      for (const edge of relationships) {
        if (!familyState.relationships.some((existing) => existing.id === edge.id)) {
          familyState.relationships.push(edge);
        }
      }
    }
    if (attempt.retried) {
      cursor.retried += 1;
      pushWarning(state, family, 'RETRY_SUCCEEDED',
        `Retrieved a page after ${attempt.attempts} attempts following a transient failure.`, 'info');
    }
    applyContinuation(state, family, cursor, extractContinuation(decoded));
    return cursor.pageIndex > before || cursor.done !== false;
  } catch (error) {
    markFailure(state, family, cursor, error);
    return true;
  }
}

function normalizerFor(family: NonMappingFamily) {
  switch (family) {
    case 'data-spaces': return normalizeDataSpaces;
    case 'dlos': return normalizeDlos;
    case 'dmos': return normalizeDmos;
    case 'data-streams': return normalizeDataStreams;
    case 'data-transforms': return normalizeDataTransforms;
  }
}

async function fetchFamilyPage(state: ProgressiveDiscoveryState, family: NonMappingFamily): Promise<boolean> {
  const cursor = state.families[family];
  const normalizer = normalizerFor(family) as (
    raw: unknown[], context: NormalizeContext,
  ) => NormalizedCollection<unknown>;
  return requestPage(state, family, cursor, family, normalizer);
}

function syncMappingTasks(state: ProgressiveDiscoveryState): void {
  const dmos = state.families.dmos.items as DataModelObject[];
  for (const dmo of dmos) {
    const name = dmo.apiName?.trim();
    if (!name || state.mappings.queuedDmos.includes(name)) continue;
    if (state.mappings.tasks.length >= state.options.maxMappingQueries) {
      if (!state.mappings.limitHit) {
        state.mappings.limitHit = true;
        stopWithWarning(state, 'mappings', state.mappings,
          'MAPPING_QUERY_LIMIT',
          `Checked the first ${state.options.maxMappingQueries} DMOs; remaining mapping lookups were not attempted.`);
      }
      break;
    }
    state.mappings.queuedDmos.push(name);
    state.mappings.tasks.push(makeMappingTask(name, state.apiVersion ?? ''));
  }

  if (state.families.dmos.done && dmos.length === 0 && state.mappings.tasks.length === 0) {
    pushWarning(state, 'mappings', 'MAPPINGS_SKIPPED',
      'Skipped: no DMOs were found; mapping lookup requires a DMO developer name.', 'info');
  }
}

async function fetchMappingTaskPage(state: ProgressiveDiscoveryState, task: MappingTask): Promise<boolean> {
  const before = task.pageIndex;
  const ok = await requestPage(state, 'mappings', task, 'mappings', (raw, context) =>
    normalizeMappings(raw, context) as NormalizedCollection<unknown>);
  if (!ok) return false;

  if (task.failed) {
    state.mappings.failedQueries += 1;
    const detail = task.error ?? 'Mapping lookup failed.';
    pushWarning(state, 'mappings', 'MAPPING_QUERY_FAILED',
      `Mapping lookup for DMO ${task.dmoName} failed. ${detail}`, 'error');
  }
  if (task.retried > 0) state.mappings.retried += 1;
  state.mappings.pageIndex += task.pageIndex - before;
  state.mappings.total = Math.max(state.mappings.total ?? 0, task.total ?? 0) || state.mappings.total;
  return true;
}

function anyActive(state: ProgressiveDiscoveryState): boolean {
  return NON_MAPPING_FAMILIES.some((family) => {
    const cursor = state.families[family];
    return !cursor.done && !cursor.failed;
  }) || state.mappings.tasks.some((task) => !task.done && !task.failed);
}

function statusForFamily(state: ProgressiveDiscoveryState, family: ResourceFamily): ApiCapability['status'] {
  if (family === 'mappings') {
    const tasks = state.mappings.tasks;
    const failed = tasks.filter((task) => task.failed);
    const active = tasks.some((task) => !task.done && !task.failed);
    if (failed.length === tasks.length && tasks.length > 0) {
      return failed.every((task) => task.errorStatus === 'unsupported') ? 'unsupported'
        : failed.every((task) => task.errorStatus === 'forbidden') ? 'forbidden'
          : 'error';
    }
    if (active || failed.length > 0 || state.mappings.limitHit) return 'partial';
    if (tasks.length === 0) return state.families.dmos.done ? 'available' : 'not-started';
    return 'available';
  }

  const cursor = state.families[family];
  if (cursor.failed) {
    return cursor.items.length > 0 ? 'partial' : cursor.errorStatus;
  }
  return cursor.done ? 'available' : 'partial';
}

function messageForStatus(status: RetrievalStatus, loaded: number): string {
  switch (status) {
    case 'available': return `Retrieved ${loaded} item(s).`;
    case 'partial': return `${loaded} item(s) loaded; more results are still being retrieved.`;
    case 'forbidden': return 'Access denied. Check Data 360 permissions or API access for this user.';
    case 'unsupported': return 'This endpoint is unavailable for this org or API version.';
    case 'error': return 'Retrieval failed for this family. Earlier results were kept.';
    case 'not-started': return 'Not started.';
  }
}

function dedupeEdges(edges: RelationshipEdge[]): RelationshipEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    if (seen.has(edge.id)) return false;
    seen.add(edge.id);
    return true;
  });
}

function recompute(state: ProgressiveDiscoveryState): void {
  if (!state.apiVersion) return;

  for (const family of RESOURCE_FAMILIES) {
    const status = statusForFamily(state, family);
    const loaded = family === 'mappings'
      ? state.mappings.items.length
      : state.families[family].items.length;
    const capability: ApiCapability = {
      family,
      status,
      endpoint: family === 'mappings'
        ? state.mappings.basePath
        : state.families[family].basePath,
      apiVersion: state.apiVersion,
      message: family === 'mappings' && state.families.dmos.done && state.mappings.tasks.length === 0
        ? 'Skipped: no DMOs were found; mapping lookup requires a DMO developer name.'
        : messageForStatus(status, loaded),
      durationMs: null,
      itemCount: loaded,
    };
    const index = state.capabilities.findIndex((entry) => entry.family === family);
    if (index >= 0) state.capabilities[index] = capability;
    else state.capabilities.push(capability);
  }

  for (const family of RESOURCE_FAMILIES) {
    const skipped = family === 'mappings'
      ? state.mappings.skipped
      : state.families[family].skipped;
    if (skipped > 0) {
      pushWarning(state, family, 'ITEMS_SKIPPED',
        `${skipped} item(s) were skipped because required identifying fields were missing.`, 'warning');
    }
    const retried = family === 'mappings'
      ? state.mappings.tasks.reduce((count, task) => count + task.retried, 0)
      : state.families[family].retried;
    if (retried > 0) {
      pushWarning(state, family, 'RETRY_SUCCEEDED',
        `${retried} page(s) succeeded after a bounded transient retry.`, 'info');
    }
  }

  const dmoContext: NormalizeContext = {
    ...state.base,
    apiVersion: state.apiVersion,
    endpoint: state.families.dmos.basePath,
  };
  state.relationships = dedupeEdges([
    ...state.families.dmos.relationships,
    ...deriveInferredRelationships(state.families.dmos.items as DataModelObject[], dmoContext),
  ]);
}

function familyProgress(state: ProgressiveDiscoveryState, family: ResourceFamily): FamilyProgress {
  const capability = state.capabilities.find((entry) => entry.family === family);
  const familyFailed = family === 'mappings'
    ? state.mappings.tasks.some((task) => task.failed)
    : state.families[family].failed;
  const status: FamilyProgressState = familyFailed ? 'failed'
    : capability?.status === 'available' ? 'complete'
      : capability?.status === 'partial' ? 'partial'
        : capability?.status === 'not-started' ? 'not-started'
          : capability?.status === 'error' || capability?.status === 'forbidden' || capability?.status === 'unsupported'
            ? 'failed'
            : capability?.status ?? 'not-started';
  const cursor = family === 'mappings' ? state.mappings : state.families[family];
  const pages = family === 'mappings'
    ? state.mappings.tasks.reduce((sum, task) => sum + task.pageIndex, 0)
    : state.families[family].pageIndex;
  const hasMore = family === 'mappings'
    ? state.mappings.tasks.some((task) => !task.done && !task.failed)
    : !cursor.done && !cursor.failed;
  const error = family === 'mappings'
    ? state.mappings.tasks.find((task) => task.failed)?.error ?? null
    : state.families[family].error;

  return {
    family,
    status,
    loaded: capability?.itemCount ?? (family === 'mappings'
      ? state.mappings.items.length
      : state.families[family].items.length),
    total: cursor.total,
    pagesFetched: pages,
    hasMore,
    error,
  };
}

export function discoveryProgress(state: ProgressiveDiscoveryState): DiscoveryProgress {
  const families = RESOURCE_FAMILIES.map((family) => familyProgress(state, family));
  const active = anyActive(state);
  const failed = families.some((entry) => entry.status === 'failed' || Boolean(entry.error));
  const sessionState: DiscoverySessionState = active ? 'running'
    : failed ? 'failed'
      : families.every((entry) => entry.status === 'complete') ? 'complete'
        : 'partial';
  const allTotalsKnown = families.every((entry) => entry.total !== null);
  return {
    sessionId: state.sessionId,
    generation: state.generation,
    state: sessionState,
    loaded: families.reduce((sum, entry) => sum + entry.loaded, 0),
    total: allTotalsKnown ? families.reduce((sum, entry) => sum + (entry.total ?? 0), 0) : null,
    families,
    message: sessionState === 'failed'
      ? 'Some families stopped after a page failure. Earlier results are still available.'
      : active ? 'Loading metadata in small batches.' : 'All discovered metadata is loaded.',
  };
}

export function progressiveSnapshot(state: ProgressiveDiscoveryState): InventorySnapshot {
  return validateInventorySnapshot({
    org: state.org,
    apiVersion: state.apiVersion,
    generatedAt: state.generatedAt,
    mode: 'live',
    capabilities: state.capabilities,
    dataSpaces: state.families['data-spaces'].items as InventorySnapshot['dataSpaces'],
    dlos: state.families.dlos.items as InventorySnapshot['dlos'],
    dmos: state.families.dmos.items as InventorySnapshot['dmos'],
    mappings: state.mappings.items as InventorySnapshot['mappings'],
    dataStreams: state.families['data-streams'].items as InventorySnapshot['dataStreams'],
    dataTransforms: state.families['data-transforms'].items as InventorySnapshot['dataTransforms'],
    relationships: state.relationships,
    warnings: state.warnings,
    progress: discoveryProgress(state),
  });
}

function unavailableState(options: ProgressiveDiscoveryOptions, apiVersion: null, message: string): ProgressiveDiscoveryState {
  const generatedAt = new Date().toISOString();
  const sessionId = options.sessionId ?? `session-${Date.now().toString(36)}`;
  const generation = options.generation ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const state: ProgressiveDiscoveryState = {
    cli: options.cli,
    sessionId,
    generation,
    alias: options.alias,
    org: options.org,
    apiVersion,
    generatedAt,
    base: {
      orgId: options.org.orgId ?? options.org.alias,
      orgAlias: options.org.alias,
      retrievedAt: generatedAt,
    },
    options: {
      maxPages: options.maxPages ?? 1_000,
      maxMappingQueries: options.maxMappingQueries ?? 500,
      retry: retryOptions(options.retry),
    },
    families: {
      'data-spaces': makeFamily('data-spaces', '0'),
      dlos: makeFamily('dlos', '0'),
      dmos: makeFamily('dmos', '0'),
      'data-streams': makeFamily('data-streams', '0'),
      'data-transforms': makeFamily('data-transforms', '0'),
    },
    mappings: {
      ...makeCursor(buildData360Path('mappings', '0')),
      family: 'mappings',
      items: [],
      tasks: [],
      queuedDmos: [],
      failedQueries: 0,
      limitHit: false,
      done: true,
    },
    capabilities: [{
      family: 'api-versions',
      status: 'error',
      endpoint: buildVersionsPath(),
      apiVersion: null,
      message,
      durationMs: null,
      itemCount: null,
    }],
    warnings: [{
      family: 'api-versions',
      code: 'API_VERSION_UNAVAILABLE',
      message,
      severity: 'error',
    }],
    relationships: [],
  };
  for (const family of RESOURCE_FAMILIES) {
    state.capabilities.push({
      family,
      status: 'error',
      endpoint: family === 'mappings'
        ? buildData360Path('mappings', '0')
        : state.families[family as NonMappingFamily].basePath,
      apiVersion: null,
      message: 'API version could not be discovered; no metadata was requested.',
      durationMs: null,
      itemCount: null,
    });
  }
  return state;
}

/** Start a session and await its first page so the caller can render rows immediately. */
export async function createProgressiveDiscovery(
  options: ProgressiveDiscoveryOptions,
): Promise<ProgressiveDiscoveryState> {
  const generatedAt = new Date().toISOString();
  const sessionId = options.sessionId ?? `session-${Date.now().toString(36)}`;
  const generation = options.generation ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const versionsPath = buildVersionsPath();
  let apiVersion: string | null = null;
  let versionMessage = '';
  try {
    apiVersion = selectLatestApiVersion(await options.cli.restGet(options.alias, versionsPath));
    versionMessage = `Using API version ${apiVersion}.`;
  } catch (error) {
    const message = safeErrorMessage(error);
    const classified = classifyRestFailure(extractHttpStatus(message), message);
    return unavailableState({ ...options, sessionId, generation }, null, classified.message);
  }

  const state: ProgressiveDiscoveryState = {
    cli: options.cli,
    sessionId,
    generation,
    alias: options.alias,
    org: options.org,
    apiVersion,
    generatedAt,
    base: {
      orgId: options.org.orgId ?? options.org.alias,
      orgAlias: options.org.alias,
      retrievedAt: generatedAt,
    },
    options: {
      maxPages: options.maxPages ?? 1_000,
      maxMappingQueries: options.maxMappingQueries ?? 500,
      retry: retryOptions(options.retry),
    },
    families: {
      'data-spaces': makeFamily('data-spaces', apiVersion),
      dlos: makeFamily('dlos', apiVersion),
      dmos: makeFamily('dmos', apiVersion),
      'data-streams': makeFamily('data-streams', apiVersion),
      'data-transforms': makeFamily('data-transforms', apiVersion),
    },
    mappings: {
      ...makeCursor(buildData360Path('mappings', apiVersion)),
      family: 'mappings',
      items: [],
      tasks: [],
      queuedDmos: [],
      failedQueries: 0,
      limitHit: false,
    },
    capabilities: [{
      family: 'api-versions',
      status: 'available',
      endpoint: versionsPath,
      apiVersion,
      message: versionMessage,
      durationMs: null,
      itemCount: null,
    }],
    warnings: [],
    relationships: [],
  };

  await advanceProgressiveDiscovery(state);
  return state;
}

/** Fetch one page for each active family, then one page for a few mapping DMOs. */
export async function advanceProgressiveDiscovery(
  state: ProgressiveDiscoveryState,
): Promise<{ active: boolean; changed: boolean }> {
  if (!state.apiVersion) return { active: false, changed: false };

  const active = NON_MAPPING_FAMILIES.filter((family) => {
    const cursor = state.families[family];
    return !cursor.done && !cursor.failed;
  });
  const results = await Promise.all(active.map((family) => fetchFamilyPage(state, family)));

  syncMappingTasks(state);
  const tasks = state.mappings.tasks
    .filter((task) => !task.done && !task.failed)
    .slice(0, MAPPING_CONCURRENCY);
  const mappingResults = await Promise.all(tasks.map((task) => fetchMappingTaskPage(state, task)));

  recompute(state);
  return {
    active: anyActive(state),
    changed: results.some(Boolean) || mappingResults.some(Boolean),
  };
}

/** Clear a failed family or mapping DMO and let the background worker continue. */
export function resumeProgressiveDiscovery(
  state: ProgressiveDiscoveryState,
  family?: ResourceFamily,
): void {
  for (const name of NON_MAPPING_FAMILIES) {
    if (family && family !== name) continue;
    const cursor = state.families[name];
    if (!cursor.failed) continue;
    cursor.failed = false;
    cursor.error = null;
    cursor.errorStatus = 'error';
  }
  if (!family || family === 'mappings') {
    for (const task of state.mappings.tasks) {
      if (!task.failed) continue;
      task.failed = false;
      task.error = null;
      task.errorStatus = 'error';
    }
  }
  state.mappings.failed = false;
  state.mappings.error = null;
  const retryableCodes = new Set(['ERROR', 'FORBIDDEN', 'RETRY_LIMIT', 'MAPPING_QUERY_FAILED']);
  state.warnings = state.warnings.filter((warning) =>
    !retryableCodes.has(warning.code) || (family !== undefined && warning.family !== family));
  recompute(state);
}

export function isProgressiveDiscoveryActive(state: ProgressiveDiscoveryState): boolean {
  return anyActive(state);
}
