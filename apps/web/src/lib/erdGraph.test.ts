import { describe, expect, it } from 'vitest';
import { demoInventory } from '@dcat/test-fixtures';
import {
  applyErdPositions,
  buildErdGraph,
  erdSourceHandleId,
  erdTargetHandleId,
  filterErdEdges,
  getErdPositions,
  nodeMatchesSearch,
} from './erdGraph.ts';

describe('ERD graph model', () => {
  it('builds a deterministic dagre layout for the demo inventory', () => {
    const first = buildErdGraph(demoInventory, { direction: 'LR', sortMode: 'connected' });
    const second = buildErdGraph(demoInventory, { direction: 'LR', sortMode: 'connected' });

    expect(first.nodes).toHaveLength(8);
    expect(first.edges).toHaveLength(9);
    expect(getErdPositions(first.nodes)).toEqual(getErdPositions(second.nodes));
    expect(first.nodes.every((node) => Number.isFinite(node.position.x) && Number.isFinite(node.position.y))).toBe(true);
    expect(new Set(first.nodes.map((node) => `${node.position.x}:${node.position.y}`)).size).toBe(8);
  });

  it('maps relationship join fields to field-level handles', () => {
    const graph = buildErdGraph(demoInventory, { direction: 'LR', sortMode: 'connected' });
    const inferred = graph.edges.find((edge) => edge.data?.joinField === 'ContactId');
    expect(inferred).toBeDefined();
    expect(inferred!.sourceHandle).toBe(erdSourceHandleId('ContactId'));
    expect(inferred!.targetHandle).toBe(erdTargetHandleId());
    expect(inferred!.style?.strokeDasharray).toBe('7 5');

    const confirmed = graph.edges.find((edge) => edge.data?.certainty === 'confirmed');
    expect(confirmed!.style?.strokeDasharray).toBeUndefined();
  });

  it('uses an explicit target join field instead of reusing the source field', () => {
    const inventory = {
      ...demoInventory,
      relationships: [{
        ...demoInventory.relationships[0]!,
        id: 'target-field-relationship',
        targetField: 'Id',
      }],
    };
    const graph = buildErdGraph(inventory, { direction: 'LR', sortMode: 'connected' });
    const edge = graph.edges.find((candidate) => candidate.id === 'target-field-relationship');

    expect(edge?.targetHandle).toBe(erdTargetHandleId('Id'));
    expect(edge?.data?.targetField).toBe('Id');
  });

  it('does not echo the source join field as a target field when none was supplied', () => {
    const graph = buildErdGraph(demoInventory, { direction: 'LR', sortMode: 'connected' });
    const inferred = graph.edges.find((edge) => edge.data?.joinField === 'ContactId');

    expect(inferred?.data?.targetField).toBeNull();
    expect(inferred?.targetHandle).toBe(erdTargetHandleId());
  });

  it('preserves source relationship status on graph edges', () => {
    const inventory = {
      ...demoInventory,
      relationships: [{
        ...demoInventory.relationships[0]!,
        id: 'status-relationship',
        status: 'INACTIVE',
      }],
    };
    const graph = buildErdGraph(inventory, { direction: 'LR', sortMode: 'connected' });

    expect(graph.edges.find((edge) => edge.id === 'status-relationship')?.data?.status).toBe('INACTIVE');
  });

  it('sorts objects alphabetically when requested', () => {
    const graph = buildErdGraph(demoInventory, { direction: 'TB', sortMode: 'alphabetical' });
    expect(graph.nodes[0]?.data.label).toBe('Account DMO');
    expect(graph.nodes[0]?.data.direction).toBe('TB');
    expect(graph.nodes[0]?.sourcePosition).toBe('bottom');
    expect(graph.nodes[0]?.targetPosition).toBe('top');
  });

  it('treats unknown certainty as inferred when filtering', () => {
    const inventory = {
      ...demoInventory,
      relationships: [
        ...demoInventory.relationships,
        {
          ...demoInventory.relationships[0]!,
          id: 'unknown-relationship',
          cardinality: null,
          certainty: 'unknown' as const,
        },
      ],
    };
    const graph = buildErdGraph(inventory, { direction: 'LR', sortMode: 'connected' });
    expect(graph.edges).toHaveLength(demoInventory.relationships.length + 1);
    expect(filterErdEdges(graph.edges, 'confirmed')).toHaveLength(3);
    expect(filterErdEdges(graph.edges, 'inferred')).toHaveLength(7);
  });

  it('applies only valid persisted positions and matches search text', () => {
    const graph = buildErdGraph(demoInventory, { direction: 'LR', sortMode: 'connected' });
    const node = graph.nodes[0]!;
    const positioned = applyErdPositions(graph.nodes, {
      [node.id]: { x: 123, y: 456 },
      [graph.nodes[1]!.id]: { x: Number.NaN, y: 0 },
    });

    expect(positioned[0]?.position).toEqual({ x: 123, y: 456 });
    expect(positioned[1]?.position).toEqual(graph.nodes[1]?.position);
    expect(nodeMatchesSearch(node, node.data.fields[0]!.apiName)).toBe(true);
    expect(nodeMatchesSearch(node, 'does-not-exist')).toBe(false);
  });
});
