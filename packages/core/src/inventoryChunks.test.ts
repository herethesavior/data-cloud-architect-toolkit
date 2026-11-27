import { describe, expect, it } from 'vitest';
import type { InventorySnapshot } from './domain.ts';
import {
  chunkInventorySnapshot,
  chunkRelayResult,
  ITEM_DETAILS_OMITTED_WARNING,
  MAX_CHUNK_COUNT,
  MAX_CHUNK_ROWS,
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

  it('caps each chunk at a few rows even when the byte budget is generous', () => {
    const inventory = inventoryWithRows(12);
    const chunks = chunkInventorySnapshot(inventory, 5 * 1024 * 1024);

    expect(MAX_CHUNK_ROWS).toBe(5);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.dlos.length)).toEqual([5, 5, 2]);
    expect(chunks.reduce((total, chunk) => total + chunk.dlos.length, 0)).toBe(12);
  });

  it('preserves source warnings and reports rows accumulated so far', () => {
    const inventory = inventoryWithRows(12);
    inventory.warnings = [{
      family: 'dlos',
      code: 'EXPECTED_COUNT_MISMATCH',
      message: 'The count probe disagreed with the page.',
      severity: 'warning',
    }];
    inventory.progress = {
      ...inventory.progress!,
      families: [{
        family: 'dlos',
        status: 'complete',
        loaded: 12,
        total: 12,
        pagesFetched: 2,
        hasMore: false,
      }],
    };
    const chunks = chunkInventorySnapshot(inventory, 5 * 1024 * 1024);

    expect(chunks.every((chunk) => chunk.warnings.some((warning) =>
      warning.code === 'EXPECTED_COUNT_MISMATCH'))).toBe(true);
    expect(chunks.map((chunk) => chunk.progress?.loaded)).toEqual([5, 10, 12]);
    expect(chunks.map((chunk) => chunk.progress?.families[0]?.loaded)).toEqual([5, 10, 12]);
  });

  it('compacts oversized mapping rows and reports the omitted field detail', () => {
    const inventory = inventoryWithRows(1);
    inventory.mappings = [{
      apiName: 'Account_Map',
      sourceObject: 'Account_DLO__dll',
      targetObject: 'Account_DMO__dlm',
      provenance: {
        orgId: '00D',
        orgAlias: 'test',
        sourceEndpoint: '/ssot/data-model-object-mappings',
        apiVersion: '67.0',
        retrievedAt: '2026-01-01T00:00:00.000Z',
        confidence: 'source' as const,
      },
      fieldMappings: Array.from({ length: 100 }, (_, index) => ({
        sourceField: `source_${String(index).padStart(3, '0')}_${'x'.repeat(1_200)}`,
        targetField: `target_${index}`,
      })),
    }];

    const chunks = chunkInventorySnapshot(inventory, 200_000, 1);
    const mapping = chunks.flatMap((chunk) => chunk.mappings)[0]!;

    expect(chunks).toHaveLength(2);
    expect(mapping.fieldMappings).toHaveLength(12);
    expect(chunks.some((chunk) => chunk.warnings.some((warning) =>
      warning.code === ITEM_DETAILS_OMITTED_WARNING && warning.family === 'mappings'))).toBe(true);
  });

  it('trims a single oversized row instead of making the whole inventory terminal', () => {
    const inventory = inventoryWithRows(1);
    inventory.dmos = [{
      apiName: 'Huge_DMO__dlm',
      label: `Huge ${'x'.repeat(20_000)}`,
      fields: Array.from({ length: 400 }, (_, index) => ({
        apiName: `Field_${index}`,
        label: 'x'.repeat(200),
        isPrimaryKey: false,
        provenance: {
          orgId: '00D',
          orgAlias: 'test',
          sourceEndpoint: '/ssot/dmos',
          apiVersion: '67.0',
          retrievedAt: '2026-01-01T00:00:00.000Z',
          confidence: 'source' as const,
        },
      })),
      provenance: {
        orgId: '00D',
        orgAlias: 'test',
        sourceEndpoint: '/ssot/dmos',
        apiVersion: '67.0',
        retrievedAt: '2026-01-01T00:00:00.000Z',
        confidence: 'source' as const,
      },
    }];

    const maxBytes = 8_000;
    const chunks = chunkInventorySnapshot(inventory, maxBytes);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.dmos).toHaveLength(1);
    expect(chunks[0]!.dmos[0]!.apiName).toBe('Huge_DMO__dlm');
    expect(new TextEncoder().encode(JSON.stringify(chunks[0])).byteLength).toBeLessThanOrEqual(maxBytes);
    expect(chunks[0]!.warnings.some((warning) =>
      warning.code === ITEM_DETAILS_OMITTED_WARNING && warning.family === 'dmos')).toBe(true);
  });

  it('delivers a compacted single row through the relay chunk envelope', () => {
    const inventory = inventoryWithRows(1);
    inventory.dmos = [{
      apiName: 'Huge_DMO__dlm',
      label: 'x'.repeat(100_000),
      fields: [],
      provenance: inventory.dlos[0]!.provenance,
    }];

    const chunks = chunkRelayResult({ sessionId: 'session-1', snapshot: inventory }, 8_000);

    expect(chunks).toHaveLength(1);
    expect(chunks![0]!.sessionId).toBe('session-1');
    expect(chunks![0]!.snapshot.dmos[0]?.apiName).toBe('Huge_DMO__dlm');
  });

  it('fits a scalar-heavy row without losing its identity', () => {
    const inventory = inventoryWithRows(1);
    const wide = {
      apiName: 'Wide_DMO__dlm',
      fields: [],
      provenance: inventory.dlos[0]!.provenance,
      ...Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`extra_${index}`, 'x'.repeat(500)])),
    } as unknown as InventorySnapshot['dmos'][number];
    inventory.dmos = [wide];

    const maxBytes = 8_000;
    const chunk = chunkInventorySnapshot(inventory, maxBytes)[0]!;

    expect(new TextEncoder().encode(JSON.stringify(chunk)).byteLength).toBeLessThanOrEqual(maxBytes);
    expect(chunk.dmos[0]!.apiName).toBe('Wide_DMO__dlm');
    expect(chunk.warnings.some((warning) => warning.code === ITEM_DETAILS_OMITTED_WARNING)).toBe(true);
  });

  it('bounds the number of polls for very large inventories', () => {
    const chunks = chunkInventorySnapshot(inventoryWithRows(MAX_CHUNK_COUNT * 8), 5 * 1024 * 1024);

    expect(chunks).toHaveLength(MAX_CHUNK_COUNT);
    expect(chunks.reduce((total, chunk) => total + chunk.dlos.length, 0)).toBe(MAX_CHUNK_COUNT * 8);
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
