import type {
  ApiCapability,
  DataMapping,
  InventorySnapshot,
  OrgSummary,
  RelationshipEdge,
  ResourceFamily,
  RetrievalWarning,
} from '@dcat/core';
import { RESOURCE_FAMILIES, inventorySnapshotSchema } from '@dcat/core';
import { CliError, safeErrorMessage } from '@dcat/salesforce-cli';
import { classifyRestFailure } from './capabilities.ts';
import { buildData360Path, buildMappingPath, buildVersionsPath, DATA360_ENDPOINT_REGISTRY } from './endpoints.ts';
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

// A high safety ceiling rather than a result limit. Progressive discovery uses
// checkpoints and stops on exhaustion; this only guards against a looping token.
export const DEFAULT_MAX_PAGES = 1_000;
export const MAX_MAPPING_DMO_QUERIES = 500;

/** Minimal surface the discovery layer needs; the CLI adapter satisfies it. */
export interface RestClient {
  restGet(alias: string, path: string, options?: { signal?: AbortSignal }): Promise<string>;
}

export interface DiscoverOptions {
  cli: RestClient;
  alias: string;
  org: OrgSummary;
  maxPages?: number;
}

/** Pull a numeric HTTP status out of a redacted CLI error message when present. */
export function extractHttpStatus(message: string): number | null {
  const patterns = [
    /\b(?:http\s+)?status(?:\s+code)?\s*[:=]?\s*([45]\d{2})\b/i,
    /\b(?:exit(?:ed)?(?:\s+with)?\s+code|error\s+code)\s*[:=]?\s*([45]\d{2})\b/i,
    /\((\d{3})\)/,
    /\b([45]\d{2})\s+(?:Forbidden|Unauthorized|Not Found|Bad Request|Server Error|error)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (!match) continue;
    const status = Number(match[1]);
    if (status >= 400 && status <= 599) return status;
  }
  return null;
}

