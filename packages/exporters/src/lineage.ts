import type {
  DataLakeObject,
  DataModelObject,
  DataStream,
  DataTransform,
  InventorySnapshot,
  ResourceProvenance,
} from '@dcat/core';
import type { ErdPalette } from './erd.ts';

/**
 * The lineage model is deliberately framework-agnostic and shared by the React
 * Flow canvas and the exporters. Every link comes from a reference that exists
 * in the current snapshot; only DCAT's own discovery step may mark a link as
 * derived, and missing references stay visible as gaps.
 */

export type LineageNodeKind = 'connector' | 'stream' | 'dlo' | 'transform' | 'dmo' | 'external';
export type LineageEdgeKind = 'ingestion' | 'mapping' | 'transform-input' | 'transform-output' | 'relationship';
export type LineageConfidence = 'source' | 'derived' | 'missing';
export type LineageTraceMode = 'off' | 'both' | 'upstream' | 'downstream';
export type LineageLayoutDirection = 'LR' | 'TB';

export interface LineageEntity {
  kind: LineageNodeKind;
  value: DataStream | DataLakeObject | DataTransform | DataModelObject | { name: string };
}

export interface LineageNode {
  id: string;
  kind: LineageNodeKind;
  apiName: string;
  label: string;
  subtitle: string;
  dataSpace: string | null;
  status: string | null;
  provenance: ResourceProvenance | null;
  unresolved: boolean;
  expectedKind: 'dlo' | 'dmo' | null;
  degree: number;
  entity: LineageEntity | null;
}

export interface LineageFieldLink {
  sourceField: string;
  targetField: string;
  transformation: string | null;
}

export interface LineageEdge {
  id: string;
  kind: LineageEdgeKind;
  source: string;
  target: string;
  label: string;
  detail: string;
  confidence: LineageConfidence;
  relationshipCertainty: 'confirmed' | 'inferred' | 'unknown' | null;
  /** Source status for relationship edges; never inferred by DCAT. */
  relationshipStatus?: string | null;
  fieldLinks: LineageFieldLink[];
  provenance: ResourceProvenance | null;
}

export interface LineageGap {
  id: string;
  kind: 'missing-reference' | 'missing-target' | 'orphan';
  severity: 'warning' | 'info';
  label: string;
  detail: string;
  focusNodeId: string | null;
}

export interface LineageGraph {
  org: {
    alias: string;
    mode: 'demo' | 'live';
    generatedAt: string;
    apiVersion: string | null;
  };
  nodes: LineageNode[];
  edges: LineageEdge[];
  gaps: LineageGap[];
  dataSpaces: string[];
}

export const LINEAGE_STAGES: { kind: LineageNodeKind; label: string }[] = [
  { kind: 'connector', label: 'Source systems' },
  { kind: 'stream', label: 'Data Streams' },
  { kind: 'dlo', label: 'Data Lake Objects' },
  { kind: 'transform', label: 'Data Transforms' },
  { kind: 'dmo', label: 'Data Model Objects' },
  { kind: 'external', label: 'Missing references' },
];

export const ALL_LINEAGE_NODE_KINDS: LineageNodeKind[] = LINEAGE_STAGES.map((stage) => stage.kind);
export const ALL_LINEAGE_CONFIDENCES: LineageConfidence[] = ['source', 'derived', 'missing'];

export interface LineagePalette extends ErdPalette {
  danger: string;
}

