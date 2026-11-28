import { isValidTransformId, type ResourceFamily } from '@dcat/core';
import { CliError } from '@dcat/salesforce-cli';
import { API_VERSION_PATTERN, VERSIONS_PATH } from './versions.ts';

/** Version-independent path catalog. Candidate families must still be probed per org. */
export const DATA360_ENDPOINT_REGISTRY: Record<ResourceFamily, string> = {
  'data-spaces': '/ssot/data-spaces',
  dlos: '/ssot/data-lake-objects',
  dmos: '/ssot/data-model-objects',
  mappings: '/ssot/data-model-object-mappings',
  'data-streams': '/ssot/data-streams',
  'data-transforms': '/ssot/data-transforms',
};

/**
 * Small verified DMO pages keep early batches useful. Larger pages can time out
 * and the endpoint has no next-page URL, so DCAT walks bounded offsets instead.
 */
export const DMO_PAGE_SIZE = 10;

/** Small pages expose transforms individually while staying below the documented maximum of 20. */
export const DATA_TRANSFORM_PAGE_SIZE = 5;

/**
 * The list endpoint defaults to the Big filter group, which includes full
 * transform definitions. Medium keeps inventory fields without pulling those
 * potentially multi-megabyte graphs through Salesforce CLI. Orgs whose Medium
 * payloads still exceed the CLI output cap fall back to one Small record per page.
 */
export const DATA_TRANSFORM_FILTER_GROUP = 'Medium';
export const DATA_TRANSFORM_COMPACT_FILTER_GROUP = 'Small';
export const DATA_TRANSFORM_COMPACT_PAGE_SIZE = 1;

/**
 * Verified upper bound for the per-DMO relationship subresource. Requested pages
 * are deliberately smaller so relationship rows arrive in short batches.
 */
export const RELATIONSHIP_PAGE_SIZE = 500;
export const RELATIONSHIP_REQUEST_PAGE_SIZE = 25;

const DMO_DEVELOPER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const DATASPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const CONNECTOR_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

export function isValidDmoDeveloperName(name: string): boolean {
  return DMO_DEVELOPER_NAME_PATTERN.test(name.trim());
}

export function isValidConnectorType(type: string): boolean {
  return CONNECTOR_TYPE_PATTERN.test(type.trim());
}

export function isValidDataspace(dataspace?: string | null): boolean {
  const trimmed = dataspace?.trim();
  return !trimmed || DATASPACE_PATTERN.test(trimmed);
}

/** Guard the developer name before it becomes a path segment. */
export function validateDmoDeveloperName(name: string): string {
  const trimmed = name.trim();
  if (!isValidDmoDeveloperName(trimmed)) {
    throw new CliError('INVALID_ARGUMENT', 'The DMO developer name contains unsupported characters.');
  }
  return trimmed;
}

export function buildData360Path(family: ResourceFamily, apiVersion: string): string {
  if (!API_VERSION_PATTERN.test(apiVersion)) {
    throw new CliError('INVALID_ARGUMENT', 'An invalid API version was supplied by the version adapter.');
  }
  return `services/data/v${apiVersion}${DATA360_ENDPOINT_REGISTRY[family]}`;
}

/** Families whose list endpoints paginate by offset rather than a next-page token. */
export function offsetPageSizeFor(family: ResourceFamily): number | null {
  if (family === 'dmos') return DMO_PAGE_SIZE;
  if (family === 'data-transforms') return DATA_TRANSFORM_PAGE_SIZE;
  return null;
}

/** Derive the real page size from a cursor path so compact pages stay compact. */
export function pageSizeForPath(family: ResourceFamily, path: string): number | null {
  const configured = offsetPageSizeFor(family);
  if (configured === null) return null;
  try {
    const value = Number(new URL(path, 'https://dcat.local').searchParams.get('limit'));
    if (Number.isSafeInteger(value) && value >= 1) return value;
  } catch {
    // A malformed path keeps the family's configured size.
  }
  return configured;
}

/** Initial request path for a family. Offset-paginated families start at page zero. */
export function buildFamilyPath(family: ResourceFamily, apiVersion: string): string {
  if (family === 'dmos') {
    return `${buildData360Path(family, apiVersion)}?limit=${DMO_PAGE_SIZE}&offset=0`;
  }
  if (family === 'data-transforms') return buildDataTransformPath(apiVersion, 0);
  return buildData360Path(family, apiVersion);
}

/**
 * Minimal count probe for families whose verified REST responses expose a
 * global `totalSize`. DMOs have no envelope total, and mapping/relationship
 * lookups are per-DMO calls with no global count endpoint.
 */
export function buildExpectedCountPath(family: ResourceFamily, apiVersion: string): string | null {
  if (family === 'dmos' || family === 'mappings') return null;
  // A count probe contains no rows, but a Medium transform can still be large
  // enough to trip the CLI output cap. Small is sufficient for `totalSize`.
  if (family === 'data-transforms') return buildDataTransformPath(apiVersion, 0, true);
  const path = buildFamilyPath(family, apiVersion);
  try {
    const url = new URL(path, 'https://dcat.local');
    url.searchParams.set('limit', '1');
    return `${url.pathname.replace(/^\//, '')}${url.search}`;
  } catch {
    return `${path}${path.includes('?') ? '&' : '?'}limit=1`;
  }
}

export function buildDmoPath(apiVersion: string, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new CliError('INVALID_ARGUMENT', 'An invalid DMO offset was supplied.');
  }
  return `${buildData360Path('dmos', apiVersion)}?limit=${DMO_PAGE_SIZE}&offset=${offset}`;
}

