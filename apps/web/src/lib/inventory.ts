import type { DataField, InventorySnapshot } from '@dcat/core';

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
  issues: number;
  total: number;
  score: number;
  label: 'Complete' | 'Mostly complete' | 'Partial' | 'Limited';
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

export function countInDataSpace(items: { dataSpace?: string | null }[], dataSpace: string): number {
  return items.filter((item) => item.dataSpace === dataSpace).length;
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
  const capabilities = inventory.capabilities;
  const available = capabilities.filter((capability) => capability.status === 'available').length;
  const partial = capabilities.filter((capability) => capability.status === 'partial').length;
  const issueCapabilities = capabilities.filter((capability) =>
    capability.status === 'error' || capability.status === 'forbidden' || capability.status === 'unsupported',
  ).length;
  const issueWarnings = inventory.warnings.filter((warning) => warning.severity !== 'info').length;
  const total = capabilities.length;
  const earned = capabilities.reduce((sum, capability) => sum + (statusWeights[capability.status] ?? 0), 0);
  const score = total === 0 ? 0 : Math.round((earned / total) * 100);

  let label: DiscoverySummary['label'] = 'Limited';
  if (score >= 100) label = 'Complete';
  else if (score >= 70) label = 'Mostly complete';
  else if (score >= 40) label = 'Partial';

  return {
    available,
    partial,
    issues: issueCapabilities + issueWarnings,
    total,
    score,
    label,
  };
}
