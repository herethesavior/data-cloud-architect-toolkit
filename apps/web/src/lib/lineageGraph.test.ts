// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { demoInventory } from '@dcat/test-fixtures';
import { buildLineageGraph } from '@dcat/exporters';
import {
  applyLineagePositions,
  buildLineageFlow,
  getLineagePositions,
  lineageDash,
  lineageHandlePosition,
  lineageNodeMatchesSearch,
  lineageTone,
} from './lineageGraph.ts';

const graph = buildLineageGraph(demoInventory);

describe('lineage flow model', () => {
  it('lays out the demo graph deterministically without touching the domain model', () => {
    const first = buildLineageFlow(graph, 'LR');
    const second = buildLineageFlow(graph, 'LR');

    expect(first.nodes).toHaveLength(30);
    expect(first.edges).toHaveLength(43);
    expect(getLineagePositions(first.nodes)).toEqual(getLineagePositions(second.nodes));
    expect(first.nodes.every((node) =>
      Number.isFinite(node.position.x) && Number.isFinite(node.position.y))).toBe(true);
    expect(new Set(first.nodes.map((node) => `${node.position.x}:${node.position.y}`)).size).toBe(30);
    expect(graph.nodes[0]?.degree).toBeGreaterThanOrEqual(0);
  });

  it('uses stage-appropriate handles for both layout directions', () => {
    const leftToRight = buildLineageFlow(graph, 'LR');
    const topToBottom = buildLineageFlow(graph, 'TB');

    expect(leftToRight.nodes[0]?.sourcePosition).toBe('right');
    expect(leftToRight.nodes[0]?.targetPosition).toBe('left');
    expect(topToBottom.nodes[0]?.sourcePosition).toBe('bottom');
    expect(topToBottom.nodes[0]?.targetPosition).toBe('top');
    expect(lineageHandlePosition('LR', 'source')).toBe('right');
    expect(lineageHandlePosition('TB', 'target')).toBe('top');
  });

  it('keeps grounded, derived, and missing links visually distinct', () => {
    const flow = buildLineageFlow(graph);
    const derived = flow.edges.find((edge) => edge.data?.confidence === 'derived');
    const source = flow.edges.find((edge) => edge.data?.confidence === 'source');

    expect(derived?.style?.strokeDasharray).toBe('7 5');
    expect(source?.style?.strokeDasharray).toBeUndefined();
    expect(lineageDash('missing')).toBe('2 4');
    expect(lineageTone('source')).toBe('var(--color-brand)');
    expect(lineageTone('derived')).toBe('var(--color-warning)');
    expect(lineageTone('missing')).toBe('var(--color-danger)');
  });

  it('applies only finite saved positions and matches search across useful fields', () => {
    const flow = buildLineageFlow(graph);
    const node = flow.nodes[0]!;
    const positioned = applyLineagePositions(flow.nodes, {
      [node.id]: { x: 123, y: 456 },
      [flow.nodes[1]!.id]: { x: Number.NaN, y: 0 },
    });

    expect(positioned[0]?.position).toEqual({ x: 123, y: 456 });
    expect(positioned[1]?.position).toEqual(flow.nodes[1]?.position);
    expect(lineageNodeMatchesSearch(node, node.data.apiName)).toBe(true);
    expect(lineageNodeMatchesSearch(node, node.data.kind)).toBe(true);
    expect(lineageNodeMatchesSearch(node, 'definitely-not-a-step')).toBe(false);
  });
});
