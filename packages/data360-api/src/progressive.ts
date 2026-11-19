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
import {
  extractHttpStatus,
  isMappingAbsence,
  isTransientRestFailure,
  MAX_RELATIONSHIP_DMO_QUERIES,
  validateInventorySnapshot,
} from './discover.ts';
import {
  buildData360Path,
  buildDmoRelationshipsPath,
  buildFamilyPath,
  buildMappingPath,
  buildVersionsPath,
  DATA360_ENDPOINT_REGISTRY,
  DMO_PAGE_SIZE,
  isValidDataspace,
  isValidDmoDeveloperName,
} from './endpoints.ts';
import {
  deriveInferredRelationships,
  extractCollection,
  mappingCandidateDmos,
  normalizeDmoRelationships,
  normalizeDataSpaces,
  normalizeDataStreams,
  normalizeDataTransforms,
  normalizeDlos,
  normalizeDmos,
  normalizeMappings,
  parseJsonResponse,
} from './normalize.ts';
import type { NormalizeContext, NormalizedCollection, NormalizedDmos } from './normalize.ts';
import { buildNextPath, extractContinuation, offsetContinuation } from './pagination.ts';
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
const RELATIONSHIP_CONCURRENCY = 4;

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
  degraded: boolean;
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

interface RelationshipTask extends CursorState {
  dmoName: string;
}

interface RelationshipQueryState extends CursorState {
  tasks: RelationshipTask[];
  queuedDmos: string[];
  edges: RelationshipEdge[];
  failedQueries: number;
  limitHit: boolean;
}

export interface ProgressiveDiscoveryState {
  cli: RestClient;
  sessionId: string;
  generation: string;
  signal?: AbortSignal;
  alias: string;
  org: OrgSummary;
  apiVersion: string | null;
  generatedAt: string;
  base: Omit<NormalizeContext, 'apiVersion' | 'endpoint'>;
  options: {
    maxPages: number;
    maxMappingQueries: number;
    maxRelationshipQueries: number;
    retry: PageRetryOptions;
  };
  families: Record<NonMappingFamily, FamilyState>;
  mappings: MappingState;
  relationshipQueries: RelationshipQueryState;
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
  signal?: AbortSignal;
  maxPages?: number;
  maxMappingQueries?: number;
  maxRelationshipQueries?: number;
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
    degraded: false,
    error: null,
    errorStatus: 'error',
    retried: 0,
    skipped: 0,
    seenKeys: [],
  };
}

function makeFamily(family: NonMappingFamily, apiVersion: string): FamilyState {
  return {
    ...makeCursor(buildFamilyPath(family, apiVersion)),
    family,
    items: [],
    relationships: [],
  };
}

function makeMappingTask(dmoName: string, apiVersion: string, dataspace: string | null): MappingTask {
  return { ...makeCursor(buildMappingPath(dmoName, apiVersion, dataspace)), dmoName };
}

function makeRelationshipTask(dmoName: string, apiVersion: string, dataspace: string | null): RelationshipTask {
  return { ...makeCursor(buildDmoRelationshipsPath(dmoName, apiVersion, dataspace)), dmoName };
}

function makeRelationshipQueries(apiVersion: string): RelationshipQueryState {
  return {
    ...makeCursor(buildData360Path('dmos', apiVersion)),
    tasks: [],
    queuedDmos: [],
    edges: [],
    failedQueries: 0,
    limitHit: false,
  };
}

/** Versionless paths for catalog entries that never issued a request. */
function unavailablePath(family: ResourceFamily): string {
  return `services/data${DATA360_ENDPOINT_REGISTRY[family]}`;
}

function unavailableFamily(family: NonMappingFamily): FamilyState {
  return {
    ...makeCursor(unavailablePath(family)),
    family,
    items: [],
    relationships: [],
  };
}

