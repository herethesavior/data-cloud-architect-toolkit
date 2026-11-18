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

export function buildData360Path(family: ResourceFamily, apiVersion: string): string {
  if (!API_VERSION_PATTERN.test(apiVersion)) {
    throw new CliError('INVALID_ARGUMENT', 'An invalid API version was supplied by the version adapter.');
  }
  return `services/data/v${apiVersion}${DATA360_ENDPOINT_REGISTRY[family]}`;
}

/** Salesforce requires a DMO developer name filter for mapping lookups. */
export function buildMappingPath(dmoApiName: string, apiVersion: string): string {
  const base = buildData360Path('mappings', apiVersion);
  return `${base}?dmoDeveloperName=${encodeURIComponent(dmoApiName)}`;
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
