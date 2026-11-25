import type { DataStream, InventorySnapshot } from '@dcat/core';
import { sameName, safeDateText } from './inventory.ts';

export type StreamStatusTone = 'neutral' | 'success' | 'warning' | 'danger';

/** Stream payloads are free-form; never render a blank as if it were data. */
export function streamValue(value: string | null | undefined, fallback = 'Not provided'): string {
  return value && value.trim() ? value : fallback;
}

/** Invalid source timestamps are shown verbatim instead of "Invalid Date". */
export function streamDateText(value: string | null | undefined): string {
  return safeDateText(value);
}

/**
 * Prefer a data space returned with the stream itself. Older payloads omit it,
 * so fall back to the named target DLO only when it is in the same snapshot.
 */
export function streamDataSpace(inventory: InventorySnapshot, stream: DataStream): string | null {
  const direct = stream.dataSpace?.trim();
  if (direct) return direct;
  if (!stream.targetDlo) return null;
  return inventory.dlos.find((dlo) => sameName(dlo.apiName, stream.targetDlo))
    ?.dataSpace ?? null;
}

export function streamTargetKnown(inventory: InventorySnapshot, stream: DataStream): boolean {
  return Boolean(stream.targetDlo && inventory.dlos.some(
    (dlo) => sameName(dlo.apiName, stream.targetDlo),
  ));
}

export function streamStatusTone(status: string | null | undefined): StreamStatusTone {
  const value = status?.trim().toLowerCase() ?? '';
  if (/\b(?:failed|failure|failures|error|errors|invalid)\b/.test(value)) return 'danger';
  if (/\b(?:paused|stopped|suspended|inactive|disabled)\b/.test(value)) return 'warning';
  if (/\b(?:active|running|healthy|success|successful|complete|completed)\b/.test(value)) return 'success';
  return 'neutral';
}

/** Search includes only fields present on the stream or joined from inventory. */
export function streamSearchValues(inventory: InventorySnapshot, stream: DataStream): string[] {
  return [
    streamValue(stream.label, ''),
    stream.apiName,
    streamValue(stream.sourceConnector, ''),
    streamValue(stream.sourceConnectorLabel, ''),
    streamValue(stream.sourceConnectionLabel, ''),
    streamValue(stream.sourceConnectionName, ''),
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
