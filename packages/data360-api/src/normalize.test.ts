import { describe, expect, it } from 'vitest';
import { dataTransformSchema, inventorySnapshotSchema, transformBundleSchema } from '@dcat/core';
import { CliError } from '@dcat/salesforce-cli';
import {
  dataSpacesJson,
  demoInventory,
  demoTransformBundles,
  dlosJson,
  dmosJson,
  mappingsJson,
} from '@dcat/test-fixtures';
import {
  deriveInferredRelationships,
  extractCollection,
  normalizeDataSpaces,
  normalizeDlos,
  normalizeDmos,
  normalizeMappings,
  normalizeDataTransforms,
  parseJsonResponse,
  normalizeTransformType,
} from './normalize.ts';
import type { NormalizeContext } from './normalize.ts';

const context: NormalizeContext = {
  orgId: '00DTEST000000000AAA',
  orgAlias: 'test-org',
  apiVersion: '65.0',
  endpoint: 'services/data/v65.0/ssot/test',
  retrievedAt: '2026-11-18T00:00:00.000Z',
};

describe('Data 360 response normalization', () => {
  it('accepts arrays and documented envelopes but rejects unknown shapes', () => {
    expect(extractCollection([{ name: 'A' }], 'Test')).toHaveLength(1);
    expect(extractCollection({ records: [{ name: 'A' }] }, 'Test')).toHaveLength(1);
    expect(extractCollection({ result: { items: [] }, items: [{ name: 'B' }] }, 'Test')).toHaveLength(1);
    expect(() => extractCollection({ unexpected: true }, 'Test')).toThrow(CliError);
    expect(() => parseJsonResponse('not json', 'Test')).toThrow(/not valid JSON/);
  });

  it('prefers a populated envelope over an empty one with another alias', () => {
    expect(extractCollection({ records: [], results: [{ apiName: 'A' }] }, 'Test')).toEqual([{ apiName: 'A' }]);
    expect(extractCollection({ records: [], items: [] }, 'Test')).toEqual([]);
  });

  it('does not invent a confirmed edge from a relationship field name', () => {
    const result = normalizeDmos(
      [{ apiName: 'Account_DMO__dlm', relationships: [{ apiName: 'AccountId', joinField: 'AccountId' }] }],
      context,
    );
    expect(result.items).toHaveLength(1);
    expect(result.relationships).toEqual([]);
  });

  it('normalizes data spaces using alternate field names', () => {
    const result = normalizeDataSpaces(parseJsonResponse(dataSpacesJson, 'Data Spaces'), context);
    expect(result.skipped).toBe(0);
    expect(result.items[0]).toMatchObject({ apiName: 'default', label: 'Default Space', isDefault: true });
    expect(result.items[1]).toMatchObject({ apiName: 'sales_space', label: 'Sales Space' });
    expect(result.items[0]?.provenance).toMatchObject({
      orgAlias: 'test-org',
      sourceEndpoint: context.endpoint,
      apiVersion: '65.0',
      confidence: 'source',
    });
  });

  it('normalizes fields from inline, alternate, and nested schema shapes', () => {
    const result = normalizeDlos(parseJsonResponse(dlosJson, 'Data Lake Objects'), context);
    const account = result.items[0]!;
    const order = result.items[1]!;

    expect(account.fields[0]).toMatchObject({
      apiName: 'Id',
      isPrimaryKey: true,
      isNullable: false,
      dataType: 'String',
    });
    expect(account.fields[1]).toMatchObject({ apiName: 'Name', label: 'Account Name', isNullable: false });
    expect(order.fields[0]).toMatchObject({ apiName: 'Id', isPrimaryKey: true });
    expect(result.skipped).toBe(0);
  });

  it('records source-confirmed relationships found on DMOs', () => {
    const result = normalizeDmos(parseJsonResponse(dmosJson, 'Data Model Objects'), context);
    expect(result.items).toHaveLength(3);
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0]).toMatchObject({
      source: 'Account_DMO__dlm',
      target: 'Contact_DMO__dlm',
      label: 'AccountId',
      certainty: 'confirmed',
    });
    expect(result.relationships[0]?.provenance.confidence).toBe('source');
  });

  it('derives only conservatively matched relationships and marks them inferred', () => {
    const result = normalizeDmos(parseJsonResponse(dmosJson, 'Data Model Objects'), context);
    const edges = deriveInferredRelationships(result.items, context);
    const descriptions = edges.map((edge) => `${edge.source}->${edge.target}:${edge.label}`);

    expect(descriptions).toContain('Contact_DMO__dlm->Account_DMO__dlm:AccountId');
    expect(descriptions).toContain('Order_DMO__dlm->Account_DMO__dlm:AccountId');
    expect(edges.every((edge) => edge.certainty === 'inferred')).toBe(true);
    expect(edges.every((edge) => edge.provenance.confidence === 'derived')).toBe(true);
  });

  it('normalizes mappings including source/from aliases and field detail', () => {
    const result = normalizeMappings(parseJsonResponse(mappingsJson, 'Mappings'), context);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.fieldMappings).toEqual([
      { sourceField: 'Id', targetField: 'Id', transformation: null },
      { sourceField: 'Name', targetField: 'Name', transformation: 'trim' },
    ]);
    expect(result.items[1]).toMatchObject({ sourceObject: 'Order_DLO__dll', targetObject: 'Order_DMO__dlm' });
  });

  it('normalizes enriched transform metadata from plausible aliases', () => {
    const record = {
      id: '0TfTEST000000001AAA',
      apiName: 'Batch_Transform__dtm',
      label: 'Batch Transform',
      transformStatus: 'Active',
      type: 'bAtCh',
      inputObjects: 'Account_DLO__dll, Order_DLO__dll',
      targetObjects: ['Account_DMO__dlm'],
      lastRunStatus: 'Failure',
      lastRunTimestamp: '2026-11-17T01:30:00.000Z',
      scheduleSummary: 'Daily at 02:00 UTC',
      transformDefinition: { nodes: [] },
      dataSpace: 'default',
      createdDate: '2026-09-01T09:00:00.000Z',
      LastModifiedDate: '2026-11-16T14:20:00.000Z',
      ownerName: 'architect@example.invalid',
    };
    const result = normalizeDataTransforms({ records: [record] }, context);
    const transform = result.items[0]!;

    expect(result.skipped).toBe(0);
    expect(transform).toMatchObject({
      id: '0TfTEST000000001AAA',
      type: 'Batch',
      status: 'Active',
      lastRunStatus: 'Failure',
      lastRunAt: '2026-11-17T01:30:00.000Z',
      schedule: 'Daily at 02:00 UTC',
      dataSpace: 'default',
      createdAt: '2026-09-01T09:00:00.000Z',
      modifiedAt: '2026-11-16T14:20:00.000Z',
      owner: 'architect@example.invalid',
    });
    expect(transform.inputs).toEqual(['Account_DLO__dll', 'Order_DLO__dll']);
    expect(transform.outputs).toEqual(['Account_DMO__dlm']);
    expect(transform.definition).toBe('{"nodes":[]}');
    expect(transform.raw).toEqual(record);
    expect(transform.status).not.toBe(transform.lastRunStatus);
  });

  it('normalizes streaming type only from explicit values and preserves unknown statuses', () => {
    expect(normalizeTransformType('STREAMING')).toBe('Streaming');
    expect(normalizeTransformType('batch')).toBe('Batch');
    expect(normalizeTransformType('Scheduled_Transform__dtm')).toBeNull();
    expect(normalizeTransformType('scheduled')).toBeNull();

    const result = normalizeDataTransforms([
      { apiName: 'Future_Transform__dtm', status: 'Needs Migration' },
    ], context);
    expect(result.items[0]?.status).toBe('Needs Migration');
    expect(result.items[0]?.type).toBeUndefined();
    expect(result.items[0]?.inputs).toBeNull();
  });

  it('accepts sparse transform records without inventing fields', () => {
    const record = { apiName: 'Sparse_Transform', status: 'Active' };
    const transform = normalizeDataTransforms([record], context).items[0]!;

    expect(transform.label).toBeNull();
    expect(transform.id).toBeNull();
    expect(transform.lastRunStatus).toBeNull();
    expect(transform.schedule).toBeNull();
    expect(transform.raw).toEqual(record);
    expect(dataTransformSchema.safeParse({ apiName: 'Sparse_Transform', provenance: transform.provenance }).success).toBe(true);
    expect(transformBundleSchema.safeParse({
      transform,
      runs: [],
      schedule: null,
      sections: { detail: 'available', runHistory: 'unsupported', schedule: 'unsupported' },
      messages: { detail: null, runHistory: null, schedule: null },
    }).success).toBe(true);
  });

  it('skips transform records with no identifying api name', () => {
    const result = normalizeDataTransforms([{ label: 'No name' }, 'not a record', { apiName: 'Valid_Transform' }], context);
    expect(result.skipped).toBe(2);
    expect(result.items.map((item) => item.apiName)).toEqual(['Valid_Transform']);
  });

  it('keeps demo fixtures valid against the shared domain schemas', () => {
    expect(inventorySnapshotSchema.safeParse(demoInventory).success).toBe(true);
    expect(Object.values(demoTransformBundles).every((bundle) => transformBundleSchema.safeParse(bundle).success)).toBe(true);
    expect(demoInventory.capabilities.find((entry) => entry.family === 'data-transforms')?.status).toBe('available');
    expect(demoInventory.warnings).toHaveLength(0);
    expect(demoInventory.dataTransforms.some((transform) => transform.type === 'Streaming')).toBe(true);
  });
});
