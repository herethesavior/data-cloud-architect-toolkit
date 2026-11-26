import type {
  ApiCapability,
  ApiVersionSelection,
  DataMapping,
  InventorySnapshot,
  OrgSummary,
  RelationshipEdge,
  ResourceFamily,
  RetrievalWarning,
} from '@dcat/core';
import { RESOURCE_FAMILIES, inventorySnapshotSchema } from '@dcat/core';
import { CliError, safeErrorMessage } from '@dcat/salesforce-cli';
import { classifyRestFailure, extractHttpStatus, isOutputLimitMessage } from './capabilities.ts';
import { enrichStreamConnectors } from './connectors.ts';
import {
  buildData360Path,
  buildDmoRelationshipsPath,
  buildFamilyPath,
  buildMappingPath,
  buildVersionsPath,
  DATA360_ENDPOINT_REGISTRY,
  isValidDataspace,
  isValidDmoDeveloperName,
  offsetPageSizeFor,
} from './endpoints.ts';
import {
  deriveInferredRelationships,
  extractCollection,
  normalizeDmoRelationships,
  normalizeDataSpaces,
  normalizeDataStreams,
  normalizeDataTransforms,
  normalizeDlos,
  normalizeDmos,
  normalizeMappings,
  parseJsonResponse,
  mappingCandidateDmos,
} from './normalize.ts';
import type { NormalizeContext, NormalizedCollection, NormalizedDmos } from './normalize.ts';
import { buildNextPath, extractContinuation, offsetContinuation } from './pagination.ts';
import { describeApiVersionResult, resolveApiVersion, type ResolvedApiVersion } from './versions.ts';

// A high safety ceiling rather than a result limit. Progressive discovery uses
// checkpoints and stops on exhaustion; this only guards against a looping token.
export const DEFAULT_MAX_PAGES = 1_000;
export const MAX_MAPPING_DMO_QUERIES = 500;
export const MAX_RELATIONSHIP_DMO_QUERIES = 500;

/** Minimal surface the discovery layer needs; the CLI adapter satisfies it. */
export interface RestClient {
  restGet(alias: string, path: string, options?: { signal?: AbortSignal }): Promise<string>;
}

export interface DiscoverOptions {
  cli: RestClient;
  alias: string;
  org: OrgSummary;
  maxPages?: number;
  apiVersionSelection?: ApiVersionSelection;
  onApiVersionResolved?: (result: ResolvedApiVersion) => void;
}

export { extractHttpStatus } from './capabilities.ts';

/** Backward-compatible helper for callers that only need the opaque cursor. */
export function extractContinuationToken(value: unknown): string | null {
  const continuation = extractContinuation(value);
  return continuation.cursor ?? continuation.nextPath;
}

/**
 * A mapping lookup with a valid DMO name can return NOT_FOUND when that DMO has
 * no object-source-target maps. That is an empty result, not a failed family.
 */
export function isMappingAbsence(error: unknown): boolean {
  const message = safeErrorMessage(error);
  return /\bNOT_FOUND\b/i.test(message)
    && /object\s+source\s+target\s+map|no\s+mappings?\s+(?:found|for)|not\s+found\s+for\s+the\s+given\s+target\s+object/i.test(message);
}

export interface FetchedCollection {
  entries: unknown[];
  warnings: string[];
}

