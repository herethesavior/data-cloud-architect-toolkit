import { describe, expect, it } from 'vitest';
import type { InventorySnapshot } from './domain.ts';
import {
  chunkInventorySnapshot,
  chunkRelayResult,
  MORE_ITEMS_AVAILABLE_WARNING,
  RESPONSE_CHUNKED_WARNING,
} from './inventoryChunks.ts';

function inventoryWithRows(count: number): InventorySnapshot {
  const row = (index: number) => ({
    apiName: `DLO_${String(index).padStart(4, '0')}__dll`,
    label: `Object ${index}`,
    fields: [],
    provenance: {
      orgId: '00D',
      orgAlias: 'test',
      sourceEndpoint: '/ssot/dlos',
      apiVersion: '67.0',
      retrievedAt: '2026-01-01T00:00:00.000Z',
      confidence: 'source' as const,
    },
  });
  return {
    org: {
      alias: 'test',
      username: null,
      orgId: '00D',
      instanceUrl: null,
      loginUrl: null,
      environment: 'unknown',
      connectedStatus: null,
      isDefault: true,
      isDevHub: false,
      source: 'salesforce-cli',
    },
    apiVersion: '67.0',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'live',
    capabilities: [],
    dataSpaces: [],
    dlos: Array.from({ length: count }, (_, index) => row(index)),
    dmos: [],
    mappings: [],
    dataStreams: [],
    dataTransforms: [],
    relationships: [],
    warnings: [],
    progress: {
      sessionId: 'session-1',
      generation: 'generation-1',
      state: 'complete',
      loaded: count,
      total: count,
      families: [],
      message: 'All discovered metadata is loaded.',
    },
  };
}

describe('inventory relay chunks', () => {
  it('splits large inventories into bounded snapshots without losing rows', () => {
    const inventory = inventoryWithRows(220);
    const maxBytes = 8_000;
    const chunks = chunkInventorySnapshot(inventory, maxBytes);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.reduce((total, chunk) => total + chunk.dlos.length, 0)).toBe(inventory.dlos.length);
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(JSON.stringify(chunk)).byteLength).toBeLessThanOrEqual(maxBytes);
      expect(chunk.warnings.some((warning) => warning.code === RESPONSE_CHUNKED_WARNING)).toBe(true);
    }
    expect(chunks[0]!.warnings.some((warning) => warning.code === MORE_ITEMS_AVAILABLE_WARNING)).toBe(true);
    expect(chunks.at(-1)!.warnings.some((warning) => warning.code === MORE_ITEMS_AVAILABLE_WARNING)).toBe(false);
    expect(chunks[0]!.progress?.state).toBe('running');
    expect(chunks.at(-1)!.progress?.state).toBe('complete');
  });

  it('keeps the session envelope on progressive result chunks', () => {
    const result = { sessionId: 'session-1', snapshot: inventoryWithRows(220) };
    const chunks = chunkRelayResult(result, 8_000);

    expect(chunks).not.toBeNull();
    expect(chunks!.length).toBeGreaterThan(1);
    expect(chunks!.every((chunk) => chunk.sessionId === 'session-1')).toBe(true);
  });

  it('leaves small results unchanged', () => {
    expect(chunkInventorySnapshot(inventoryWithRows(1), 8_000)).toHaveLength(1);
    expect(chunkRelayResult({ sessionId: 'session-1', snapshot: inventoryWithRows(1) }, 8_000)).toBeNull();
  });
});
