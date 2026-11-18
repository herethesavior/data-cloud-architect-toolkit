import type { DataStream, InventorySnapshot } from '@dcat/core';

export type StreamStatusTone = 'neutral' | 'success' | 'warning' | 'danger';

/** Stream payloads are free-form; never render a blank as if it were data. */
export function streamValue(value: string | null | undefined, fallback = 'Not provided'): string {
  return value && value.trim() ? value : fallback;
}

/** Invalid source timestamps are shown verbatim instead of "Invalid Date". */
export function streamDateText(value: string | null | undefined): string {
  if (!value || !value.trim()) return 'Not provided';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

/**
 * Data streams do not carry a data space. Derive one only when the named target
 * DLO is present in the same snapshot, matching the Data Spaces page.
 */
export function streamDataSpace(inventory: InventorySnapshot, stream: DataStream): string | null {
  if (!stream.targetDlo) return null;
  return inventory.dlos.find((dlo) => dlo.apiName === stream.targetDlo)?.dataSpace ?? null;
}

export function streamTargetKnown(inventory: InventorySnapshot, stream: DataStream): boolean {
  return Boolean(stream.targetDlo && inventory.dlos.some((dlo) => dlo.apiName === stream.targetDlo));
}

export function streamStatusTone(status: string | null | undefined): StreamStatusTone {
  const value = status?.trim().toLowerCase() ?? '';
  if (/(active|running|healthy|success|complete)/.test(value)) return 'success';
  if (/(paused|stopped|suspended|inactive|disabled)/.test(value)) return 'warning';
  if (/(failed|error|invalid)/.test(value)) return 'danger';
  return 'neutral';
}

/** Search includes only fields present on the stream or joined from inventory. */
export function streamSearchValues(inventory: InventorySnapshot, stream: DataStream): string[] {
  return [
    streamValue(stream.label, ''),
    stream.apiName,
    streamValue(stream.sourceConnector, ''),
    streamValue(stream.targetDlo, ''),
    streamValue(stream.status, ''),
    streamValue(stream.refreshMetadata, ''),
    streamDataSpace(inventory, stream) ?? '',
    stream.provenance.sourceEndpoint,
    stream.provenance.apiVersion,
    stream.provenance.confidence,
  ].filter(Boolean);
}

/** A stable row key that still distinguishes duplicate API names from different sources. */
export function streamRowKey(stream: DataStream): string {
  return [stream.apiName, stream.sourceConnector ?? '', stream.targetDlo ?? ''].join('|');
}
