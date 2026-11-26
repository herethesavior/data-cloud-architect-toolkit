import type { TransformVisualDefinition } from '@dcat/core';
import { MarkerType, Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';

export interface TransformFlowNodeData extends Record<string, unknown> {
  label: string;
  type: string | null;
  action: string | null;
  description: string | null;
  fieldCount: number | null;
  sourceCount: number | null;
  summary: string[];
}

export type TransformFlowNode = Node<TransformFlowNodeData, 'transformStep'>;
export type TransformFlowEdge = Edge<Record<string, unknown>, 'smoothstep'>;

export function buildTransformFlow(definition: TransformVisualDefinition): {
  nodes: TransformFlowNode[];
  edges: TransformFlowEdge[];
} {
  const nodes = definition.nodes.map((node) => ({
    id: node.id,
    type: 'transformStep' as const,
    position: { x: node.left, y: node.top },
    data: {
      label: node.label,
      type: node.type ?? null,
      action: node.action ?? null,
      description: node.description ?? null,
      fieldCount: node.fieldCount ?? null,
      sourceCount: node.sourceCount ?? null,
      summary: node.summary,
    },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  }));

  const edges = definition.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep' as const,
    label: edge.label ?? undefined,
    markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--color-brand)' },
    style: { stroke: 'var(--color-brand)', strokeWidth: 1.5 },
    labelStyle: { fill: 'var(--color-ink-soft)', fontSize: 11 },
  }));

  return { nodes, edges };
}
