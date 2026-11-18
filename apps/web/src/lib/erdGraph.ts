import dagre from '@dagrejs/dagre';
import type { DataModelObject, InventorySnapshot } from '@dcat/core';
import type { ErdCertaintyFilter, ErdLayoutDirection } from '@dcat/exporters';
import { matchesErdFilter } from '@dcat/exporters';
import { MarkerType, Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';

export type ErdSortMode = 'connected' | 'alphabetical';

export interface ErdPosition {
  x: number;
  y: number;
}

export interface ErdFieldModel {
  apiName: string;
  label: string;
  dataType: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
}

export interface ErdObjectNodeData extends Record<string, unknown> {
  label: string;
  apiName: string;
  fields: ErdFieldModel[];
  fieldCount: number;
  connectionCount: number;
  direction: ErdLayoutDirection;
  dimmed: boolean;
  related: boolean;
}

export interface ErdRelationshipEdgeData extends Record<string, unknown> {
  certainty: 'confirmed' | 'inferred' | 'unknown';
  cardinality: string;
  joinField: string;
  sourceLabel: string;
  targetLabel: string;
}

export type ErdObjectNode = Node<ErdObjectNodeData, 'erdObject'>;
export type ErdRelationshipEdge = Edge<ErdRelationshipEdgeData, 'smoothstep'>;

export const ERD_NODE_WIDTH = 280;
export const ERD_HEADER_HEIGHT = 52;
export const ERD_ROW_HEIGHT = 24;
export const ERD_FOOTER_HEIGHT = 24;
export const ERD_MAX_VISIBLE_FIELDS = 8;
export const ERD_DEFAULT_HANDLE = 'default';

export function erdSourceHandleId(field?: string): string {
  return `source:${field ?? ERD_DEFAULT_HANDLE}`;
}

export function erdTargetHandleId(field?: string): string {
  return `target:${field ?? ERD_DEFAULT_HANDLE}`;
}

export function erdNodeHeight(fieldCount: number): number {
  const visible = Math.min(fieldCount, ERD_MAX_VISIBLE_FIELDS);
  return ERD_HEADER_HEIGHT + visible * ERD_ROW_HEIGHT + (fieldCount > visible ? ERD_FOOTER_HEIGHT : 0);
}

export function erdTone(certainty: ErdRelationshipEdgeData['certainty']): string {
  if (certainty === 'confirmed') return 'var(--color-brand)';
  if (certainty === 'inferred') return 'var(--color-warning)';
  return 'var(--color-ink-faint)';
}

export function erdHandlePosition(direction: ErdLayoutDirection, type: 'source' | 'target'): Position {
  if (type === 'source') return direction === 'LR' ? Position.Right : Position.Bottom;
  return direction === 'LR' ? Position.Left : Position.Top;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sortedFields(object: DataModelObject, foreignKeys: Set<string>): ErdFieldModel[] {
  return [...object.fields]
    .sort((left, right) => left.apiName.localeCompare(right.apiName))
    .map((field) => ({
      apiName: field.apiName,
      label: field.label ?? field.apiName,
      dataType: field.dataType ?? 'Unknown',
      isPrimaryKey: field.isPrimaryKey,
      isForeignKey: foreignKeys.has(field.apiName),
    }));
}

function findJoinField(object: DataModelObject, joinField: string): string | null {
  const target = normalized(joinField);
  if (!target) return null;
  for (const field of object.fields) {
    const apiName = normalized(field.apiName);
    const label = normalized(field.label ?? '');
    if (apiName === target || label === target || apiName.endsWith(target) || label.endsWith(target)) {
      return field.apiName;
    }
  }
  return null;
}

function sortedObjects(
  objects: DataModelObject[],
  sortMode: ErdSortMode,
  connectionCounts: Map<string, number>,
): DataModelObject[] {
  return [...objects].sort((left, right) => {
    const leftLabel = left.label ?? left.apiName;
    const rightLabel = right.label ?? right.apiName;
    if (sortMode === 'connected') {
      const difference = (connectionCounts.get(right.apiName) ?? 0) - (connectionCounts.get(left.apiName) ?? 0);
      if (difference !== 0) return difference;
    }
    return leftLabel.localeCompare(rightLabel) || left.apiName.localeCompare(right.apiName);
  });
}

export interface ErdGraph {
  nodes: ErdObjectNode[];
  edges: ErdRelationshipEdge[];
}

/**
 * Builds a deterministic React Flow graph. Dagre runs here, outside render, and
 * is never recalculated while a node is dragged or the viewport moves.
 */
export function buildErdGraph(
  inventory: InventorySnapshot,
  options: { direction: ErdLayoutDirection; sortMode: ErdSortMode } = {
    direction: 'LR',
    sortMode: 'connected',
  },
): ErdGraph {
  const connectionCounts = new Map<string, number>();
  for (const relationship of inventory.relationships) {
    connectionCounts.set(relationship.source, (connectionCounts.get(relationship.source) ?? 0) + 1);
    connectionCounts.set(relationship.target, (connectionCounts.get(relationship.target) ?? 0) + 1);
  }

  const objects = sortedObjects(inventory.dmos, options.sortMode, connectionCounts);
  const known = new Set(objects.map((object) => object.apiName));
  const relationships = inventory.relationships.filter((edge) => known.has(edge.source) && known.has(edge.target));

  const foreignKeys = new Map<string, Set<string>>();
  for (const relationship of relationships) {
    if (!relationship.label) continue;
    const source = objects.find((object) => object.apiName === relationship.source);
    const field = source ? findJoinField(source, relationship.label) : null;
    if (!source || !field) continue;
    const keys = foreignKeys.get(source.apiName) ?? new Set<string>();
    keys.add(field);
    foreignKeys.set(source.apiName, keys);
  }

  const graph = new dagre.graphlib.Graph({ multigraph: true }).setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: options.direction,
    nodesep: 56,
    ranksep: 148,
    marginx: 40,
    marginy: 40,
    acyclicer: 'greedy',
    ranker: 'network-simplex',
  });

  for (const object of objects) {
    graph.setNode(object.apiName, {
      width: ERD_NODE_WIDTH,
      height: erdNodeHeight(object.fields.length),
    });
  }
  for (const relationship of relationships) {
    graph.setEdge(relationship.source, relationship.target, {}, relationship.id);
  }
  dagre.layout(graph);

  const nodes: ErdObjectNode[] = objects.map((object) => {
    const laidOut = graph.node(object.apiName) as { x?: number; y?: number } | undefined;
    const height = erdNodeHeight(object.fields.length);
    return {
      id: object.apiName,
      type: 'erdObject',
      position: {
        x: (laidOut?.x ?? ERD_NODE_WIDTH / 2) - ERD_NODE_WIDTH / 2,
        y: (laidOut?.y ?? height / 2) - height / 2,
      },
      sourcePosition: erdHandlePosition(options.direction, 'source'),
      targetPosition: erdHandlePosition(options.direction, 'target'),
      data: {
        label: object.label ?? object.apiName,
        apiName: object.apiName,
        fields: sortedFields(object, foreignKeys.get(object.apiName) ?? new Set<string>()),
        fieldCount: object.fields.length,
        connectionCount: connectionCounts.get(object.apiName) ?? 0,
        direction: options.direction,
        dimmed: false,
        related: false,
      },
      ariaLabel: `${object.label ?? object.apiName} (${object.apiName})`,
      focusable: true,
    };
  });

  const byApiName = new Map(objects.map((object) => [object.apiName, object]));
  const edges: ErdRelationshipEdge[] = relationships.map((relationship) => {
    const source = byApiName.get(relationship.source)!;
    const target = byApiName.get(relationship.target)!;
    const joinField = relationship.label ?? relationship.certainty;
    const sourceField = relationship.label ? findJoinField(source, relationship.label) : null;
    const targetField = relationship.label ? findJoinField(target, relationship.label) : null;
    const tone = erdTone(relationship.certainty);
    return {
      id: relationship.id,
      source: relationship.source,
      target: relationship.target,
      sourceHandle: erdSourceHandleId(sourceField ?? undefined),
      targetHandle: erdTargetHandleId(targetField ?? undefined),
      type: 'smoothstep',
      sourcePosition: erdHandlePosition(options.direction, 'source'),
      targetPosition: erdHandlePosition(options.direction, 'target'),
      label: joinField,
      labelStyle: { fill: 'var(--color-ink-soft)', fontSize: 11, fontWeight: 500 },
      labelBgStyle: { fill: 'var(--color-surface)', stroke: 'var(--color-line)' },
      labelBgPadding: [6, 3],
      labelBgBorderRadius: 4,
      style: {
        stroke: tone,
        strokeWidth: 1.8,
        strokeDasharray: relationship.certainty === 'confirmed' ? undefined : '7 5',
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: tone, width: 16, height: 16 },
      ariaLabel: `${source.label ?? source.apiName} to ${target.label ?? target.apiName} via ${joinField}, ${relationship.certainty}`,
      data: {
        certainty: relationship.certainty,
        cardinality: relationship.cardinality ?? '',
        joinField,
        sourceLabel: source.label ?? source.apiName,
        targetLabel: target.label ?? target.apiName,
      },
      deletable: false,
      focusable: true,
    };
  });

  return { nodes, edges };
}

