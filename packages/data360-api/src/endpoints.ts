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

/** Verified DMO page size: larger pages time out and the endpoint has no next-page URL. */
export const DMO_PAGE_SIZE = 100;

/** Verified maximum page size for the per-DMO relationship subresource. */
export const RELATIONSHIP_PAGE_SIZE = 500;

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

/** Initial request path for a family. DMOs need explicit offset pagination. */
export function buildFamilyPath(family: ResourceFamily, apiVersion: string): string {
  const base = buildData360Path(family, apiVersion);
  return family === 'dmos' ? `${base}?limit=${DMO_PAGE_SIZE}&offset=0` : base;
}

/**
 * Minimal count probe for families whose verified REST responses expose a
 * global `totalSize`. DMOs have no envelope total, and mapping/relationship
 * lookups are per-DMO calls with no global count endpoint.
 */
export function buildExpectedCountPath(family: ResourceFamily, apiVersion: string): string | null {
  if (family === 'dmos' || family === 'mappings') return null;
  return `${buildFamilyPath(family, apiVersion)}?limit=1`;
}

export function buildDmoPath(apiVersion: string, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new CliError('INVALID_ARGUMENT', 'An invalid DMO offset was supplied.');
  }
  return `${buildData360Path('dmos', apiVersion)}?limit=${DMO_PAGE_SIZE}&offset=${offset}`;
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
  limit = RELATIONSHIP_PAGE_SIZE,
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

export function buildTransformDetailPath(id: string, apiVersion: string): string {
  return buildTransformSubresourcePath(id, 'detail', apiVersion);
}

export function buildTransformRunHistoryPath(id: string, apiVersion: string): string {
  return buildTransformSubresourcePath(id, 'runHistory', apiVersion);
}

export function buildTransformSchedulePath(id: string, apiVersion: string): string {
  return buildTransformSubresourcePath(id, 'schedule', apiVersion);
}