function text(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function key(value: string): string {
  return value.trim().toLowerCase();
}

function nodeId(kind: LineageNodeKind, apiName: string): string {
  return `${kind}:${apiName}`;
}

function byLabel(a: { label?: string | null; apiName: string }, b: { label?: string | null; apiName: string }): number {
  return text(a.label, a.apiName).localeCompare(text(b.label, b.apiName)) || a.apiName.localeCompare(b.apiName);
}

interface ObjectIndex {
  dlos: Map<string, DataLakeObject>;
  dmos: Map<string, DataModelObject>;
}

function buildObjectIndex(inventory: InventorySnapshot): ObjectIndex {
  const dlos = new Map<string, DataLakeObject>();
  const dmos = new Map<string, DataModelObject>();
  for (const dlo of inventory.dlos) dlos.set(key(dlo.apiName), dlo);
  for (const dmo of inventory.dmos) dmos.set(key(dmo.apiName), dmo);
  return { dlos, dmos };
}

function resolveObject(index: ObjectIndex, name: string | null | undefined):
  { kind: 'dlo' | 'dmo'; value: DataLakeObject | DataModelObject } | null {
  const apiName = text(name, '');
  if (!apiName) return null;
  const dlo = index.dlos.get(key(apiName));
  if (dlo) return { kind: 'dlo', value: dlo };
  const dmo = index.dmos.get(key(apiName));
  if (dmo) return { kind: 'dmo', value: dmo };
  return null;
}

function streamDataSpace(inventory: InventorySnapshot, stream: DataStream): string | null {
  const direct = stream.dataSpace?.trim();
  if (direct) return direct;
  if (!stream.targetDlo) return null;
  const target = inventory.dlos.find((dlo) => key(dlo.apiName) === key(stream.targetDlo ?? ''));
  return target?.dataSpace?.trim() || null;
}

function baseEdge(edge: Omit<LineageEdge, 'fieldLinks' | 'relationshipCertainty'>): LineageEdge {
  return { ...edge, fieldLinks: [], relationshipCertainty: null };
}

/** Derives one grounded flow graph from the six metadata families in a snapshot. */
export function buildLineageGraph(inventory: InventorySnapshot): LineageGraph {
  const index = buildObjectIndex(inventory);
  const nodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];
  const gaps: LineageGap[] = [];
  const edgeIds = new Set<string>();
  const externals = new Map<string, LineageNode>();

  const addEdge = (edge: LineageEdge) => {
    if (edgeIds.has(edge.id)) return;
    edgeIds.add(edge.id);
    edges.push(edge);
  };

  const ensureExternal = (
    name: string,
    expectedKind: 'dlo' | 'dmo',
    provenance: ResourceProvenance | null,
  ): LineageNode => {
    const externalKey = `${expectedKind}:${key(name)}`;
    const existing = externals.get(externalKey);
    if (existing) return existing;
    const node: LineageNode = {
      id: nodeId('external', `${expectedKind}:${name}`),
      kind: 'external',
      apiName: name,
      label: name,
      subtitle: `Referenced ${expectedKind.toUpperCase()} not in this snapshot`,
      dataSpace: null,
      status: null,
      provenance,
      unresolved: true,
      expectedKind,
      degree: 0,
      entity: { kind: 'external', value: { name } },
    };
    externals.set(externalKey, node);
    nodes.push(node);
    return node;
  };

  const connectorNames = new Set<string>();
  for (const stream of inventory.dataStreams) {
    const connector = text(stream.sourceConnector, '');
    if (connector) connectorNames.add(connector);
  }
  for (const name of [...connectorNames].sort((left, right) => left.localeCompare(right))) {
    nodes.push({
      id: nodeId('connector', name),
      kind: 'connector',
      apiName: name,
      label: name,
      subtitle: 'Source system named by stream metadata',
      dataSpace: null,
      status: null,
      provenance: null,
      unresolved: false,
      expectedKind: null,
      degree: 0,
      entity: { kind: 'connector', value: { name } },
    });
  }

  for (const stream of [...inventory.dataStreams].sort(byLabel)) {
    const id = nodeId('stream', stream.apiName);
    nodes.push({
      id,
      kind: 'stream',
      apiName: stream.apiName,
      label: text(stream.label, stream.apiName),
      subtitle: text(stream.sourceConnector, 'Ingestion stream'),
      dataSpace: streamDataSpace(inventory, stream),
      status: stream.status?.trim() ?? null,
      provenance: stream.provenance,
      unresolved: false,
      expectedKind: null,
      degree: 0,
      entity: { kind: 'stream', value: stream },
    });

    const connector = text(stream.sourceConnector, '');
    if (connector) {
      addEdge(baseEdge({
        id: `ingest:${stream.apiName}:source`,
        kind: 'ingestion',
        source: nodeId('connector', connector),
        target: id,
        label: 'source system',
        detail: `Stream metadata names ${connector} as the source connector.`,
        confidence: 'source',
        provenance: stream.provenance,
      }));
    }

    const targetName = text(stream.targetDlo, '');
    if (!targetName) {
      gaps.push({
        id: `gap:stream-target:${stream.apiName}`,
        kind: 'missing-target',
        severity: 'warning',
        label: `${text(stream.label, stream.apiName)} has no target object`,
        detail: 'The stream metadata does not name a target DLO, so no downstream path can be shown.',
        focusNodeId: id,
      });
      continue;
    }
    const target = resolveObject(index, targetName);
    const targetNode = target
      ? nodeId(target.kind, target.value.apiName)
      : ensureExternal(targetName, 'dlo', stream.provenance).id;
    addEdge(baseEdge({
      id: `ingest:${stream.apiName}:${targetName}`,
      kind: 'ingestion',
      source: id,
      target: targetNode,
      label: 'ingests',
      detail: target
        ? `Stream target ${targetName} is present in the snapshot${stream.refreshMetadata ? ` · cadence ${stream.refreshMetadata}` : ''}.`
        : `Stream names target ${targetName}, but that object is not in the snapshot.`,
      confidence: target ? 'source' : 'missing',
      provenance: stream.provenance,
    }));
  }

  for (const dlo of [...inventory.dlos].sort(byLabel)) {
    nodes.push({
      id: nodeId('dlo', dlo.apiName),
      kind: 'dlo',
      apiName: dlo.apiName,
      label: text(dlo.label, dlo.apiName),
      subtitle: text(dlo.category, 'Data Lake Object'),
      dataSpace: dlo.dataSpace?.trim() || null,
      status: null,
      provenance: dlo.provenance,
      unresolved: false,
      expectedKind: null,
      degree: 0,
      entity: { kind: 'dlo', value: dlo },
    });
  }

  for (const transform of [...inventory.dataTransforms].sort(byLabel)) {
    const id = nodeId('transform', transform.apiName);
    nodes.push({
      id,
      kind: 'transform',
      apiName: transform.apiName,
      label: text(transform.label, transform.apiName),
      subtitle: text(transform.type, text(transform.status, 'Data Transform')),
      dataSpace: transform.dataSpace?.trim() || null,
      status: transform.status?.trim() ?? null,
      provenance: transform.provenance,
      unresolved: false,
      expectedKind: null,
      degree: 0,
      entity: { kind: 'transform', value: transform },
    });

    for (const input of transform.inputs ?? []) {
      const name = text(input, '');
      if (!name) continue;
      const resolved = resolveObject(index, name);
      const inputNode = resolved
        ? nodeId(resolved.kind, resolved.value.apiName)
        : ensureExternal(name, 'dlo', transform.provenance).id;
      addEdge(baseEdge({
        id: `transform-input:${transform.apiName}:${name}`,
        kind: 'transform-input',
        source: inputNode,
        target: id,
        label: 'input',
        detail: resolved
          ? `Transform metadata names ${name} as an input, and the object is present in the snapshot.`
          : `Transform names input ${name}, but that object is not in the snapshot.`,
        confidence: resolved ? 'source' : 'missing',
        provenance: transform.provenance,
      }));
    }

    for (const output of transform.outputs ?? []) {
      const name = text(output, '');
      if (!name) continue;
      const resolved = resolveObject(index, name);
      const outputNode = resolved
        ? nodeId(resolved.kind, resolved.value.apiName)
        : ensureExternal(name, 'dmo', transform.provenance).id;
      addEdge(baseEdge({
        id: `transform-output:${transform.apiName}:${name}`,
        kind: 'transform-output',
        source: id,
        target: outputNode,
        label: 'output',
        detail: resolved
          ? `Transform metadata names ${name} as an output, and the object is present in the snapshot.`
          : `Transform names output ${name}, but that object is not in the snapshot.`,
        confidence: resolved ? 'source' : 'missing',
        provenance: transform.provenance,
      }));
    }
  }

  for (const mapping of [...inventory.mappings].sort((left, right) =>
    text(left.apiName, left.sourceObject).localeCompare(text(right.apiName, right.sourceObject)))) {
    const source = resolveObject(index, mapping.sourceObject);
    const target = resolveObject(index, mapping.targetObject);
    const sourceNode = source
      ? nodeId(source.kind, source.value.apiName)
      : ensureExternal(mapping.sourceObject, 'dlo', mapping.provenance).id;
    const targetNode = target
      ? nodeId(target.kind, target.value.apiName)
      : ensureExternal(mapping.targetObject, 'dmo', mapping.provenance).id;
    const fieldLinks: LineageFieldLink[] = mapping.fieldMappings.map((field) => ({
      sourceField: field.sourceField,
      targetField: field.targetField,
      transformation: field.transformation?.trim() || null,
    }));
    const preview = fieldLinks.slice(0, 4)
      .map((field) => `${field.sourceField} → ${field.targetField}`)
      .join(', ');
    addEdge({
      ...baseEdge({
        id: `mapping:${text(mapping.apiName, `${mapping.sourceObject}:${mapping.targetObject}`)}`,
        kind: 'mapping',
        source: sourceNode,
        target: targetNode,
        label: text(mapping.apiName, fieldLinks.length ? `${fieldLinks.length} fields` : 'mapping'),
        detail: fieldLinks.length
          ? `${fieldLinks.length} field mappings: ${preview}${fieldLinks.length > 4 ? '…' : ''}`
          : 'Mapping metadata has no field-level detail.',
        confidence: source && target ? 'source' : 'missing',
        provenance: mapping.provenance,
      }),
      fieldLinks,
    });
  }

  for (const dmo of [...inventory.dmos].sort(byLabel)) {
    nodes.push({
      id: nodeId('dmo', dmo.apiName),
      kind: 'dmo',
      apiName: dmo.apiName,
      label: text(dmo.label, dmo.apiName),
      subtitle: text(dmo.category, 'Data Model Object'),
      dataSpace: dmo.dataSpace?.trim() || null,
      status: null,
      provenance: dmo.provenance,
      unresolved: false,
      expectedKind: null,
      degree: 0,
      entity: { kind: 'dmo', value: dmo },
    });
  }

  for (const relationship of inventory.relationships) {
    const source = resolveObject(index, relationship.source);
    const target = resolveObject(index, relationship.target);
    const sourceNode = source
      ? nodeId(source.kind, source.value.apiName)
      : ensureExternal(relationship.source, 'dmo', relationship.provenance).id;
    const targetNode = target
      ? nodeId(target.kind, target.value.apiName)
      : ensureExternal(relationship.target, 'dmo', relationship.provenance).id;
    addEdge({
      ...baseEdge({
        id: `relationship:${relationship.id}`,
        kind: 'relationship',
        source: sourceNode,
        target: targetNode,
        label: text(relationship.label, relationship.certainty),
        detail: relationship.certainty === 'confirmed'
          ? `Source-confirmed relationship${relationship.status ? ` · status ${relationship.status}` : ''}${relationship.cardinality ? ` · ${relationship.cardinality}` : ''}.`
          : `DCAT-derived relationship (${relationship.certainty})${relationship.status ? ` · status ${relationship.status}` : ''}${relationship.cardinality ? ` · ${relationship.cardinality}` : ''}. Not a source fact.`,
        confidence: relationship.certainty === 'confirmed' ? 'source' : 'derived',
        provenance: relationship.provenance,
      }),
      relationshipCertainty: relationship.certainty,
      relationshipStatus: relationship.status ?? null,
      fieldLinks: relationship.label && relationship.targetField
        ? [{
          sourceField: relationship.label,
          targetField: relationship.targetField,
          transformation: null,
        }]
        : [],
    });
  }

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  for (const node of nodes) node.degree = degree.get(node.id) ?? 0;

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    if (edge.confidence !== 'missing') continue;
    const target = nodeById.get(edge.target);
    const expected = target?.expectedKind?.toUpperCase() ?? 'OBJECT';
    gaps.push({
      id: `gap:${edge.id}`,
      kind: 'missing-reference',
      severity: 'warning',
      label: `Unresolved ${expected}: ${edge.target.split(':').slice(1).join(':')}`,
      detail: edge.detail,
      focusNodeId: edge.target,
    });
  }
  for (const node of nodes) {
    if (node.kind === 'external' || node.kind === 'connector' || node.degree > 0) continue;
    gaps.push({
      id: `gap:orphan:${node.id}`,
      kind: 'orphan',
      severity: 'info',
      label: `Unconnected ${node.kind.toUpperCase()}: ${node.label}`,
      detail: 'This object is in the snapshot but no stream, mapping, transform, or relationship references it.',
      focusNodeId: node.id,
    });
  }
  gaps.sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === 'warning' ? -1 : 1;
    return left.label.localeCompare(right.label);
  });

  const spaces = new Set<string>();
  for (const space of inventory.dataSpaces) {
    if (space.apiName.trim()) spaces.add(space.apiName.trim());
  }
  for (const node of nodes) {
    if (node.dataSpace) spaces.add(node.dataSpace);
  }

  return {
    org: {
      alias: inventory.org.alias,
      mode: inventory.mode,
      generatedAt: inventory.generatedAt,
      apiVersion: inventory.apiVersion ?? null,
    },
    nodes,
    edges,
    gaps,
    dataSpaces: [...spaces].sort((left, right) => left.localeCompare(right)),
  };
}

