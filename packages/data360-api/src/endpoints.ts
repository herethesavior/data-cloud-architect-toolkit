import { isValidTransformId, type ResourceFamily } from '@dcat/core';
import { CliError } from '@dcat/salesforce-cli';

/** Version-independent path catalog. Candidate families must still be probed per org. */
export const DATA360_ENDPOINT_REGISTRY: Record<ResourceFamily, string> = {
  'data-spaces': '/ssot/data-spaces',
  dlos: '/ssot/data-lake-objects',
  dmos: '/ssot/data-model-objects',
  mappings: '/ssot/data-model-object-mappings',
  'data-streams': '/ssot/data-streams',
  'data-transforms': '/ssot/data-transforms',
};

const API_VERSION_PATTERN = /^\d{2,3}\.\d{1,2}$/;

/** Verified DMO page size: larger pages time out and the endpoint has no next-page URL. */
export const DMO_PAGE_SIZE = 100;

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

export function buildVersionsPath(): string {
  return 'services/data/';
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