export async function fetchCollection(
  cli: RestClient,
  alias: string,
  path: string,
  label: string,
  maxPages: number,
  offsetPageSize?: number,
  allowEmptyBody = false,
): Promise<FetchedCollection> {
  const entries: unknown[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let requestPath = path;
  let pages = 0;

  while (pages < maxPages) {
    const raw = await cli.restGet(alias, requestPath);
    // Salesforce answers a DMO with no relationships as 204 No Content.
    const decoded = allowEmptyBody && !raw.trim() ? [] : parseJsonResponse(raw, label);
    const pageEntries = extractCollection(decoded, label);
    for (const entry of pageEntries) {
      const key = JSON.stringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
    pages += 1;

    const continuation = offsetPageSize === undefined
      ? extractContinuation(decoded)
      : offsetContinuation(decoded, requestPath, offsetPageSize, pageEntries.length);
    if (!continuation.hasMore) break;
    if (continuation.uncertain || (!continuation.cursor && !continuation.nextPath)) {
      warnings.push('The response reported more results but did not include a usable continuation cursor.');
      break;
    }
    if (pages >= maxPages) {
      warnings.push(`Pagination stopped after ${maxPages} page(s); results may be incomplete.`);
      break;
    }
    const nextPath = buildNextPath(requestPath, continuation);
    if (continuation.nextPath && nextPath === requestPath) {
      warnings.push('The response pointed to a different REST endpoint; that continuation was ignored.');
      break;
    }
    requestPath = nextPath;
  }

  return { entries, warnings };
}

/** One retry for transient failures only: no sleeps, no unbounded loops. */
export const MAX_FAMILY_ATTEMPTS = 2;

export function isTransientRestFailure(error: unknown): boolean {
  const message = safeErrorMessage(error);
  const classified = classifyRestFailure(extractHttpStatus(message), message);
  if (classified.status !== 'error') return false;
  if (error instanceof CliError && error.code === 'TIMEOUT') return true;
  const status = extractHttpStatus(message);
  if (status === 408 || status === 425 || status === 429 || (status !== null && status >= 500)) return true;
  return /timed?\s*out|timeout|network|temporar(?:y|ily)|rate limit|throttl|service unavailable|try again|econnreset|socket hang up/i.test(message);
}

export interface BoundedRetryResult<T> {
  value: T;
  attempts: number;
  retried: boolean;
}

export async function withBoundedRetry<T>(
  operation: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean = isTransientRestFailure,
  maxAttempts = MAX_FAMILY_ATTEMPTS,
): Promise<BoundedRetryResult<T>> {
  const allowed = Math.max(1, Math.min(MAX_FAMILY_ATTEMPTS, maxAttempts));
  let lastError: unknown;
  for (let attempt = 1; attempt <= allowed; attempt += 1) {
    try {
      return { value: await operation(), attempts: attempt, retried: attempt > 1 };
    } catch (error) {
      lastError = error;
      if (attempt >= allowed || !shouldRetry(error)) break;
    }
  }
  throw lastError;
}

interface FamilyResult<T extends NormalizedCollection<unknown>> {
  result: T;
  capability: ApiCapability;
  warnings: RetrievalWarning[];
}

async function retrieveFamily<T, N extends NormalizedCollection<T>>(
  cli: RestClient,
  alias: string,
  family: ResourceFamily,
  apiVersion: string,
  base: Omit<NormalizeContext, 'apiVersion' | 'endpoint'>,
  normalizer: (raw: unknown, context: NormalizeContext) => N,
  maxPages: number,
): Promise<FamilyResult<N>> {
  const endpoint = buildFamilyPath(family, apiVersion);
  const context: NormalizeContext = { ...base, apiVersion, endpoint };
  const started = Date.now();

  try {
    const attempt = await withBoundedRetry(() => fetchCollection(
      cli,
      alias,
      endpoint,
      family,
      maxPages,
      offsetPageSizeFor(family) ?? undefined,
    ));
    const fetched = attempt.value;
    const normalized = normalizer(fetched.entries, context);
    const dataWarnings: RetrievalWarning[] = fetched.warnings.map((message) => ({
      family,
      code: message.startsWith('Pagination stopped') ? 'PAGINATION_LIMIT' : 'CONTINUATION_MISSING',
      message,
      severity: 'warning',
    }));
    if (normalized.skipped > 0) {
      dataWarnings.push({
        family,
        code: 'ITEMS_SKIPPED',
        message: `${normalized.skipped} item(s) were skipped because required identifying fields were missing.`,
        severity: 'warning',
      });
    }
    const warnings: RetrievalWarning[] = [
      ...(attempt.retried ? [{
        family,
        code: 'RETRY_SUCCEEDED',
        message: `Retrieved after ${attempt.attempts} attempts following a transient failure.`,
        severity: 'info' as const,
      }] : []),
      ...dataWarnings,
    ];

    return {
      result: normalized,
      capability: {
        family,
        status: dataWarnings.length > 0 ? 'partial' : 'available',
        endpoint,
        apiVersion,
        message: dataWarnings.length > 0 ? 'Retrieved with warnings.' : 'Retrieved successfully.',
        durationMs: Date.now() - started,
        itemCount: normalized.items.length,
      },
      warnings,
    };
  } catch (error) {
    const message = safeErrorMessage(error);
    const classified = classifyRestFailure(extractHttpStatus(message), message);
    const warnings: RetrievalWarning[] = [{
      family,
      code: isOutputLimitMessage(message) ? 'OUTPUT_LIMIT' : classified.status.toUpperCase(),
      message: classified.message,
      severity: classified.status === 'unsupported' ? 'warning' : 'error',
    }];
    if (isTransientRestFailure(error)) {
      warnings.push({
        family,
        code: 'RETRY_LIMIT',
        message: `Retried once after a transient failure; retrieval is still unavailable. ${classified.message}`,
        severity: 'warning',
      });
    }
    return {
      result: normalizer([], context),
      capability: {
        family,
        status: classified.status,
        endpoint,
        apiVersion,
        message: classified.message,
        durationMs: Date.now() - started,
        itemCount: null,
      },
      warnings,
    };
  }
}

function mappingIdentity(mapping: DataMapping): string {
  const fields = mapping.fieldMappings
    .map((field) => `${field.sourceField}->${field.targetField}`)
    .join(',');
  return `${mapping.apiName ?? ''}|${mapping.sourceObject}|${mapping.targetObject}|${fields}`;
}

function skippedMappings(
  apiVersion: string,
  base: Omit<NormalizeContext, 'apiVersion' | 'endpoint'>,
  dmoCapability: ApiCapability,
  reason: 'no-dmos' | 'no-eligible-dmos' = 'no-dmos',
): FamilyResult<NormalizedCollection<DataMapping>> {
  const dmosConfirmed = dmoCapability.status === 'available' || dmoCapability.status === 'partial';
  const message = reason === 'no-eligible-dmos'
    ? 'Skipped: no enabled or custom DMOs were found; mapping lookup requires an eligible DMO developer name.'
    : dmosConfirmed
      ? 'Skipped: no DMOs were found; mapping lookup requires a DMO developer name.'
      : 'Skipped: DMO lookup was unavailable; mapping lookup requires a DMO developer name.';
  // Keep a failed or disabled DMO lookup visible instead of reporting a
  // permissions/API failure as a routine "Not started" mapping skip.
  const inheritedStatus = dmoCapability.status === 'unsupported'
    || dmoCapability.status === 'forbidden'
    || dmoCapability.status === 'error'
    ? dmoCapability.status
    : 'not-started';
  const status: ApiCapability['status'] = dmosConfirmed ? 'not-started' : inheritedStatus;
  const warningCode = status === 'unsupported' ? 'UNSUPPORTED'
    : status === 'forbidden' ? 'FORBIDDEN'
      : status === 'error' ? 'ERROR'
        : 'MAPPINGS_SKIPPED';
  const warningSeverity = status === 'not-started' ? 'info'
    : status === 'unsupported' ? 'warning' : 'error';
  return {
    result: { items: [], skipped: 0 },
    capability: {
      family: 'mappings',
      status,
      endpoint: buildData360Path('mappings', apiVersion),
      apiVersion,
      message: status === 'not-started' ? message : (dmoCapability.message ?? message),
      durationMs: 0,
      itemCount: 0,
    },
    warnings: [{ family: 'mappings', code: warningCode, message: status === 'not-started' ? message : (dmoCapability.message ?? message), severity: warningSeverity }],
  };
}

/**
 * Salesforce rejects an unfiltered mapping lookup. Query one allowlisted,
 * encoded dmoDeveloperName at a time and merge the grounded results.
 */
interface MappingCandidate {
  apiName: string;
  dataspace: string | null;
}

async function retrieveMappingsByDmo(
  cli: RestClient,
  alias: string,
  apiVersion: string,
  base: Omit<NormalizeContext, 'apiVersion' | 'endpoint'>,
  candidates: MappingCandidate[],
  maxPages: number,
): Promise<FamilyResult<NormalizedCollection<DataMapping>>> {
  const started = Date.now();
  const endpoint = buildData360Path('mappings', apiVersion);
  const context: NormalizeContext = { ...base, apiVersion, endpoint };
  const uniqueApiNames = [
    ...new Map(candidates
      .filter((candidate) => candidate.apiName.trim().length > 0)
      .map((candidate) => [candidate.apiName, candidate])).values(),
  ];
  const queried = uniqueApiNames.slice(0, MAX_MAPPING_DMO_QUERIES);
  const items: DataMapping[] = [];
  const warnings: RetrievalWarning[] = [];
  const failures: ReturnType<typeof classifyRestFailure>[] = [];
  let skipped = 0;
  let retriedQueries = 0;

  for (const candidate of queried) {
    const apiName = candidate.apiName;
    const path = buildMappingPath(apiName, apiVersion, candidate.dataspace);
    try {
      const attempt = await withBoundedRetry(() => fetchCollection(cli, alias, path, 'mappings', maxPages));
      const normalized = normalizeMappings(attempt.value.entries, context);
      items.push(...normalized.items);
      skipped += normalized.skipped;
      if (attempt.retried) retriedQueries += 1;
      warnings.push(...attempt.value.warnings.map((message) => ({
        family: 'mappings' as const,
        code: message.startsWith('Pagination stopped') ? 'PAGINATION_LIMIT' : 'CONTINUATION_MISSING',
        message,
        severity: 'warning' as const,
      })));
    } catch (error) {
      if (isMappingAbsence(error)) continue;
      const message = safeErrorMessage(error);
      const classified = classifyRestFailure(extractHttpStatus(message), message);
      failures.push(classified);
      warnings.push({
        family: 'mappings',
        code: classified.status.toUpperCase(),
        message: `Mapping lookup for DMO ${apiName} failed. ${classified.message}`,
        severity: classified.status === 'unsupported' ? 'warning' : 'error',
      });
    }
  }

  const seen = new Set<string>();
  const deduped = items.filter((mapping) => {
    const key = mappingIdentity(mapping);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (retriedQueries > 0) {
    warnings.push({
      family: 'mappings',
      code: 'RETRY_SUCCEEDED',
      message: `${retriedQueries} mapping lookup(s) succeeded after a transient retry.`,
      severity: 'info',
    });
  }
  if (skipped > 0) {
    warnings.push({
      family: 'mappings',
      code: 'ITEMS_SKIPPED',
      message: `${skipped} mapping item(s) were skipped because required identifying fields were missing.`,
      severity: 'warning',
    });
  }
  if (uniqueApiNames.length > queried.length) {
    warnings.push({
      family: 'mappings',
      code: 'MAPPING_QUERY_LIMIT',
      message: `Checked the first ${MAX_MAPPING_DMO_QUERIES} DMOs; remaining mapping lookups were not attempted.`,
      severity: 'warning',
    });
  }

  const allFailed = failures.length > 0 && failures.length === queried.length;
  const status: ApiCapability['status'] = allFailed
    ? failures.every((failure) => failure.status === 'unsupported')
      ? 'unsupported'
      : failures.every((failure) => failure.status === 'forbidden')
        ? 'forbidden'
        : 'error'
    : warnings.some((warning) => warning.severity !== 'info')
      ? 'partial'
      : 'available';
  const message = allFailed
    ? (failures[0]?.message ?? 'Mapping lookup failed.')
    : status === 'partial'
      ? 'Retrieved mappings with warnings.'
      : 'Retrieved successfully.';

  return {
    result: { items: deduped, skipped },
    capability: {
      family: 'mappings',
      status,
      endpoint,
      apiVersion,
      message,
      durationMs: Date.now() - started,
      itemCount: deduped.length,
    },
    warnings,
  };
}

interface RelationshipQueryResult {
  edges: RelationshipEdge[];
  warnings: RetrievalWarning[];
}

/**
 * v68 has only a per-DMO relationship endpoint. Query the DMOs the source marks
 * as usable; a row's own sourceObject/targetObject decide direction, so the same
 * edge can be returned by either endpoint and must be deduplicated.
 */
async function retrieveRelationshipsByDmo(
  cli: RestClient,
  alias: string,
  apiVersion: string,
  base: Omit<NormalizeContext, 'apiVersion' | 'endpoint'>,
  candidates: MappingCandidate[],
  maxPages: number,
): Promise<RelationshipQueryResult> {
  const unique = [
    ...new Map(candidates
      .filter((candidate) => candidate.apiName.trim().length > 0)
      .map((candidate) => [candidate.apiName, candidate])).values(),
  ];
  const queried = unique.slice(0, MAX_RELATIONSHIP_DMO_QUERIES);
  const edges: RelationshipEdge[] = [];
  const warnings: RetrievalWarning[] = [];
  let skipped = 0;
  let skippedQueries = 0;
  let attempts = 0;
  let failures = 0;
  let retried = 0;

  for (const candidate of queried) {
    if (!isValidDmoDeveloperName(candidate.apiName) || !isValidDataspace(candidate.dataspace)) {
      skippedQueries += 1;
      warnings.push({
        family: 'dmos',
        code: 'RELATIONSHIP_QUERY_SKIPPED',
        message: `Relationship lookup skipped for DMO ${candidate.apiName}: its name or data space cannot be used safely in a REST path.`,
        severity: 'warning',
      });
      continue;
    }
    const path = buildDmoRelationshipsPath(candidate.apiName, apiVersion, candidate.dataspace);
    const context: NormalizeContext = { ...base, apiVersion, endpoint: path };
    attempts += 1;
    try {
      const attempt = await withBoundedRetry(() =>
        fetchCollection(cli, alias, path, 'relationships', maxPages, undefined, true));
      const normalized = normalizeDmoRelationships(attempt.value.entries, context);
      edges.push(...normalized.items);
      skipped += normalized.skipped;
      if (attempt.retried) retried += 1;
      warnings.push(...attempt.value.warnings.map((message) => ({
        family: 'dmos' as const,
        code: message.startsWith('Pagination stopped') ? 'RELATIONSHIP_PAGINATION_LIMIT' : 'RELATIONSHIP_CONTINUATION_MISSING',
        message: `Relationship lookup for DMO ${candidate.apiName}: ${message}`,
        severity: 'warning' as const,
      })));
    } catch (error) {
      failures += 1;
      const message = safeErrorMessage(error);
      const classified = classifyRestFailure(extractHttpStatus(message), message);
      warnings.push({
        family: 'dmos',
        code: 'RELATIONSHIP_QUERY_FAILED',
        message: `Relationship lookup for DMO ${candidate.apiName} failed. ${classified.message}`,
        severity: classified.status === 'unsupported' ? 'warning' : 'error',
      });
    }
  }

  if (retried > 0) {
    warnings.push({
      family: 'dmos',
      code: 'RELATIONSHIP_RETRY_SUCCEEDED',
      message: `${retried} relationship lookup(s) succeeded after a transient retry.`,
      severity: 'info',
    });
  }
  if (skipped > 0) {
    warnings.push({
      family: 'dmos',
      code: 'RELATIONSHIP_ITEMS_SKIPPED',
      message: `${skipped} relationship row(s) were skipped because source or target object names were missing.`,
      severity: 'warning',
    });
  }
  if (skippedQueries > 0) {
    warnings.push({
      family: 'dmos',
      code: 'RELATIONSHIP_QUERIES_SKIPPED',
      message: `${skippedQueries} relationship lookup(s) were skipped because the DMO name or data space could not be used safely in a REST path.`,
      severity: 'warning',
    });
  }
  if (unique.length > queried.length) {
    warnings.push({
      family: 'dmos',
      code: 'RELATIONSHIP_QUERY_LIMIT',
      message: `Checked the first ${MAX_RELATIONSHIP_DMO_QUERIES} DMOs; remaining relationship lookups were not attempted.`,
      severity: 'warning',
    });
  }
  if (attempts > 0 && failures === attempts) {
    warnings.push({
      family: 'dmos',
      code: 'RELATIONSHIPS_UNAVAILABLE',
      message: 'No DMO relationship lookups succeeded; relationship edges may be incomplete.',
      severity: 'warning',
    });
  }

  return { edges, warnings };
}

function dedupeRelationships(edges: RelationshipEdge[]): RelationshipEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    if (seen.has(edge.id)) return false;
    seen.add(edge.id);
    return true;
  });
}

export function validateInventorySnapshot(snapshot: InventorySnapshot): InventorySnapshot {
  const parsed = inventorySnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new CliError(
      'UNEXPECTED_RESPONSE',
      `The discovered inventory failed validation: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
    );
  }
  return parsed.data;
}

export async function discoverInventory(options: DiscoverOptions): Promise<InventorySnapshot> {
  const { cli, alias, org, maxPages = DEFAULT_MAX_PAGES } = options;
  const generatedAt = new Date().toISOString();
  const capabilities: ApiCapability[] = [];
  const warnings: RetrievalWarning[] = [];
  const base = {
    orgId: org.orgId ?? org.alias,
    orgAlias: org.alias,
    retrievedAt: generatedAt,
  };

  const versionsPath = buildVersionsPath();
  const versionsStarted = Date.now();
  const resolved = await resolveApiVersion(
    () => cli.restGet(alias, versionsPath),
    options.apiVersionSelection,
    options.onApiVersionResolved,
  );
  const described = describeApiVersionResult(resolved);
  capabilities.push({
    family: 'api-versions',
    status: resolved.apiVersion ? 'available' : resolved.probe.status,
    endpoint: versionsPath,
    apiVersion: resolved.apiVersion,
    message: described.message,
    durationMs: Date.now() - versionsStarted,
    itemCount: null,
  });

  if (!resolved.apiVersion) {
    warnings.push({
      family: 'api-versions',
      code: 'API_VERSION_UNAVAILABLE',
      message: `API version discovery failed. ${resolved.probe.message}`,
      severity: 'error',
    });
    const unavailableStatus = resolved.probe.status === 'unsupported' ? 'unsupported' : 'error';
    for (const family of RESOURCE_FAMILIES) {
      capabilities.push({
        family,
        status: unavailableStatus,
        endpoint: DATA360_ENDPOINT_REGISTRY[family],
        apiVersion: null,
        message: 'No API version could be selected; no metadata was requested.',
        durationMs: null,
        itemCount: null,
      });
    }
    return validateInventorySnapshot({
      org,
      apiVersion: null,
      generatedAt,
      mode: 'live',
      capabilities,
      dataSpaces: [],
      dlos: [],
      dmos: [],
      mappings: [],
      dataStreams: [],
      dataTransforms: [],
      relationships: [],
      warnings,
    });
  }

  if (described.warning) {
    warnings.push({
      family: 'api-versions',
      code: 'API_VERSION_PROBE_UNAVAILABLE',
      message: described.warning,
      severity: 'warning',
    });
  }

  const version = resolved.apiVersion;
  const [spaces, dlos, dmos, streams, transforms] = await Promise.all([
    retrieveFamily(cli, alias, 'data-spaces', version, base, normalizeDataSpaces, maxPages),
    retrieveFamily(cli, alias, 'dlos', version, base, normalizeDlos, maxPages),
    retrieveFamily(cli, alias, 'dmos', version, base, normalizeDmos, maxPages),
    retrieveFamily(cli, alias, 'data-streams', version, base, normalizeDataStreams, maxPages),
    retrieveFamily(cli, alias, 'data-transforms', version, base, normalizeDataTransforms, maxPages),
  ]);

  // Mapping metadata needs a DMO developer name. Query only DMOs the source
  // marks as usable; unused standard DMOs answer NOT_FOUND and would otherwise
  // fill Needs attention with false failures.
  const defaultDataspace = spaces.result.items.find((space) => space.isDefault)?.apiName
    ?? spaces.result.items[0]?.apiName
    ?? null;
  const candidateDmos = mappingCandidateDmos(dmos.result.items);
  const mappingCandidates: MappingCandidate[] = candidateDmos.map((dmo) => ({
    apiName: dmo.apiName,
    dataspace: dmo.dataSpace ?? defaultDataspace,
  }));
  const mappings = dmos.result.items.length === 0
    ? skippedMappings(version, base, dmos.capability)
    : mappingCandidates.length === 0
      ? skippedMappings(version, base, dmos.capability, 'no-eligible-dmos')
      : await retrieveMappingsByDmo(cli, alias, version, base, mappingCandidates, maxPages);
  const relationshipQueries = mappingCandidates.length === 0
    ? { edges: [], warnings: [] }
    : await retrieveRelationshipsByDmo(cli, alias, version, base, mappingCandidates, maxPages);

  const enrichedStreams = await enrichStreamConnectors({
    cli,
    alias,
    apiVersion: version,
    streams: streams.result.items,
    retrievedAt: generatedAt,
  });

  capabilities.push(
    spaces.capability,
    dlos.capability,
    dmos.capability,
    mappings.capability,
    streams.capability,
    transforms.capability,
  );
  warnings.push(
    ...enrichedStreams.warnings,
    ...spaces.warnings,
    ...dlos.warnings,
    ...dmos.warnings,
    ...mappings.warnings,
    ...relationshipQueries.warnings,
    ...streams.warnings,
    ...transforms.warnings,
  );

  const dmoContext: NormalizeContext = {
    ...base,
    apiVersion: version,
    endpoint: buildFamilyPath('dmos', version),
  };
  const relationships = dedupeRelationships([
    ...dmos.result.relationships,
    ...relationshipQueries.edges,
    ...deriveInferredRelationships(dmos.result.items, dmoContext),
  ]);

  return validateInventorySnapshot({
    org,
    apiVersion: version,
    generatedAt,
    mode: 'live',
    capabilities,
    dataSpaces: spaces.result.items,
    dlos: dlos.result.items,
    dmos: dmos.result.items,
    mappings: mappings.result.items,
    dataStreams: enrichedStreams.streams,
    dataTransforms: transforms.result.items,
    relationships,
    warnings,
  });
}