export interface LineageFilterOptions {
  kinds?: LineageNodeKind[];
  confidences?: LineageConfidence[];
  dataSpace?: string | null;
}

/** Filters nodes first, then keeps only links whose endpoints survived. */
export function filterLineageGraph(
  graph: LineageGraph,
  options: LineageFilterOptions = {},
): LineageGraph {
  const kinds = options.kinds ?? ALL_LINEAGE_NODE_KINDS;
  const confidences = options.confidences ?? ALL_LINEAGE_CONFIDENCES;
  const dataSpace = options.dataSpace?.trim() || null;

  const nodes = graph.nodes.filter((node) => {
    if (!kinds.includes(node.kind)) return false;
    // Unassigned objects stay visible as context; objects explicitly assigned
    // to another Data Space are hidden by the Data Space filter.
    if (dataSpace && node.dataSpace && node.dataSpace !== dataSpace) return false;
    return true;
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  let edges = graph.edges.filter((edge) =>
    confidences.includes(edge.confidence) && nodeIds.has(edge.source) && nodeIds.has(edge.target));

  // With a link-type filter active, isolated nodes are noise rather than
  // context. Keep all nodes when nothing matched so the view is not blank.
  if (confidences.length < ALL_LINEAGE_CONFIDENCES.length && edges.length > 0) {
    const connected = new Set<string>();
    for (const edge of edges) {
      connected.add(edge.source);
      connected.add(edge.target);
    }
    const connectedNodes = nodes.filter((node) => connected.has(node.id));
    const connectedIds = new Set(connectedNodes.map((node) => node.id));
    edges = edges.filter((edge) => connectedIds.has(edge.source) && connectedIds.has(edge.target));
    return {
      ...graph,
      nodes: connectedNodes,
      edges,
      gaps: graph.gaps.filter((gap) => !gap.focusNodeId || connectedIds.has(gap.focusNodeId)),
    };
  }

  return {
    ...graph,
    nodes,
    edges,
    gaps: graph.gaps.filter((gap) => !gap.focusNodeId || nodeIds.has(gap.focusNodeId)),
  };
}

export interface LineageNeighborhood {
  nodes: Set<string>;
  edges: Set<string>;
  upstreamCount: number;
  downstreamCount: number;
}

function walk(
  startId: string,
  adjacency: Map<string, LineageEdge[]>,
  direction: 'upstream' | 'downstream',
): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>([startId]);
  const edges = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const edge of adjacency.get(current) ?? []) {
      const next = direction === 'downstream' ? edge.target : edge.source;
      if (nodes.has(next)) continue;
      nodes.add(next);
      edges.add(edge.id);
      queue.push(next);
    }
  }
  return { nodes, edges };
}

