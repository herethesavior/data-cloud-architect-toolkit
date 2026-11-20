import type { InventorySnapshot, ResourceProvenance } from '@dcat/core';
import { buildLineageGraph, filterLineageGraph } from './lineage.ts';
import type {
  LineageConfidence,
  LineageEdge,
  LineageFieldLink,
  LineageGap,
  LineageGraph,
  LineageNode,
  LineageNodeKind,
} from './lineage.ts';

/**
 * Impact analysis is a decision view over the same grounded graph the lineage
 * explorer uses. It never invents field mappings: an exact field link is only
 * emitted when the current snapshot names that field on that object. Broader
 * object-level paths are kept, but labelled as derived rather than source-named.
 */

export type ImpactTargetKind = 'object' | 'field' | 'relationship';
export type ImpactDirection = 'downstream' | 'upstream' | 'both';
export type ImpactDepth = 'direct' | 'all';
export type ImpactGroup = 'mappings' | 'transforms' | 'objects' | 'streams' | 'relationships' | 'gaps';
export type ImpactExplorer =
  | 'dlos'
  | 'dmos'
  | 'data-streams'
  | 'data-transforms'
  | 'mappings'
  | 'erd'
  | 'lineage'
  | 'dictionary';

export interface ImpactTarget {
  id: string;
  kind: ImpactTargetKind;
  label: string;
  anchorLabel: string;
  subtitle: string;
  apiName: string;
  objectKind: 'dlo' | 'dmo' | null;
  objectApiName: string | null;
  fieldApiName: string | null;
  relationshipId: string | null;
  dataSpace: string | null;
  nodeId: string | null;
  edgeId: string | null;
}

export interface ImpactEvidenceStep {
  id: string;
  edgeId: string;
  kind: LineageEdge['kind'] | 'field-mapping' | 'join-hint';
  label: string;
  detail: string;
  confidence: LineageConfidence;
  hop: number;
  source: string;
  target: string;
  provenance: ResourceProvenance | null;
  objectLevelOnly: boolean;
}

export interface ImpactItem {
  id: string;
  kind: LineageNodeKind | 'gap' | 'relationship';
  group: ImpactGroup;
  label: string;
  subtitle: string;
  direction: 'upstream' | 'downstream';
  hop: number;
  confidence: LineageConfidence;
  certainty: 'confirmed' | 'inferred' | 'unknown' | null;
  why: string;
  steps: ImpactEvidenceStep[];
  explorer: ImpactExplorer;
  dataSpace: string | null;
  gapId: string | null;
}

export interface ImpactAnalysisOptions {
  direction?: ImpactDirection;
  depth?: ImpactDepth;
  dataSpace?: string | null;
  graph?: LineageGraph;
}

export interface ImpactAnalysis {
  target: ImpactTarget;
  direction: ImpactDirection;
  depth: ImpactDepth;
  items: ImpactItem[];
  directCount: number;
  totalCount: number;
  downstreamCount: number;
  upstreamCount: number;
  exactFieldMatchCount: number;
  gaps: LineageGap[];
  graph: LineageGraph;
}

const CONFIDENCE_LABELS: Record<LineageConfidence, string> = {
  source: 'Source-named',
  derived: 'DCAT-derived',
  missing: 'Missing reference',
};

export { CONFIDENCE_LABELS as IMPACT_CONFIDENCE_LABELS };

const GROUP_LABELS: Record<ImpactGroup, string> = {
  mappings: 'Mappings to review',
  transforms: 'Transforms to review',
  objects: 'Objects affected',
  streams: 'Streams & sources',
  relationships: 'Relationships to review',
  gaps: 'Integrity gaps',
};

export { GROUP_LABELS as IMPACT_GROUP_LABELS };