function contextFor(
  state: ProgressiveDiscoveryState,
  family: ResourceFamily,
  retrievedAt = state.generatedAt,
): NormalizeContext {
  const endpoint = family === 'mappings'
    ? state.mappings.basePath
    : state.families[family].basePath;
  return { ...state.base, apiVersion: state.apiVersion ?? '', endpoint, retrievedAt };
}

function contextForRelationshipTask(
  state: ProgressiveDiscoveryState,
  task: RelationshipTask,
): NormalizeContext {
  return {
    ...state.base,
    apiVersion: state.apiVersion ?? '',
    endpoint: task.basePath,
    retrievedAt: new Date().toISOString(),
  };
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
  // Mapping pages come from several DMO tasks, so dedupe against the shared
  // mapping state rather than each task's local page keys.
  const seenKeys = family === 'mappings' ? state.mappings.seenKeys : cursor.seenKeys;
  for (const item of normalized.items) {
    const key = identityFor(family, item);
    if (seenKeys.includes(key)) continue;
    seenKeys.push(key);
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
  cursor.degraded = true;
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
      const raw = await state.cli.restGet(state.alias, cursor.path, { signal: state.signal });
      return parseJsonResponse(raw, label);
    }, state.options.retry);

    const decoded = attempt.value;
    const entries = extractCollection(decoded, label);
    const normalized = normalize(entries, contextFor(state, family, new Date().toISOString()));
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
    const continuation = family === 'dmos'
      ? offsetContinuation(decoded, cursor.path, DMO_PAGE_SIZE, entries.length)
      : extractContinuation(decoded);
    applyContinuation(state, family, cursor, continuation);
    return cursor.pageIndex > before || cursor.done !== false;
  } catch (error) {
    if (family === 'mappings' && isMappingAbsence(error)) {
      cursor.done = true;
      return true;
    }
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

function defaultDataspace(state: ProgressiveDiscoveryState): string | null {
  const spaces = state.families['data-spaces'].items as Array<{ apiName?: string; isDefault?: boolean | null }>;
  return spaces.find((space) => space.isDefault)?.apiName ?? spaces[0]?.apiName ?? null;
}

function syncMappingTasks(state: ProgressiveDiscoveryState): void {
  const dmos = state.families.dmos.items as DataModelObject[];
  const candidates = mappingCandidateDmos(dmos);
  const fallback = defaultDataspace(state);
  for (const dmo of candidates) {
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
    state.mappings.tasks.push(makeMappingTask(name, state.apiVersion ?? '', dmo.dataSpace ?? fallback));
  }

  if (state.families.dmos.done && state.mappings.tasks.length === 0) {
    pushWarning(state, 'mappings', 'MAPPINGS_SKIPPED',
      dmos.length === 0
        ? 'Skipped: no DMOs were found; mapping lookup requires a DMO developer name.'
        : 'Skipped: no enabled or custom DMOs were found; mapping lookup requires an eligible DMO developer name.',
      'info');
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

function syncRelationshipTasks(state: ProgressiveDiscoveryState): void {
  const dmos = state.families.dmos.items as DataModelObject[];
  const candidates = mappingCandidateDmos(dmos);
  const fallback = defaultDataspace(state);
  for (const dmo of candidates) {
    const name = dmo.apiName?.trim();
    if (!name || state.relationshipQueries.queuedDmos.includes(name)) continue;
    const dataspace = dmo.dataSpace ?? fallback;
    if (!isValidDmoDeveloperName(name) || !isValidDataspace(dataspace)) {
      state.relationshipQueries.queuedDmos.push(name);
      pushWarning(state, 'dmos', 'RELATIONSHIP_QUERY_SKIPPED',
        `Relationship lookup skipped for DMO ${name}: its name or data space cannot be used safely in a REST path.`,
        'warning');
      continue;
    }
    if (state.relationshipQueries.tasks.length >= state.options.maxRelationshipQueries) {
      if (!state.relationshipQueries.limitHit) {
        state.relationshipQueries.limitHit = true;
        stopWithWarning(state, 'dmos', state.relationshipQueries,
          'RELATIONSHIP_QUERY_LIMIT',
          `Checked the first ${state.options.maxRelationshipQueries} DMOs; remaining relationship lookups were not attempted.`);
      }
      break;
    }
    state.relationshipQueries.queuedDmos.push(name);
    state.relationshipQueries.tasks.push(makeRelationshipTask(name, state.apiVersion ?? '', dataspace));
  }
}

async function fetchRelationshipTaskPage(
  state: ProgressiveDiscoveryState,
  task: RelationshipTask,
): Promise<boolean> {
  if (task.done || task.failed) return false;
  const before = task.pageIndex;

  try {
    const attempt = await withPageRetry(async () => {
      const raw = await state.cli.restGet(state.alias, task.path, { signal: state.signal });
      return raw.trim() ? parseJsonResponse(raw, 'relationships') : [];
    }, state.options.retry);

    const decoded = attempt.value;
    const entries = extractCollection(decoded, 'relationships');
    const normalized = normalizeDmoRelationships(entries, contextForRelationshipTask(state, task));
    for (const edge of normalized.items) {
      if (!state.relationshipQueries.edges.some((existing) => existing.id === edge.id)) {
        state.relationshipQueries.edges.push(edge);
      }
    }
    task.skipped += normalized.skipped;
    if (attempt.retried) {
      task.retried += 1;
      pushWarning(state, 'dmos', 'RELATIONSHIP_RETRY_SUCCEEDED',
        `Relationship lookup for DMO ${task.dmoName} succeeded after a transient retry.`, 'info');
    }
    const continuation = extractContinuation(decoded);
    applyContinuation(state, 'dmos', task, continuation);
    state.relationshipQueries.pageIndex += task.pageIndex - before;
    state.relationshipQueries.total = Math.max(state.relationshipQueries.total ?? 0, task.total ?? 0) || state.relationshipQueries.total;
    return task.pageIndex > before || task.done !== false;
  } catch (error) {
    task.failed = true;
    const message = safeErrorMessage(error);
    const classified = classifyRestFailure(extractHttpStatus(message), message);
    task.error = `Relationship lookup for DMO ${task.dmoName} failed. ${classified.message}`;
    task.errorStatus = classified.status;
    state.relationshipQueries.failedQueries += 1;
    pushWarning(state, 'dmos', 'RELATIONSHIP_QUERY_FAILED', task.error,
      classified.status === 'unsupported' ? 'warning' : 'error');
    return true;
  }
}

function anyActive(state: ProgressiveDiscoveryState): boolean {
  return NON_MAPPING_FAMILIES.some((family) => {
    const cursor = state.families[family];
    return !cursor.done && !cursor.failed;
  }) || state.mappings.tasks.some((task) => !task.done && !task.failed)
  || state.relationshipQueries.tasks.some((task) => !task.done && !task.failed);
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
    if (active || failed.length > 0 || state.mappings.limitHit || state.mappings.degraded) return 'partial';
    if (tasks.length === 0) return 'not-started';
    return 'available';
  }

  const cursor = state.families[family];
  if (cursor.failed) {
    return cursor.items.length > 0 ? 'partial' : cursor.errorStatus;
  }
  if (cursor.degraded) return 'partial';
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
    const cursorState = family === 'mappings'
      ? state.mappings
      : state.families[family];
    const skippedMappings = family === 'mappings'
      && state.families.dmos.done
      && state.mappings.tasks.length === 0;
    const degradedMessage = status === 'partial' && cursorState.degraded
      ? `${loaded} item(s) loaded; some results may be missing.`
      : null;
    const capability: ApiCapability = {
      family,
      status,
      endpoint: family === 'mappings'
        ? state.mappings.basePath
        : state.families[family].basePath,
      apiVersion: state.apiVersion,
      message: skippedMappings
        ? 'Skipped: no DMOs were found; mapping lookup requires a DMO developer name.'
        : degradedMessage ?? messageForStatus(status, loaded),
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

  const skippedRelationships = state.relationshipQueries.tasks.reduce((count, task) => count + task.skipped, 0);
  if (skippedRelationships > 0) {
    pushWarning(state, 'dmos', 'RELATIONSHIP_ITEMS_SKIPPED',
      `${skippedRelationships} relationship row(s) were skipped because source or target object names were missing.`,
      'warning');
  }

  const dmoContext: NormalizeContext = {
    ...state.base,
    apiVersion: state.apiVersion,
    endpoint: state.families.dmos.basePath,
    retrievedAt: state.generatedAt,
  };
  state.relationships = dedupeEdges([
    ...state.families.dmos.relationships,
    ...state.relationshipQueries.edges,
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
  const failedTask = family === 'mappings'
    ? state.mappings.tasks.find((task) => task.failed)
    : null;
  const error = family === 'mappings'
    ? failedTask?.error ?? null
    : state.families[family].error;
  const errorStatus = family === 'mappings'
    ? failedTask?.errorStatus ?? (state.mappings.failed ? state.mappings.errorStatus : null)
    : state.families[family].failed ? state.families[family].errorStatus : null;

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
    errorStatus,
  };
}

export function discoveryProgress(state: ProgressiveDiscoveryState): DiscoveryProgress {
  const families = RESOURCE_FAMILIES.map((family) => familyProgress(state, family));
  const active = anyActive(state);
  const failed = families.some((entry) => entry.status === 'failed' || Boolean(entry.error));
  const degraded = families.some((entry) => entry.status === 'partial');
  // A partial family with no active cursor is terminal: the browser must stop
  // polling even though the capability truthfully reports missing results.
  const terminal = families.every((entry) => !entry.hasMore && entry.status !== 'running');
  const sessionState: DiscoverySessionState = active ? 'running'
    : failed ? 'failed'
      : terminal ? 'complete'
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
      : active ? 'Loading metadata in small batches.'
        : degraded ? 'Inventory loaded with gaps. Earlier results were kept.'
          : 'All discovered metadata is loaded.',
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

function unavailableState(
  options: ProgressiveDiscoveryOptions,
  message: string,
  status: RetrievalStatus,
): ProgressiveDiscoveryState {
  const generatedAt = new Date().toISOString();
  const sessionId = options.sessionId ?? `session-${Date.now().toString(36)}`;
  const generation = options.generation ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const state: ProgressiveDiscoveryState = {
    cli: options.cli,
    sessionId,
    generation,
    signal: options.signal,
    alias: options.alias,
    org: options.org,
    apiVersion: null,
    generatedAt,
    base: {
      orgId: options.org.orgId ?? options.org.alias,
      orgAlias: options.org.alias,
      retrievedAt: generatedAt,
    },
    options: {
      maxPages: options.maxPages ?? 1_000,
      maxMappingQueries: options.maxMappingQueries ?? 500,
      maxRelationshipQueries: options.maxRelationshipQueries ?? MAX_RELATIONSHIP_DMO_QUERIES,
      retry: retryOptions(options.retry),
    },
    families: {
      'data-spaces': unavailableFamily('data-spaces'),
      dlos: unavailableFamily('dlos'),
      dmos: unavailableFamily('dmos'),
      'data-streams': unavailableFamily('data-streams'),
      'data-transforms': unavailableFamily('data-transforms'),
    },
    mappings: {
      ...makeCursor(unavailablePath('mappings')),
      family: 'mappings',
      items: [],
      tasks: [],
      queuedDmos: [],
      failedQueries: 0,
      limitHit: false,
      done: true,
      failed: true,
      error: message,
      errorStatus: status,
    },
    relationshipQueries: {
      ...makeCursor(unavailablePath('dmos')),
      tasks: [],
      queuedDmos: [],
      edges: [],
      failedQueries: 0,
      limitHit: false,
      done: true,
      failed: true,
      error: message,
      errorStatus: status,
    },
    capabilities: [{
      family: 'api-versions',
      status,
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
      severity: status === 'unsupported' ? 'warning' : 'error',
    }],
    relationships: [],
  };
  for (const family of RESOURCE_FAMILIES) {
    state.capabilities.push({
      family,
      status,
      endpoint: unavailablePath(family),
      apiVersion: null,
      message: 'API version could not be discovered; no metadata was requested.',
      durationMs: null,
      itemCount: null,
    });
  }
  for (const family of NON_MAPPING_FAMILIES) {
    const cursor = state.families[family];
    cursor.done = true;
    cursor.failed = true;
    cursor.error = message;
    cursor.errorStatus = status;
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
    return unavailableState({ ...options, sessionId, generation }, classified.message, classified.status);
  }

  const state: ProgressiveDiscoveryState = {
    cli: options.cli,
    sessionId,
    generation,
    signal: options.signal,
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
      maxRelationshipQueries: options.maxRelationshipQueries ?? MAX_RELATIONSHIP_DMO_QUERIES,
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
    relationshipQueries: makeRelationshipQueries(apiVersion),
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
  if (!state.apiVersion || state.signal?.aborted) return { active: false, changed: false };

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

  syncRelationshipTasks(state);
  const relationshipTasks = state.relationshipQueries.tasks
    .filter((task) => !task.done && !task.failed)
    .slice(0, RELATIONSHIP_CONCURRENCY);
  const relationshipResults = await Promise.all(relationshipTasks.map((task) => fetchRelationshipTaskPage(state, task)));

  const changed = results.some(Boolean) || mappingResults.some(Boolean) || relationshipResults.some(Boolean);
  // Freshness follows the most recently loaded page, not the session start.
  if (changed) state.generatedAt = new Date().toISOString();
  recompute(state);
  return {
    active: anyActive(state),
    changed,
  };
}

/** Clear a transiently failed family and let the background worker continue. */
export function resumeProgressiveDiscovery(
  state: ProgressiveDiscoveryState,
  family?: ResourceFamily,
): void {
  const clearedFamilies = new Set<string>();
  for (const name of NON_MAPPING_FAMILIES) {
    if (family && family !== name) continue;
    const cursor = state.families[name];
    // Forbidden and unsupported gaps are property of the org, not a retryable
    // failure. Clearing them would hide a real capability hole.
    if (!cursor.failed || cursor.errorStatus !== 'error') continue;
    cursor.failed = false;
    cursor.error = null;
    cursor.errorStatus = 'error';
    clearedFamilies.add(name);
  }
  if (!family || family === 'mappings') {
    for (const task of state.mappings.tasks) {
      if (!task.failed || task.errorStatus !== 'error') continue;
      task.failed = false;
      task.error = null;
      task.errorStatus = 'error';
      clearedFamilies.add('mappings');
    }
    if (state.mappings.failed && state.mappings.errorStatus === 'error') {
      state.mappings.failed = false;
      state.mappings.error = null;
      clearedFamilies.add('mappings');
    }
  }
  if (!family || family === 'dmos') {
    for (const task of state.relationshipQueries.tasks) {
      if (!task.failed || task.errorStatus !== 'error') continue;
      task.failed = false;
      task.error = null;
      task.errorStatus = 'error';
      clearedFamilies.add('dmos');
    }
    if (state.relationshipQueries.failed && state.relationshipQueries.errorStatus === 'error') {
      state.relationshipQueries.failed = false;
      state.relationshipQueries.error = null;
      clearedFamilies.add('dmos');
    }
    state.relationshipQueries.failedQueries = state.relationshipQueries.tasks.filter((task) => task.failed).length;
  }
  const retryableCodes = new Set([
    'ERROR',
    'RETRY_LIMIT',
    'MAPPING_QUERY_FAILED',
    'RELATIONSHIP_QUERY_FAILED',
  ]);
  state.warnings = state.warnings.filter((warning) =>
    !clearedFamilies.has(warning.family) || !retryableCodes.has(warning.code));
  recompute(state);
}

export function isProgressiveDiscoveryActive(state: ProgressiveDiscoveryState): boolean {
  return anyActive(state);
}