/** BFS trace of every path into and/or out of a selected step. */
export function lineageNeighborhood(
  graph: LineageGraph,
  nodeIdValue: string,
  mode: Exclude<LineageTraceMode, 'off'>,
): LineageNeighborhood {
  const forward = new Map<string, LineageEdge[]>();
  const backward = new Map<string, LineageEdge[]>();
  for (const edge of graph.edges) {
    forward.set(edge.source, [...(forward.get(edge.source) ?? []), edge]);
    backward.set(edge.target, [...(backward.get(edge.target) ?? []), edge]);
  }

  if (mode === 'upstream' || mode === 'downstream') {
    const result = walk(nodeIdValue, mode === 'upstream' ? backward : forward, mode);
    return {
      ...result,
      upstreamCount: mode === 'upstream' ? result.nodes.size - 1 : 0,
      downstreamCount: mode === 'downstream' ? result.nodes.size - 1 : 0,
    };
  }

  const upstream = walk(nodeIdValue, backward, 'upstream');
  const downstream = walk(nodeIdValue, forward, 'downstream');
  return {
    nodes: new Set([...upstream.nodes, ...downstream.nodes]),
    edges: new Set([...upstream.edges, ...downstream.edges]),
    upstreamCount: upstream.nodes.size - 1,
    downstreamCount: downstream.nodes.size - 1,
  };
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export interface LineageSvgNode {
  node: LineageNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LineageSvgEdge {
  edge: LineageEdge;
  path: string;
  labelX: number;
  labelY: number;
}

export interface LineageSvgLayout {
  width: number;
  height: number;
  columns: { kind: LineageNodeKind; label: string; offset: number }[];
  nodes: LineageSvgNode[];
  edges: LineageSvgEdge[];
}

const SVG_NODE_WIDTH = 200;
const SVG_NODE_HEIGHT = 66;

/** Deterministic stage layout for static exports; the canvas uses dagre. */
export function buildLineageSvgLayout(
  graph: LineageGraph,
  direction: LineageLayoutDirection = 'LR',
): LineageSvgLayout {
  const stageGap = direction === 'LR' ? 100 : 78;
  const rowGap = 20;
  const margin = 48;
  const header = 76;
  const nodes: LineageSvgNode[] = [];
  const columns: LineageSvgLayout['columns'] = [];
  const positions = new Map<string, LineageSvgNode>();
  let maxRows = 1;

  LINEAGE_STAGES.forEach((stage, stageIndex) => {
    const stageNodes = graph.nodes
      .filter((node) => node.kind === stage.kind)
      .sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label));
    maxRows = Math.max(maxRows, stageNodes.length);
    const offset = direction === 'LR'
      ? margin + stageIndex * (SVG_NODE_WIDTH + stageGap)
      : header + stageIndex * (SVG_NODE_HEIGHT + stageGap);
    columns.push({ kind: stage.kind, label: stage.label, offset });

    stageNodes.forEach((node, rowIndex) => {
      const placed: LineageSvgNode = {
        node,
        x: direction === 'LR' ? offset : margin + rowIndex * (SVG_NODE_WIDTH + rowGap),
        y: direction === 'LR' ? header + rowIndex * (SVG_NODE_HEIGHT + rowGap) : offset,
        width: SVG_NODE_WIDTH,
        height: SVG_NODE_HEIGHT,
      };
      nodes.push(placed);
      positions.set(node.id, placed);
    });
  });

  const edges: LineageSvgEdge[] = [];
  graph.edges.forEach((edge, index) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) return;
    let path: string;
    let labelX: number;
    let labelY: number;
    if (direction === 'LR') {
      const x1 = source.x + source.width;
      const y1 = source.y + source.height / 2;
      const x2 = target.x;
      const y2 = target.y + target.height / 2;
      const bend = Math.max(36, Math.abs(x2 - x1) / 2);
      path = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
      labelX = (x1 + x2) / 2;
      labelY = (y1 + y2) / 2 + (index % 3 - 1) * 12;
    } else {
      const x1 = source.x + source.width / 2;
      const y1 = source.y + source.height;
      const x2 = target.x + target.width / 2;
      const y2 = target.y;
      const bend = Math.max(30, Math.abs(y2 - y1) / 2);
      path = `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
      labelX = (x1 + x2) / 2 + (index % 3 - 1) * 12;
      labelY = (y1 + y2) / 2;
    }
    edges.push({ edge, path, labelX, labelY });
  });

  const width = direction === 'LR'
    ? margin * 2 + LINEAGE_STAGES.length * SVG_NODE_WIDTH + (LINEAGE_STAGES.length - 1) * stageGap
    : Math.max(900, margin * 2 + maxRows * SVG_NODE_WIDTH + (maxRows - 1) * rowGap);
  const height = direction === 'LR'
    ? Math.max(360, header + maxRows * SVG_NODE_HEIGHT + (maxRows - 1) * rowGap + 64)
    : header + LINEAGE_STAGES.length * SVG_NODE_HEIGHT + (LINEAGE_STAGES.length - 1) * stageGap + 64;

  return { width, height, columns, nodes, edges };
}

function stageColor(kind: LineageNodeKind, palette: LineagePalette): string {
  if (kind === 'dlo') return palette.success;
  if (kind === 'transform') return palette.warning;
  if (kind === 'dmo') return palette.brand;
  if (kind === 'external') return palette.danger;
  return palette.brand;
}

function confidenceColor(confidence: LineageConfidence, palette: LineagePalette): string {
  if (confidence === 'missing') return palette.danger;
  if (confidence === 'derived') return palette.warning;
  return palette.brand;
}

/** Static, themed SVG of the derived flow graph. */
export function exportLineageSvg(
  graph: LineageGraph,
  palette: LineagePalette,
  direction: LineageLayoutDirection = 'LR',
): string {
  const layout = buildLineageSvgLayout(graph, direction);
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" role="img">`,
    `<title>${escapeXml(graph.org.alias)} — Data 360 lineage</title>`,
    `<desc>${layout.nodes.length} steps and ${layout.edges.length} links derived from snapshot ${escapeXml(graph.org.generatedAt)}.</desc>`,
    '<style>text { font-family: Inter, ui-sans-serif, system-ui, sans-serif; }</style>',
    `<rect width="100%" height="100%" fill="${escapeXml(palette.surface)}"/>`,
    '<defs>',
  ];
  for (const confidence of ALL_LINEAGE_CONFIDENCES) {
    lines.push(
      `<marker id="dcat-lineage-${confidence}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${escapeXml(confidenceColor(confidence, palette))}"/></marker>`,
    );
  }
  lines.push('</defs>');

  for (const column of layout.columns) {
    lines.push(
      `<text x="${direction === 'LR' ? column.offset : 48}" y="${direction === 'LR' ? 48 : column.offset - 10}" font-size="12" font-weight="700" fill="${escapeXml(palette.inkSoft)}">${escapeXml(column.label)}</text>`,
    );
  }

  for (const placed of layout.edges) {
    const color = confidenceColor(placed.edge.confidence, palette);
    const dash = placed.edge.confidence === 'source'
      ? ''
      : placed.edge.confidence === 'derived' ? ' stroke-dasharray="7 5"' : ' stroke-dasharray="2 4"';
    lines.push(
      `<path d="${placed.path}" fill="none" stroke="${escapeXml(color)}" stroke-width="1.8"${dash} marker-end="url(#dcat-lineage-${placed.edge.confidence})"/>`,
      `<text x="${placed.labelX}" y="${placed.labelY}" text-anchor="middle" font-size="10" fill="${escapeXml(palette.inkSoft)}" stroke="${escapeXml(palette.surface)}" stroke-width="3" paint-order="stroke">${escapeXml(truncate(placed.edge.label, 24))}</text>`,
    );
  }

  for (const placed of layout.nodes) {
    const color = stageColor(placed.node.kind, palette);
    lines.push(
      '<g>',
      `<rect x="${placed.x}" y="${placed.y}" width="${placed.width}" height="${placed.height}" rx="10" fill="${escapeXml(palette.surface)}" stroke="${escapeXml(placed.node.unresolved ? palette.danger : palette.line)}"/>`,
      `<rect x="${placed.x}" y="${placed.y}" width="4" height="${placed.height}" rx="2" fill="${escapeXml(color)}"/>`,
      `<text x="${placed.x + 14}" y="${placed.y + 26}" font-size="12" font-weight="600" fill="${escapeXml(palette.ink)}">${escapeXml(truncate(placed.node.label, 28))}</text>`,
      `<text x="${placed.x + 14}" y="${placed.y + 46}" font-size="10" fill="${escapeXml(palette.inkFaint)}">${escapeXml(truncate(placed.node.subtitle, 32))}</text>`,
      '</g>',
    );
  }

  const legendY = layout.height - 22;
  const legend: { confidence: LineageConfidence; label: string }[] = [
    { confidence: 'source', label: 'Named in metadata' },
    { confidence: 'derived', label: 'DCAT-derived' },
    { confidence: 'missing', label: 'Missing reference' },
  ];
  legend.forEach((item, index) => {
    const x = 48 + index * 220;
    const dash = item.confidence === 'source'
      ? ''
      : item.confidence === 'derived' ? ' stroke-dasharray="6 5"' : ' stroke-dasharray="2 4"';
    lines.push(
      `<line x1="${x}" y1="${legendY - 4}" x2="${x + 28}" y2="${legendY - 4}" stroke="${escapeXml(confidenceColor(item.confidence, palette))}" stroke-width="2"${dash}/>`,
      `<text x="${x + 36}" y="${legendY}" font-size="11" fill="${escapeXml(palette.inkSoft)}">${escapeXml(item.label)}</text>`,
    );
  });
  lines.push('</svg>');
  return `${lines.join('\n')}\n`;
}