function key(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function text(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function objectEntries(inventory: InventorySnapshot): { kind: 'dlo' | 'dmo'; object: InventorySnapshot['dlos'][number] | InventorySnapshot['dmos'][number] }[] {
  return [
    ...inventory.dlos.map((object) => ({ kind: 'dlo' as const, object })),
    ...inventory.dmos.map((object) => ({ kind: 'dmo' as const, object })),
  ];
}

/** Every selectable object, field, and relationship in the active snapshot. */
export function buildImpactTargets(inventory: InventorySnapshot): ImpactTarget[] {
  const targets: ImpactTarget[] = [];

  for (const { kind, object } of objectEntries(inventory)) {
    const label = text(object.label, object.apiName);
    targets.push({
      id: `${kind}:${object.apiName}`,
      kind: 'object',
      label,
      anchorLabel: object.apiName,
      subtitle: `${kind.toUpperCase()} · ${object.dataSpace || 'No data space'}`,
      apiName: object.apiName,
      objectKind: kind,
      objectApiName: object.apiName,
      fieldApiName: null,
      relationshipId: null,
      dataSpace: object.dataSpace ?? null,
      nodeId: `${kind}:${object.apiName}`,
      edgeId: null,
    });

    for (const field of object.fields) {
      const fieldLabel = text(field.label, field.apiName);
      targets.push({
        id: `field:${kind}:${object.apiName}:${field.apiName}`,
        kind: 'field',
        label: fieldLabel,
        anchorLabel: `${object.apiName}.${field.apiName}`,
        subtitle: `${label} · ${kind.toUpperCase()} field · ${field.apiName}`,
        apiName: field.apiName,
        objectKind: kind,
        objectApiName: object.apiName,
        fieldApiName: field.apiName,
        relationshipId: null,
        dataSpace: object.dataSpace ?? null,
        nodeId: `${kind}:${object.apiName}`,
        edgeId: null,
      });
    }
  }

  for (const relationship of inventory.relationships) {
    const label = text(relationship.label, relationship.id);
    targets.push({
      id: `relationship:${relationship.id}`,
      kind: 'relationship',
      label,
      anchorLabel: `${relationship.source} → ${relationship.target}`,
      subtitle: `${relationship.certainty} · ${relationship.source} → ${relationship.target}`,
      apiName: relationship.id,
      objectKind: null,
      objectApiName: null,
      fieldApiName: null,
      relationshipId: relationship.id,
      dataSpace: null,
      nodeId: null,
      edgeId: `relationship:${relationship.id}`,
    });
  }

  const order: Record<ImpactTargetKind, number> = { object: 0, field: 1, relationship: 2 };
  return targets.sort((left, right) =>
    order[left.kind] - order[right.kind]
    || left.label.localeCompare(right.label)
    || left.anchorLabel.localeCompare(right.anchorLabel));
}

/** Resolves a persisted or deep-linked target id without trusting its contents. */
export function resolveImpactTarget(inventory: InventorySnapshot, id: string | null | undefined): ImpactTarget | null {
  if (!id?.trim()) return null;
  const targets = buildImpactTargets(inventory);
  return targets.find((target) => target.id === id)
    ?? targets.find((target) => key(target.id) === key(id))
    ?? null;
}

interface ExactFieldMatch {
  edge: LineageEdge;
  link: LineageFieldLink;
  side: 'source' | 'target';
}

function findExactFieldMatches(graph: LineageGraph, target: ImpactTarget): ExactFieldMatch[] {
  if (target.kind !== 'field' || !target.nodeId || !target.fieldApiName) return [];
  const matches: ExactFieldMatch[] = [];
  for (const edge of graph.edges) {
    for (const link of edge.fieldLinks) {
      if (edge.source === target.nodeId && key(link.sourceField) === key(target.fieldApiName)) {
        matches.push({ edge, link, side: 'source' });
        continue;
      }
      if (edge.target === target.nodeId && key(link.targetField) === key(target.fieldApiName)) {
        matches.push({ edge, link, side: 'target' });
      }
    }
  }
  return matches;
}

function nodeLabel(node: LineageNode | undefined, id: string): string {
  return node ? text(node.label, node.apiName) : id.split(':').slice(1).join(':') || id;
}

function explorerForNode(node: LineageNode | undefined): ImpactExplorer {
  if (!node) return 'lineage';
  if (node.kind === 'dlo') return 'dlos';
  if (node.kind === 'dmo') return 'dmos';
  if (node.kind === 'stream' || node.kind === 'connector') return 'data-streams';
  if (node.kind === 'transform') return 'data-transforms';
  return 'lineage';
}

function groupForEdge(edge: LineageEdge): ImpactGroup {
  if (edge.kind === 'mapping') return 'mappings';
  if (edge.kind === 'transform-input' || edge.kind === 'transform-output') return 'transforms';
  if (edge.kind === 'relationship') return 'relationships';
  return 'streams';
}

function groupForNode(node: LineageNode | undefined): ImpactGroup {
  if (!node || node.kind === 'external') return 'gaps';
  if (node.kind === 'dlo' || node.kind === 'dmo') return 'objects';
  if (node.kind === 'transform') return 'transforms';
  return 'streams';
}

function edgeItemLabel(edge: LineageEdge, next: LineageNode | undefined): string {
  if (edge.kind === 'mapping') return text(edge.label, 'Data mapping');
  if (edge.kind === 'relationship') return `Relationship · ${text(edge.label, edge.relationshipCertainty ?? 'unspecified')}`;
  if (edge.kind === 'transform-input') return `Input · ${nodeLabel(next, edge.target)}`;
  if (edge.kind === 'transform-output') return `Output · ${nodeLabel(next, edge.target)}`;
  return `${text(edge.label, 'Ingestion')} · ${nodeLabel(next, edge.target)}`;
}

function makeChain(anchor: string, steps: ImpactEvidenceStep[], end: string): string {
  return [anchor, ...steps.map((step) => step.label), end].filter(Boolean).join(' → ');
}

/**
 * Builds a depth-aware, evidence-carrying impact summary from a snapshot.
 * Exact field links are never widened by name similarity; object-level paths
 * remain visible but are marked derived when starting from a field.
 */
export function analyzeImpact(
  inventory: InventorySnapshot,
  target: ImpactTarget,
  options: ImpactAnalysisOptions = {},
): ImpactAnalysis {
  const direction = options.direction ?? 'both';
  const depth = options.depth ?? 'direct';
  const baseGraph = options.graph ?? buildLineageGraph(inventory);
  const graph = options.dataSpace
    ? filterLineageGraph(baseGraph, { dataSpace: options.dataSpace })
    : baseGraph;

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const items: ImpactItem[] = [];
  const itemKeys = new Set<string>();
  const visitedNodes = new Set<string>();
  const exactMatches = findExactFieldMatches(graph, target);

  const addItem = (item: ImpactItem) => {
    const itemKey = `${item.id}:${item.direction}:${item.group}`;
    if (itemKeys.has(itemKey)) return;
    itemKeys.add(itemKey);
    items.push(item);
  };

  const addEdgeItem = (
    edge: LineageEdge,
    step: ImpactEvidenceStep,
    next: LineageNode | undefined,
    dir: 'upstream' | 'downstream',
  ) => {
    const confidence = step.objectLevelOnly ? 'derived' : edge.confidence;
    const group = groupForEdge(edge);
    const explorer: ImpactExplorer = group === 'relationships'
      ? 'erd'
      : group === 'mappings'
        ? 'mappings'
        : group === 'transforms'
          ? 'data-transforms'
          : 'data-streams';
    addItem({
      id: edge.id,
      kind: edge.kind === 'relationship' ? 'relationship' : (next?.kind ?? 'external'),
      group,
      label: edgeItemLabel(edge, next),
      subtitle: `${nodeLabel(nodeById.get(edge.source), edge.source)} → ${nodeLabel(nodeById.get(edge.target), edge.target)}`,
      direction: dir,
      hop: step.hop,
      confidence,
      certainty: edge.relationshipCertainty,
      why: makeChain(target.anchorLabel, [step], nodeLabel(next, step.target)),
      steps: [step],
      explorer,
      dataSpace: next?.dataSpace ?? null,
      gapId: confidence === 'missing' ? `gap:${edge.id}` : null,
    });
  };

  const addNodeItem = (node: LineageNode | undefined, step: ImpactEvidenceStep, dir: 'upstream' | 'downstream') => {
    if (!node || node.kind === 'transform') return;
    addItem({
      id: node.id,
      kind: node.kind,
      group: groupForNode(node),
      label: nodeLabel(node, node.id),
      subtitle: text(node.subtitle, node.kind.toUpperCase()),
      direction: dir,
      hop: step.hop,
      confidence: step.objectLevelOnly ? 'derived' : step.confidence,
      certainty: null,
      why: makeChain(target.anchorLabel, [step], nodeLabel(node, node.id)),
      steps: [step],
      explorer: explorerForNode(node),
      dataSpace: node.dataSpace,
      gapId: node.kind === 'external' ? `gap:${step.edgeId}` : null,
    });
  };

  const makeStep = (
    edge: LineageEdge,
    directionOfEdge: 'upstream' | 'downstream',
    hop: number,
    match: ExactFieldMatch | null,
  ): ImpactEvidenceStep => {
    const nextId = directionOfEdge === 'downstream' ? edge.target : edge.source;
    const objectLevelOnly = target.kind !== 'object' && !match;
    let label = `${text(edge.label, edge.kind)} → ${nodeLabel(nodeById.get(nextId), nextId)}`;
    let detail = edge.detail;
    if (match) {
      const fieldPair = `${match.link.sourceField} → ${match.link.targetField}`;
      label = edge.kind === 'relationship'
        ? `Join hint ${fieldPair}`
        : `${text(edge.label, 'Mapping')} · ${fieldPair}`;
      detail = match.link.transformation
        ? `${edge.detail} Transformation: ${match.link.transformation}.`
        : `${edge.detail} Exact field link named in the current snapshot for ${target.anchorLabel}.`;
    } else if (objectLevelOnly) {
      detail = `${edge.detail} Reached through object-level lineage; field continuity is not recorded past this point.`;
      label = `Object-level · ${label}`;
    }
    return {
      id: `${edge.id}:${directionOfEdge}:${match ? 'field' : 'object'}`,
      edgeId: edge.id,
      kind: match ? (edge.kind === 'relationship' ? 'join-hint' : 'field-mapping') : edge.kind,
      label,
      detail,
      confidence: objectLevelOnly ? 'derived' : edge.confidence,
      hop,
      source: edge.source,
      target: nextId,
      provenance: edge.provenance,
      objectLevelOnly,
    };
  };

  // Exact field matches are added before the general walk so their evidence,
  // rather than the object-level label, wins when both reach the same edge.
  for (const match of exactMatches) {
    const dir = match.side === 'source' ? 'downstream' : 'upstream';
    if (direction !== 'both' && direction !== dir) continue;
    const step = makeStep(match.edge, dir, 1, match);
    const nextId = step.target;
    const next = nodeById.get(nextId);
    addEdgeItem(match.edge, step, next, dir);
    visitedNodes.add(nextId);
    addNodeItem(next, step, dir);
  }

  const relationshipEdge = target.kind === 'relationship' && target.edgeId
    ? edgeById.get(target.edgeId)
    : null;
  if (relationshipEdge) {
    for (const dir of ['downstream', 'upstream'] as const) {
      if (direction !== 'both' && direction !== dir) continue;
      const step = makeStep(relationshipEdge, dir, 1, null);
      const nextId = step.target;
      const next = nodeById.get(nextId);
      addEdgeItem(relationshipEdge, step, next, dir);
      visitedNodes.add(nextId);
      addNodeItem(next, step, dir);
    }
  }

  const forward = new Map<string, LineageEdge[]>();
  const backward = new Map<string, LineageEdge[]>();
  for (const edge of graph.edges) {
    forward.set(edge.source, [...(forward.get(edge.source) ?? []), edge]);
    backward.set(edge.target, [...(backward.get(edge.target) ?? []), edge]);
  }

  interface QueueEntry {
    nodeId: string;
    hop: number;
    steps: ImpactEvidenceStep[];
    dir: 'upstream' | 'downstream';
  }

  const walk = (dir: 'upstream' | 'downstream', startIds: string[]) => {
    const adjacency = dir === 'downstream' ? forward : backward;
    const seen = new Set(startIds);
    const queue: QueueEntry[] = startIds.map((nodeId) => ({ nodeId, hop: 0, steps: [], dir }));
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      for (const edge of adjacency.get(current.nodeId) ?? []) {
        const nextId = dir === 'downstream' ? edge.target : edge.source;
        if (seen.has(nextId)) continue;
        const hop = current.hop + 1;
        if (depth === 'direct' && hop > 1) continue;
        seen.add(nextId);
        visitedNodes.add(nextId);
        const match = exactMatches.find((candidate) => candidate.edge.id === edge.id) ?? null;
        const step = makeStep(edge, dir, hop, match);
        const next = nodeById.get(nextId);
        addEdgeItem(edge, step, next, dir);
        addNodeItem(next, step, dir);
        queue.push({ nodeId: nextId, hop, steps: [...current.steps, step], dir });
      }
    }
  };

  const startIds = target.nodeId ? [target.nodeId] : [];
  if (target.kind === 'relationship' && relationshipEdge) {
    if (direction === 'both' || direction === 'downstream') walk('downstream', [relationshipEdge.target]);
    if (direction === 'both' || direction === 'upstream') walk('upstream', [relationshipEdge.source]);
  } else {
    if (direction === 'both' || direction === 'downstream') walk('downstream', startIds);
    if (direction === 'both' || direction === 'upstream') walk('upstream', startIds);
  }

  const gaps = graph.gaps.filter((gap) => gap.focusNodeId && visitedNodes.has(gap.focusNodeId));
  for (const gap of gaps) {
    addItem({
      id: gap.id,
      kind: 'gap',
      group: 'gaps',
      label: gap.label,
      subtitle: gap.severity === 'warning' ? 'Needs review' : 'Informational',
      direction: 'downstream',
      hop: 1,
      confidence: 'missing',
      certainty: null,
      why: gap.detail,
      steps: [],
      explorer: 'lineage',
      dataSpace: null,
      gapId: gap.id,
    });
  }

  const order: Record<ImpactGroup, number> = {
    mappings: 0,
    transforms: 1,
    streams: 2,
    objects: 3,
    relationships: 4,
    gaps: 5,
  };
  items.sort((left, right) =>
    order[left.group] - order[right.group]
    || left.hop - right.hop
    || left.label.localeCompare(right.label)
    || left.direction.localeCompare(right.direction));

  const downstreamCount = items.filter((item) => item.direction === 'downstream').length;
  const upstreamCount = items.length - downstreamCount;
  return {
    target,
    direction,
    depth,
    items,
    directCount: items.filter((item) => item.hop === 1).length,
    totalCount: items.length,
    downstreamCount,
    upstreamCount,
    exactFieldMatchCount: exactMatches.filter((match) =>
      direction === 'both'
      || direction === (match.side === 'source' ? 'downstream' : 'upstream')).length,
    gaps,
    graph,
  };
}

/** A compact, shareable summary of why an item appeared. */
export function impactEvidenceText(item: ImpactItem): string {
  return item.steps.map((step) => step.label).join(' · ') || item.why;
}

/** Whether the snapshot has enough family data to trust an impact result. */
export function impactSnapshotComplete(inventory: InventorySnapshot): boolean {
  const required = ['dlos', 'dmos', 'mappings', 'data-streams', 'data-transforms'] as const;
  return required.every((family) => {
    const capability = inventory.capabilities.find((entry) => entry.family === family);
    return !capability || capability.status === 'available' || capability.status === 'not-started';
  });
}