/** Backward-compatible helper for callers that only need the opaque cursor. */
export function extractContinuationToken(value: unknown): string | null {
  const continuation = extractContinuation(value);
  return continuation.cursor ?? continuation.nextPath;
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
): Promise<FetchedCollection> {
  const entries: unknown[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let requestPath = path;
  let pages = 0;

  while (pages < maxPages) {
    const decoded = parseJsonResponse(await cli.restGet(alias, requestPath), label);
    for (const entry of extractCollection(decoded, label)) {
      const key = JSON.stringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
    pages += 1;

    const continuation = extractContinuation(decoded);
    if (!continuation.hasMore) break;
    if (continuation.uncertain || (!continuation.cursor && !continuation.nextPath)) {
      warnings.push('The response reported more results but did not include a usable continuation cursor.');
      break;
    }
    if (pages >= maxPages) {
      warnings.push(`Pagination stopped after ${maxPages} page(s); results may be incomplete.`);
      break;
    }
    requestPath = buildNextPath(requestPath, continuation);
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
  const endpoint = buildData360Path(family, apiVersion);
  const context: NormalizeContext = { ...base, apiVersion, endpoint };
  const started = Date.now();

  try {
    const attempt = await withBoundedRetry(() => fetchCollection(cli, alias, endpoint, family, maxPages));
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
      code: classified.status.toUpperCase(),
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
): FamilyResult<NormalizedCollection<DataMapping>> {
  const dmosConfirmed = dmoCapability.status === 'available' || dmoCapability.status === 'partial';
  const message = dmosConfirmed
    ? 'Skipped: no DMOs were found; mapping lookup requires a DMO developer name.'
    : 'Skipped: DMO lookup was unavailable; mapping lookup requires a DMO developer name.';
  // Preserve a Data 360 disablement across every family instead of hiding it
  // behind a generic skip when DMO discovery itself reported unsupported.
  const status: ApiCapability['status'] = !dmosConfirmed && dmoCapability.status === 'unsupported'
    ? 'unsupported'
    : 'not-started';
  return {
    result: { items: [], skipped: 0 },
    capability: {
      family: 'mappings',
      status,
      endpoint: buildData360Path('mappings', apiVersion),
      apiVersion,
      message: status === 'unsupported'
        ? (dmoCapability.message ?? message)
        : message,
      durationMs: 0,
      itemCount: 0,
    },
    warnings: [dmosConfirmed
      ? { family: 'mappings', code: 'MAPPINGS_SKIPPED', message, severity: 'info' }
      : { family: 'mappings', code: status === 'unsupported' ? 'UNSUPPORTED' : 'MAPPINGS_SKIPPED', message, severity: status === 'unsupported' ? 'warning' : 'info' }],
  };
}

/**
 * Salesforce rejects an unfiltered mapping lookup. Query one allowlisted,
 * encoded dmoDeveloperName at a time and merge the grounded results.
 */
async function retrieveMappingsByDmo(
  cli: RestClient,
  alias: string,
  apiVersion: string,
  base: Omit<NormalizeContext, 'apiVersion' | 'endpoint'>,
  dmoApiNames: string[],
  maxPages: number,
): Promise<FamilyResult<NormalizedCollection<DataMapping>>> {
  const started = Date.now();
  const endpoint = buildData360Path('mappings', apiVersion);
  const context: NormalizeContext = { ...base, apiVersion, endpoint };
  const uniqueApiNames = [...new Set(dmoApiNames.filter((name) => name.trim().length > 0))];
  const queried = uniqueApiNames.slice(0, MAX_MAPPING_DMO_QUERIES);
  const items: DataMapping[] = [];
  const warnings: RetrievalWarning[] = [];
  const failures: ReturnType<typeof classifyRestFailure>[] = [];
  let skipped = 0;
  let retriedQueries = 0;

  for (const apiName of queried) {
    const path = buildMappingPath(apiName, apiVersion);
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
  let apiVersion: string | null = null;
  try {
    apiVersion = selectLatestApiVersion(await cli.restGet(alias, versionsPath));
    capabilities.push({
      family: 'api-versions',
      status: 'available',
      endpoint: versionsPath,
      apiVersion,
      message: `Using API version ${apiVersion}.`,
      durationMs: Date.now() - versionsStarted,
      itemCount: null,
    });
  } catch (error) {
    const message = safeErrorMessage(error);
    const classified = classifyRestFailure(extractHttpStatus(message), message);
    capabilities.push({
      family: 'api-versions',
      status: classified.status,
      endpoint: versionsPath,
      apiVersion: null,
      message: classified.message,
      durationMs: Date.now() - versionsStarted,
      itemCount: null,
    });
    warnings.push({
      family: 'api-versions',
      code: 'API_VERSION_UNAVAILABLE',
      message: `API version discovery failed. ${classified.message}`,
      severity: 'error',
    });
  }

  if (!apiVersion) {
    const unavailableStatus = capabilities[0]?.status === 'unsupported' ? 'unsupported' : 'error';
    for (const family of RESOURCE_FAMILIES) {
      capabilities.push({
        family,
        status: unavailableStatus,
        endpoint: DATA360_ENDPOINT_REGISTRY[family],
        apiVersion: null,
        message: 'API version could not be discovered; no metadata was requested.',
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

  const version = apiVersion;
  const [spaces, dlos, dmos, streams, transforms] = await Promise.all([
    retrieveFamily(cli, alias, 'data-spaces', version, base, normalizeDataSpaces, maxPages),
    retrieveFamily(cli, alias, 'dlos', version, base, normalizeDlos, maxPages),
    retrieveFamily(cli, alias, 'dmos', version, base, normalizeDmos, maxPages),
    retrieveFamily(cli, alias, 'data-streams', version, base, normalizeDataStreams, maxPages),
    retrieveFamily(cli, alias, 'data-transforms', version, base, normalizeDataTransforms, maxPages),
  ]);

  // Mapping metadata needs a DMO developer name. An org with zero DMOs is a
  // healthy empty result, not an error and not a reason to call Salesforce with
  // an unfiltered request that Salesforce itself rejects.
  const dmoApiNames = dmos.result.items.map((dmo) => dmo.apiName);
  const mappings = dmoApiNames.length === 0
    ? skippedMappings(version, base, dmos.capability)
    : await retrieveMappingsByDmo(cli, alias, version, base, dmoApiNames, maxPages);

  capabilities.push(
    spaces.capability,
    dlos.capability,
    dmos.capability,
    mappings.capability,
    streams.capability,
    transforms.capability,
  );
  warnings.push(
    ...spaces.warnings,
    ...dlos.warnings,
    ...dmos.warnings,
    ...mappings.warnings,
    ...streams.warnings,
    ...transforms.warnings,
  );

  const dmoContext: NormalizeContext = {
    ...base,
    apiVersion: version,
    endpoint: buildData360Path('dmos', version),
  };
  const relationships = dedupeRelationships([
    ...dmos.result.relationships,
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
    dataStreams: streams.result.items,
    dataTransforms: transforms.result.items,
    relationships,
    warnings,
  });
}