function mermaidQuoted(value: string): string {
  return value.replace(/["\r\n|]/g, ' ').replace(/\s+/g, ' ').trim();
}

function mermaidLink(confidence: LineageConfidence, label: string): string {
  const arrow = confidence === 'source' ? '-->' : '-.->';
  return `${arrow}|"${mermaidQuoted(label)}"|`;
}

/** Portable Mermaid flowchart. No Mermaid runtime is bundled in DCAT. */
export function exportLineageMermaid(
  graph: LineageGraph,
  direction: LineageLayoutDirection = 'LR',
): string {
  const ids = new Map<string, string>();
  const ordered = LINEAGE_STAGES.flatMap((stage) => graph.nodes
    .filter((node) => node.kind === stage.kind)
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id)));
  ordered.forEach((node, index) => ids.set(node.id, `n${index + 1}`));

  const lines = [
    `flowchart ${direction}`,
    `  accTitle: ${mermaidQuoted(`Data lineage for ${graph.org.alias}`)}`,
    `  accDescr: ${ordered.length} steps and ${graph.edges.length} links. Solid links are named in metadata, dashed links are DCAT-derived, and dotted links name objects missing from the snapshot. ${graph.gaps.filter((gap) => gap.severity === 'warning').length} integrity gaps.`,
    '',
  ];
  for (const stage of LINEAGE_STAGES) {
    const stageNodes = ordered.filter((node) => node.kind === stage.kind);
    if (stageNodes.length === 0) continue;
    lines.push(`  subgraph ${stage.kind}["${mermaidQuoted(stage.label)}"]`);
    for (const node of stageNodes) {
      lines.push(`    ${ids.get(node.id)}["${mermaidQuoted(node.unresolved ? `Missing ${node.expectedKind?.toUpperCase() ?? 'object'}: ${node.label}` : node.label)}"]`);
    }
    lines.push('  end', '');
  }
  for (const edge of graph.edges) {
    const source = ids.get(edge.source);
    const target = ids.get(edge.target);
    if (!source || !target) continue;
    const label = edge.confidence === 'missing'
      ? `missing: ${edge.label}`
      : edge.confidence === 'derived' ? `derived: ${edge.label}` : edge.label;
    lines.push(`  ${source} ${mermaidLink(edge.confidence, label)} ${target}`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Machine-readable graph without the raw metadata payloads. */
export function exportLineageJson(graph: LineageGraph): string {
  const payload = {
    org: graph.org,
    stages: LINEAGE_STAGES,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      apiName: node.apiName,
      label: node.label,
      subtitle: node.subtitle,
      dataSpace: node.dataSpace,
      status: node.status,
      unresolved: node.unresolved,
      expectedKind: node.expectedKind,
      degree: node.degree,
      provenance: node.provenance,
    })),
    edges: graph.edges,
    gaps: graph.gaps,
    dataSpaces: graph.dataSpaces,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

const LINEAGE_CONFIDENCE_LABELS: Record<LineageConfidence, string> = {
  source: 'Named in metadata',
  derived: 'DCAT-derived',
  missing: 'Missing reference',
};

/** Review-friendly architecture notes that keep the same certainty semantics. */
export function exportLineageMarkdown(graph: LineageGraph): string {
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const lines = [
    `# Data lineage — ${markdownCell(graph.org.alias)}`,
    '',
    `Derived from the ${graph.org.mode} snapshot retrieved ${markdownCell(graph.org.generatedAt)}.`,
    graph.org.apiVersion ? `API version: ${markdownCell(graph.org.apiVersion)}.` : '',
    '',
    '> Links below come only from references in the current metadata snapshot. DCAT does not infer lineage from similar names. Dashed/derived links are marked explicitly, and unresolved references remain visible as gaps.',
    '',
    '## Summary',
    '',
    `- ${graph.nodes.length} steps across ${LINEAGE_STAGES.length} stages`,
    `- ${graph.edges.length} grounded or explicitly marked links`,
    `- ${graph.gaps.filter((gap) => gap.severity === 'warning').length} integrity gaps`,
    `- ${graph.dataSpaces.length} Data Space${graph.dataSpaces.length === 1 ? '' : 's'}`,
    '',
    '## Steps by stage',
    '',
    '| Stage | Steps |',
    '| --- | ---: |',
  ];
  for (const stage of LINEAGE_STAGES) {
    lines.push(`| ${markdownCell(stage.label)} | ${graph.nodes.filter((node) => node.kind === stage.kind).length} |`);
  }

  lines.push('', '## Links', '', '| From | To | Link | Grounding | Field mappings |', '| --- | --- | --- | --- | ---: |');
  for (const edge of graph.edges) {
    const grounding = edge.relationshipCertainty && edge.relationshipCertainty !== 'confirmed'
      ? `${LINEAGE_CONFIDENCE_LABELS[edge.confidence]} (${edge.relationshipCertainty}; not a source fact)`
      : LINEAGE_CONFIDENCE_LABELS[edge.confidence];
    lines.push(
      `| ${markdownCell(labels.get(edge.source) ?? edge.source)} | ${markdownCell(labels.get(edge.target) ?? edge.target)} | ${markdownCell(edge.label)} | ${markdownCell(grounding)} | ${edge.fieldLinks.length} |`,
    );
  }

  lines.push('', '## Integrity gaps', '');
  if (graph.gaps.length === 0) {
    lines.push('No unresolved references or unconnected objects in this view.');
  } else {
    lines.push('| Severity | Finding | Detail |', '| --- | --- | --- |');
    for (const gap of graph.gaps) {
      lines.push(`| ${markdownCell(gap.severity)} | ${markdownCell(gap.label)} | ${markdownCell(gap.detail)} |`);
    }
  }

  return `${lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n')}\n`;
}
