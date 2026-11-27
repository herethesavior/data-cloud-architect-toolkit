import { describe, expect, it } from 'vitest';
import { extractTransformLineage, parseTransformVisualDefinition } from './transformVisual.ts';
import { normalizeDataTransforms } from './normalize.ts';

function liveDetail() {
  return {
    name: 'AccountTransform',
    label: 'Account Transform',
    status: 'ACTIVE',
    definitions: [{
      name: 'AccountTransform',
      label: 'Account Transform',
      version: '1',
      ui: {
        nodes: {
          LOAD_DATASET0: {
            label: 'Account_Home',
            type: 'LOAD_DATASET',
            top: 112,
            left: 112,
            parameters: { sampleSize: 500 },
          },
          OUTPUT0: {
            label: 'Account_Cleaned',
            type: 'OUTPUT',
            top: 112,
            left: 252,
          },
        },
        connectors: [{ source: 'LOAD_DATASET0', target: 'OUTPUT0' }],
        hiddenColumns: ['x'.repeat(5_000)],
      },
      nodes: {
        LOAD_DATASET0: {
          action: 'load',
          sources: [],
          parameters: {
            dataset: { name: 'Account_Home__dll', type: 'dataLakeObject' },
            fields: Array.from({ length: 48 }, (_, index) => `Field_${index}__c`),
          },
        },
        OUTPUT0: {
          action: 'output',
          sources: ['LOAD_DATASET0'],
          parameters: { dataset: { name: 'Account_Cleaned__dll' } },
        },
      },
    }],
  };
}

describe('Salesforce transform canvas metadata', () => {
  it('extracts read-only positions, connectors, and bounded summaries from live Big metadata', () => {
    const visual = parseTransformVisualDefinition(liveDetail());

    expect(visual).not.toBeNull();
    expect(visual!.layout).toBe('source');
    expect(visual!.truncated).toBe(false);
    expect(visual!.nodes.map((node) => node.id)).toEqual(['LOAD_DATASET0', 'OUTPUT0']);
    expect(visual!.nodes[0]).toMatchObject({
      label: 'Account_Home',
      type: 'LOAD_DATASET',
      action: 'load',
      top: 112,
      left: 112,
      fieldCount: 48,
      sourceCount: 0,
    });
    expect(visual!.nodes[0]!.summary).toEqual(expect.arrayContaining([
      'Input: Account_Home__dll',
      '48 fields',
      'Sample: 500',
    ]));
    expect(visual!.edges).toEqual([{
      id: 'LOAD_DATASET0->OUTPUT0',
      source: 'LOAD_DATASET0',
      target: 'OUTPUT0',
      label: null,
    }]);
    expect(visual!.nodes[1]!.left).toBeGreaterThan(visual!.nodes[0]!.left + 220);
    // Salesforce's hidden UI columns and full field lists stay out of the model.
    expect(JSON.stringify(visual).length).toBeLessThan(3_000);
  });

  it('derives a stable layout when Salesforce omits UI coordinates', () => {
    const detail = liveDetail();
    for (const node of Object.values(detail.definitions[0]!.ui.nodes)) {
      delete (node as Record<string, unknown>).top;
      delete (node as Record<string, unknown>).left;
    }

    const visual = parseTransformVisualDefinition(detail);

    expect(visual?.layout).toBe('generated');
    expect(visual?.nodes[0]).toMatchObject({ top: 64, left: 64 });
    expect(visual?.nodes[1]).toMatchObject({ top: 64, left: 352 });
    expect(visual?.edges).toHaveLength(1);
  });

  it('adds a fallback arrow and opens a gap for a lone input and output', () => {
    const detail = liveDetail();
    delete (detail.definitions[0]!.ui as { connectors?: unknown }).connectors;
    for (const node of Object.values(detail.definitions[0]!.nodes)) {
      delete (node as Record<string, unknown>).sources;
    }

    const visual = parseTransformVisualDefinition(detail);

    expect(visual?.edges).toEqual([{
      id: 'LOAD_DATASET0->OUTPUT0',
      source: 'LOAD_DATASET0',
      target: 'OUTPUT0',
      label: null,
    }]);
    expect(visual!.nodes[1]!.left).toBeGreaterThanOrEqual(visual!.nodes[0]!.left + 280);
    expect(visual!.nodes[1]!.top).toBe(visual!.nodes[0]!.top);
  });

  it('reads lineage roles from UI nodes when graph actions are absent', () => {
    const detail = liveDetail();
    for (const node of Object.values(detail.definitions[0]!.nodes)) {
      delete (node as Record<string, unknown>).action;
    }
    delete (detail.definitions[0]!.ui as { connectors?: unknown }).connectors;
    for (const node of Object.values(detail.definitions[0]!.nodes)) {
      delete (node as Record<string, unknown>).sources;
    }

    expect(extractTransformLineage(detail)).toEqual({
      inputs: ['Account_Home__dll'],
      outputs: ['Account_Cleaned__dll'],
    });
    expect(parseTransformVisualDefinition(detail)?.edges).toHaveLength(1);
  });

  it('uses the same definition for lineage and the canvas when versions are stacked', () => {
    const detail = liveDetail();
    const stale = structuredClone(detail.definitions[0]!);
    stale.nodes.LOAD_DATASET0.parameters.dataset.name = 'Old_Home__dll';
    stale.nodes.OUTPUT0.parameters.dataset.name = 'Old_Cleaned__dll';
    detail.definitions.unshift(stale);

    expect(extractTransformLineage(detail)).toEqual({
      inputs: ['Old_Home__dll'],
      outputs: ['Old_Cleaned__dll'],
    });
    expect(parseTransformVisualDefinition(detail)?.label).toBe(stale.label);
  });

  it('attaches the canvas model during transform normalization', () => {
    const normalized = normalizeDataTransforms([liveDetail()], {
      orgId: '00DTEST',
      orgAlias: 'test-org',
      apiVersion: '68.0',
      endpoint: 'services/data/v68.0/ssot/data-transforms/AccountTransform?filterGroup=Big',
      retrievedAt: '2026-11-26T00:00:00.000Z',
    });

    expect(normalized.skipped).toBe(0);
    expect(normalized.items[0]?.visualDefinition?.nodes).toHaveLength(2);
    expect(normalized.items[0]?.visualDefinition?.edges).toHaveLength(1);
  });
});