export function filterErdEdges(edges: ErdRelationshipEdge[], filter: ErdCertaintyFilter): ErdRelationshipEdge[] {
  return edges.filter((edge) => matchesErdFilter(edge.data?.certainty ?? 'unknown', filter));
}

export function getErdPositions(nodes: ErdObjectNode[]): Record<string, ErdPosition> {
  return Object.fromEntries(nodes.map((node) => [node.id, { ...node.position }]));
}

export function applyErdPositions(
  nodes: ErdObjectNode[],
  positions: Record<string, ErdPosition>,
): ErdObjectNode[] {
  return nodes.map((node) => {
    const position = positions[node.id];
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return node;
    return { ...node, position: { x: position.x, y: position.y } };
  });
}

export function nodeMatchesSearch(node: ErdObjectNode, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [node.data.label, node.data.apiName, ...node.data.fields.flatMap((field) => [field.label, field.apiName])]
    .some((value) => value.toLowerCase().includes(needle));
}

export function relatedNodeIds(edge: ErdRelationshipEdge | undefined, selectedNodeId: string | null): Set<string> {
  if (!edge || !selectedNodeId) return new Set<string>();
  if (edge.source === selectedNodeId) return new Set([edge.target]);
  if (edge.target === selectedNodeId) return new Set([edge.source]);
  return new Set<string>();
}