export function buildDataTransformPath(apiVersion: string, offset = 0, compact = false): string {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new CliError('INVALID_ARGUMENT', 'An invalid Data Transform offset was supplied.');
  }
  const filterGroup = compact ? DATA_TRANSFORM_COMPACT_FILTER_GROUP : DATA_TRANSFORM_FILTER_GROUP;
  const limit = compact ? DATA_TRANSFORM_COMPACT_PAGE_SIZE : DATA_TRANSFORM_PAGE_SIZE;
  return `${buildData360Path('data-transforms', apiVersion)}`
    + `?filterGroup=${filterGroup}&limit=${limit}&offset=${offset}`;
}

/** Salesforce rejects unfiltered mapping lookups, so an empty name is never sent. */
export function buildMappingPath(dmoApiName: string, apiVersion: string, dataspace?: string | null): string {
  const name = dmoApiName.trim();
  if (!name) {
    throw new CliError('INVALID_ARGUMENT', 'A DMO developer name is required for mapping lookup.');
  }
  const base = buildData360Path('mappings', apiVersion);
  const parameters: string[] = [];
  if (dataspace?.trim()) parameters.push(`dataspace=${encodeURIComponent(dataspace.trim())}`);
  parameters.push(`dmoDeveloperName=${encodeURIComponent(name)}`);
  return `${base}?${parameters.join('&')}`;
}

/**
 * Salesforce v68 exposes DMO relationships only as this per-DMO subresource.
 * The queried DMO may be either side, so rows are deduplicated by the caller.
 */
export function buildDmoRelationshipsPath(
  dmoApiName: string,
  apiVersion: string,
  dataspace?: string | null,
  limit = RELATIONSHIP_REQUEST_PAGE_SIZE,
): string {
  const safeName = validateDmoDeveloperName(dmoApiName);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RELATIONSHIP_PAGE_SIZE) {
    throw new CliError('INVALID_ARGUMENT', 'An invalid relationship page size was supplied.');
  }
  const trimmedSpace = dataspace?.trim();
  if (!isValidDataspace(trimmedSpace)) {
    throw new CliError('INVALID_ARGUMENT', 'The data space contains unsupported characters.');
  }
  const parameters = [
    ...(trimmedSpace ? [`dataspace=${encodeURIComponent(trimmedSpace)}`] : []),
    `limit=${limit}`,
  ];
  return `${buildData360Path('dmos', apiVersion)}/${encodeURIComponent(safeName)}/relationships?${parameters.join('&')}`;
}

export function buildVersionsPath(): string {
  return VERSIONS_PATH;
}

function buildConnectorBasePath(apiVersion: string): string {
  if (!API_VERSION_PATTERN.test(apiVersion)) {
    throw new CliError('INVALID_ARGUMENT', 'An invalid API version was supplied by the version adapter.');
  }
  return `services/data/v${apiVersion}/ssot`;
}

/** Connector catalog lookup. This is reference data, not an inventory family. */
export function buildConnectorCatalogPath(apiVersion: string): string {
  return `${buildConnectorBasePath(apiVersion)}/connectors`;
}

/** Query only the connector types that actually appear in discovered streams. */
export function buildConnectorConnectionsPath(apiVersion: string, connectorType: string): string {
  const trimmed = connectorType.trim();
  if (!isValidConnectorType(trimmed)) {
    throw new CliError('INVALID_ARGUMENT', 'The connector type contains unsupported characters.');
  }
  return `${buildConnectorBasePath(apiVersion)}/connections?connectorType=${encodeURIComponent(trimmed)}`;
}

export const TRANSFORM_SUBRESOURCE_SUFFIXES = {
  detail: '',
  runHistory: '/run-history',
  schedule: '/schedule',
} as const;

/**
 * The detail endpoint defaults to Big on Salesforce v68, but requesting it
 * explicitly keeps the UI graph stable if the org changes that default.
 */
export const TRANSFORM_DETAIL_FILTER_GROUP = 'Big';
/** Fallback for definitions too large for the CLI output cap. */
export const TRANSFORM_DETAIL_COMPACT_FILTER_GROUP = 'Small';

export type TransformSubresource = keyof typeof TRANSFORM_SUBRESOURCE_SUFFIXES;

/** Guard the id before it is ever placed in a REST path; callers cannot supply URLs. */
export function validateTransformId(id: string): string {
  if (!isValidTransformId(id)) {
    throw new CliError('INVALID_ARGUMENT', 'The transform id contains unsupported characters.');
  }
  return id;
}

export function buildTransformSubresourcePath(
  id: string,
  section: TransformSubresource,
  apiVersion: string,
): string {
  const suffix = TRANSFORM_SUBRESOURCE_SUFFIXES[section];
  if (suffix === undefined) {
    throw new CliError('INVALID_ARGUMENT', 'The transform section is not an allowed read-only resource.');
  }
  const safeId = validateTransformId(id);
  // apiVersion is validated by the shared path builder. Encoding the already
  // allowlisted id keeps the segment intact even if the charset ever widens.
  return `${buildData360Path('data-transforms', apiVersion)}/${encodeURIComponent(safeId)}${suffix}`;
}

export function buildTransformDetailPath(id: string, apiVersion: string, compact = false): string {
  const filterGroup = compact ? TRANSFORM_DETAIL_COMPACT_FILTER_GROUP : TRANSFORM_DETAIL_FILTER_GROUP;
  return `${buildTransformSubresourcePath(id, 'detail', apiVersion)}?filterGroup=${filterGroup}`;
}

export function buildTransformRunHistoryPath(id: string, apiVersion: string): string {
  return buildTransformSubresourcePath(id, 'runHistory', apiVersion);
}

export function buildTransformSchedulePath(id: string, apiVersion: string): string {
  return buildTransformSubresourcePath(id, 'schedule', apiVersion);
}
