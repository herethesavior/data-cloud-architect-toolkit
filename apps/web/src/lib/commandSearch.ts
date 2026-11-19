import type { InventorySnapshot } from '@dcat/core';
import type { IconName } from '../components/Icon.tsx';
import { matchesQuery } from './inventory.ts';
import { streamSearchValues } from './streamDetail.ts';

export type CommandResultKind = 'data-space' | 'dlo' | 'dmo' | 'stream' | 'mapping' | 'transform';

export interface CommandResult {
  id: string;
  kind: CommandResultKind;
  typeLabel: string;
  label: string;
  apiName: string;
  dataSpace: string | null;
  icon: IconName;
  raw: unknown;
  searchText?: string;
}

export const COMMAND_RESULT_LIMIT = 20;

/** Inventory-derived search index; nothing is fetched from an arbitrary URL. */
export function buildCommandResults(inventory: InventorySnapshot | null): CommandResult[] {
  if (!inventory) return [];
  return [
    ...inventory.dataSpaces.map<CommandResult>((space) => ({
      id: `space:${space.apiName}`,
      kind: 'data-space',
      typeLabel: 'Data Space',
      label: space.label ?? space.apiName,
      apiName: space.apiName,
      dataSpace: null,
      icon: 'layers',
      raw: space,
    })),
    ...inventory.dlos.map<CommandResult>((object) => ({
      id: `dlo:${object.apiName}`,
      kind: 'dlo',
      typeLabel: 'DLO',
      label: object.label ?? object.apiName,
      apiName: object.apiName,
      dataSpace: object.dataSpace ?? null,
      icon: 'database',
      raw: object,
    })),
    ...inventory.dmos.map<CommandResult>((object) => ({
      id: `dmo:${object.apiName}`,
      kind: 'dmo',
      typeLabel: 'DMO',
      label: object.label ?? object.apiName,
      apiName: object.apiName,
      dataSpace: object.dataSpace ?? null,
      icon: 'cube',
      raw: object,
    })),
    ...inventory.dataStreams.map<CommandResult>((stream) => ({
      id: `stream:${stream.apiName}`,
      kind: 'stream',
      typeLabel: 'Data Stream',
      label: stream.label ?? stream.apiName,
      apiName: stream.apiName,
      dataSpace: null,
      icon: 'plug',
      raw: stream,
      searchText: streamSearchValues(inventory, stream).join(' '),
    })),
    ...inventory.mappings.map<CommandResult>((mapping) => ({
      id: `mapping:${mapping.apiName ?? `${mapping.sourceObject}-${mapping.targetObject}`}`,
      kind: 'mapping',
      typeLabel: 'Mapping',
      label: `${mapping.sourceObject} → ${mapping.targetObject}`,
      apiName: mapping.apiName ?? mapping.sourceObject,
      dataSpace: null,
      icon: 'route',
      raw: mapping,
    })),
    ...inventory.dataTransforms.map<CommandResult>((transform) => ({
      id: `transform:${transform.apiName}`,
      kind: 'transform',
      typeLabel: 'Data Transform',
      label: transform.label ?? transform.apiName,
      apiName: transform.apiName,
      dataSpace: null,
      icon: 'sparkles',
      raw: transform,
    })),
  ];
}

export function filterCommandResults(results: CommandResult[], query: string): CommandResult[] {
  if (!query.trim()) return results.slice(0, COMMAND_RESULT_LIMIT);
  return results
    .filter((result) => matchesQuery(query, [
      result.typeLabel,
      result.label,
      result.apiName,
      result.dataSpace ?? '',
      result.searchText ?? '',
    ]))
    .slice(0, COMMAND_RESULT_LIMIT);
}

export interface CommandResultDetail {
  label: string;
  value: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Detail-only results get a compact, read-only summary before the raw metadata. */
export function commandResultDetails(result: CommandResult): CommandResultDetail[] {
  const raw = asRecord(result.raw);
  const provenance = asRecord(raw.provenance);
  const details: CommandResultDetail[] = [];

  if (result.kind === 'data-space') {
    const description = text(raw.description);
    if (description) details.push({ label: 'Description', value: description });
    details.push({ label: 'Default space', value: raw.isDefault === true ? 'Yes' : 'No' });
  } else if (result.kind === 'stream') {
    const rawType = text(raw.sourceConnector);
    const sourceLabel = text(raw.sourceConnectorLabel) ?? rawType;
    if (sourceLabel) details.push({ label: 'Source connector', value: sourceLabel });
    if (sourceLabel && rawType && sourceLabel !== rawType) {
      details.push({ label: 'Connector type', value: rawType });
    }
    const connection = text(raw.sourceConnectionLabel) ?? text(raw.sourceConnectionName) ?? text(raw.sourceDataSource);
    if (connection) details.push({ label: 'Configured connection', value: connection });
    for (const [label, key] of [
      ['Target DLO', 'targetDlo'],
      ['Status', 'status'],
      ['Refresh', 'refreshMetadata'],
    ] as const) {
      const value = text(raw[key]);
      if (value) details.push({ label, value });
    }
  } else if (result.kind === 'mapping') {
    details.push({ label: 'Source object', value: text(raw.sourceObject) ?? '—' });
    details.push({ label: 'Target object', value: text(raw.targetObject) ?? '—' });
    details.push({ label: 'Field mappings', value: String(Array.isArray(raw.fieldMappings) ? raw.fieldMappings.length : 0) });
  } else if (result.kind === 'transform') {
    for (const [label, key] of [
      ['Transform type', 'type'],
      ['Transform status', 'status'],
      ['Last run status', 'lastRunStatus'],
      ['Description', 'description'],
    ] as const) {
      const value = text(raw[key]);
      if (value) details.push({ label, value });
    }
  }

  const endpoint = text(provenance.sourceEndpoint);
  const confidence = text(provenance.confidence);
  if (endpoint) details.push({ label: 'Source endpoint', value: endpoint });
  if (confidence) details.push({ label: 'Confidence', value: confidence });
  return details;
}
