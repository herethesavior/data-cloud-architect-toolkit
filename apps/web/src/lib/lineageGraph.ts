import dagre from '@dagrejs/dagre';
import type {
  LineageConfidence,
  LineageGraph,
  LineageLayoutDirection,
  LineageNodeKind,
} from '@dcat/exporters';
import { MarkerType, Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';

export interface LineageFlowNodeData extends Record<string, unknown> {
  label: string;
  apiName: string;
  subtitle: string;
  kind: LineageNodeKind;
  dataSpace: string | null;
  status: string | null;
  degree: number;
  direction: LineageLayoutDirection;
  dimmed: boolean;
  onPath: boolean;
  unresolved: boolean;
}

export interface LineageFlowEdgeData extends Record<string, unknown> {
  kind: string;
  confidence: LineageConfidence;
  label: string;
  detail: string;
  relationshipCertainty: 'confirmed' | 'inferred' | 'unknown' | null;
  fieldCount: number;
}

export type LineageFlowNode = Node<LineageFlowNodeData, 'lineageStep'>;
export type LineageFlowEdge = Edge<LineageFlowEdgeData, 'smoothstep'>;

export interface LineagePosition {
  x: number;
  y: number;
}

export const LINEAGE_NODE_WIDTH = 214;
export const LINEAGE_NODE_HEIGHT = 74;

export function lineageTone(confidence: LineageConfidence): string {
  if (confidence === 'source') return 'var(--color-brand)';
  if (confidence === 'derived') return 'var(--color-warning)';
  return 'var(--color-danger)';
}

export function lineageDash(confidence: LineageConfidence): string | undefined {
  if (confidence === 'derived') return '7 5';
  if (confidence === 'missing') return '2 4';
  return undefined;
}

export function lineageHandlePosition(direction: LineageLayoutDirection, type: 'source' | 'target'): Position {
  if (type === 'source') return direction === 'LR' ? Position.Right : Position.Bottom;
  return direction === 'LR' ? Position.Left : Position.Top;
}

/** Dagre runs outside render; dragging and viewport changes never re-layout. */
export function buildLineageFlow(
  graph: LineageGraph,
  direction: LineageLayoutDirection = 'LR',
): { nodes: LineageFlowNode[]; edges: LineageFlowEdge[] } {
  const layout = new dagre.graphlib.Graph({ multigraph: true }).setDefaultEdgeLabel(() => ({}));
  layout.setGraph({
    rankdir: direction,
    nodesep: 44,
    ranksep: 124,
    marginx: 40,
    marginy: 40,
    acyclicer: 'greedy',
    ranker: 'network-simplex',
  });
  for (const node of graph.nodes) {
    layout.setNode(node.id, { width: LINEAGE_NODE_WIDTH, height: LINEAGE_NODE_HEIGHT });
  }
  for (const edge of graph.edges) {
    layout.setEdge(edge.source, edge.target, {}, edge.id);
  }
  dagre.layout(layout);

  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const nodes: LineageFlowNode[] = graph.nodes.map((node) => {
    const placed = layout.node(node.id) as { x?: number; y?: number } | undefined;
    return {
      id: node.id,
      type: 'lineageStep',
      position: {
        x: (placed?.x ?? LINEAGE_NODE_WIDTH / 2) - LINEAGE_NODE_WIDTH / 2,
        y: (placed?.y ?? LINEAGE_NODE_HEIGHT / 2) - LINEAGE_NODE_HEIGHT / 2,
      },
      sourcePosition: lineageHandlePosition(direction, 'source'),
      targetPosition: lineageHandlePosition(direction, 'target'),
      data: {
        label: node.label,
        apiName: node.apiName,
        subtitle: node.subtitle,
        kind: node.kind,
        dataSpace: node.dataSpace,
        status: node.status,
        degree: node.degree,
        direction,
        dimmed: false,
        onPath: false,
        unresolved: node.unresolved,
      },
      ariaLabel: `${node.label} (${node.kind}${node.unresolved ? ', missing from snapshot' : ''})`,
      focusable: true,
    };
  });

  const edges: LineageFlowEdge[] = graph.edges.map((edge) => {
    const tone = lineageTone(edge.confidence);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      sourcePosition: lineageHandlePosition(direction, 'source'),
      targetPosition: lineageHandlePosition(direction, 'target'),
      label: edge.label,
      labelStyle: { fill: 'var(--color-ink-soft)', fontSize: 10, fontWeight: 500 },
      labelBgStyle: { fill: 'var(--color-surface)', stroke: 'var(--color-line)' },
      labelBgPadding: [5, 3],
      labelBgBorderRadius: 4,
      style: {
        stroke: tone,
        strokeWidth: 1.8,
        strokeDasharray: lineageDash(edge.confidence),
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: tone, width: 16, height: 16 },
      ariaLabel: `${labels.get(edge.source) ?? edge.source} to ${labels.get(edge.target) ?? edge.target}, ${edge.label}, ${edge.confidence}`,
      data: {
        kind: edge.kind,
        confidence: edge.confidence,
        label: edge.label,
        detail: edge.detail,
        relationshipCertainty: edge.relationshipCertainty,
        fieldCount: edge.fieldLinks.length,
      },
      deletable: false,
      focusable: true,
    };
  });

  return { nodes, edges };
}

export function getLineagePositions(nodes: LineageFlowNode[]): Record<string, LineagePosition> {
  return Object.fromEntries(nodes.map((node) => [node.id, { ...node.position }]));
}

export function applyLineagePositions(
  nodes: LineageFlowNode[],
  positions: Record<string, LineagePosition>,
): LineageFlowNode[] {
  return nodes.map((node) => {
    const position = positions[node.id];
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return node;
    return { ...node, position: { x: position.x, y: position.y } };
  });
}

export function lineageNodeMatchesSearch(node: LineageFlowNode, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [node.data.label, node.data.apiName, node.data.subtitle, node.data.kind, node.data.dataSpace ?? '']
    .some((value) => value.toLowerCase().includes(needle));
}
