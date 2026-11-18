import { RESOURCE_FAMILIES, type DataField, type InventorySnapshot } from '@dcat/core';
import { data360NotEnabled, isUnsupportedWarning } from './resourceStatus.ts';

export type DictionaryObjectType = 'DLO' | 'DMO';

export interface DictionaryRow {
  key: string;
  objectType: DictionaryObjectType;
  objectApiName: string;
  objectLabel: string;
  dataSpace: string;
  field: DataField;
}

export interface DiscoverySummary {
  available: number;
  partial: number;
  unsupported: number;
  issues: number;
  total: number;
  score: number;
  label: 'Complete' | 'Mostly complete' | 'Partial' | 'Limited' | 'Not enabled';
}

const statusWeights: Record<string, number> = {
  available: 1,
  partial: 0.5,
  'not-started': 0,
  unsupported: 0,
  forbidden: 0,
  error: 0,
};

const STALE_AFTER_MS = 60_000;
const RESOURCE_FAMILY_NAMES: ReadonlySet<string> = new Set<string>(RESOURCE_FAMILIES);

function isResourceFamily(family: string): boolean {
  return RESOURCE_FAMILY_NAMES.has(family);
}

/** Source timestamps are untrusted; malformed values are shown verbatim. */
export function safeDateText(value: string | null | undefined, fallback = 'Not provided'): string {
  if (!value || !value.trim()) return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

/** Short relative label with an absolute value available in the title/tooltip. */
export function formatUpdatedAt(value: string, now = Date.now()): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 'at an unknown time';
  const elapsed = Math.max(0, now - time);
  if (elapsed < 45_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)} hr ago`;
  return `${Math.round(elapsed / 86_400_000)} d ago`;
}

/** Live inventory is cached for 60s; older snapshots should say so. */
export function isInventoryStale(value: string, now = Date.now()): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && now - time > STALE_AFTER_MS;
}

export function matchesQuery(query: string, values: string[]): boolean {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = values.join(' ').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterByQuery<T>(items: T[], query: string, selectors: (item: T) => string[]): T[] {
  return items.filter((item) => matchesQuery(query, selectors(item)));
}

function sameSpace(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export function countInDataSpace(items: { dataSpace?: string | null }[], dataSpace: string): number {
  return items.filter((item) => sameSpace(item.dataSpace, dataSpace)).length;
}

/** Streams are attributed directly when possible, otherwise through their target DLO. */
export function countStreamsInDataSpace(inventory: InventorySnapshot, dataSpace: string): number {
  return inventory.dataStreams.filter((stream) => {
    if (sameSpace(stream.dataSpace, dataSpace)) return true;
    if (!stream.targetDlo) return false;
    const dlo = inventory.dlos.find((item) => sameSpace(item.apiName, stream.targetDlo));
    return sameSpace(dlo?.dataSpace, dataSpace);
  }).length;
}

export function buildDictionaryRows(inventory: InventorySnapshot): DictionaryRow[] {
  const dloRows = inventory.dlos.flatMap((object) =>
    object.fields.map((field) => ({
      key: `dlo:${object.apiName}:${field.apiName}`,
      objectType: 'DLO' as const,
      objectApiName: object.apiName,
      objectLabel: object.label ?? object.apiName,
      dataSpace: object.dataSpace ?? '—',
      field,
    })),
  );

  const dmoRows = inventory.dmos.flatMap((object) =>
    object.fields.map((field) => ({
      key: `dmo:${object.apiName}:${field.apiName}`,
      objectType: 'DMO' as const,
      objectApiName: object.apiName,
      objectLabel: object.label ?? object.apiName,
      dataSpace: object.dataSpace ?? '—',
      field,
    })),
  );

  return [...dloRows, ...dmoRows];
}

export function discoverySummary(inventory: InventorySnapshot): DiscoverySummary {
  // `api-versions` is a diagnostic capability, not a user-facing resource family.
  // Counting it would make the same org score differently on the progressive path.
  const capabilities = inventory.capabilities.filter((capability) => isResourceFamily(capability.family));
  const available = capabilities.filter((capability) => capability.status === 'available').length;
  const partial = capabilities.filter((capability) => capability.status === 'partial').length;
  const unsupported = capabilities.filter((capability) => capability.status === 'unsupported').length;
  // Count each family once even when discovery emitted several warnings for it.
  const issueFamilies = new Set<string>();
  for (const capability of capabilities) {
    if (capability.status === 'error' || capability.status === 'forbidden') issueFamilies.add(capability.family);
  }
  for (const warning of inventory.warnings) {
    if (isResourceFamily(warning.family) && warning.severity !== 'info' && !isUnsupportedWarning(warning)) {
      issueFamilies.add(warning.family);
    }
  }
  const total = capabilities.length;
  const earned = capabilities.reduce((sum, capability) => sum + (statusWeights[capability.status] ?? 0), 0);
  const score = total === 0 ? 0 : Math.round((earned / total) * 100);

  let label: DiscoverySummary['label'] = 'Limited';
  if (score >= 100) label = 'Complete';
  else if (score >= 70) label = 'Mostly complete';
  else if (score >= 40) label = 'Partial';
  if (data360NotEnabled(inventory)) label = 'Not enabled';

  return {
    available,
    partial,
    unsupported,
    issues: issueFamilies.size,
    total,
    score,
    label,
  };
}
