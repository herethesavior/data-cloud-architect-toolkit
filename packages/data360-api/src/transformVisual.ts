import type { TransformVisualDefinition, TransformVisualEdge, TransformVisualNode } from '@dcat/core';

const MAX_VISUAL_NODES = 120;
const MAX_VISUAL_EDGES = 240;
const MAX_SUMMARY_ITEMS = 6;
const MAX_SUMMARY_LENGTH = 120;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function named(value: unknown): string | null {
  if (typeof value === 'string') return text(value);
  if (!isRecord(value)) return null;
  return text(value.name ?? value.label ?? value.apiName ?? value.developerName);
}

function countAt(value: unknown, keys: readonly string[]): number | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate.length;
  }
  return null;
}

function definitionCandidates(record: JsonRecord): unknown[] {
  const definitions = record.definitions;
  if (Array.isArray(definitions)) return definitions;
  const values = [
    record.definition,
    record.transformDefinition,
    record.pipelineDefinition,
    record.pipeline,
  ].map(parsed).filter((value) => value !== null);
  return values;
}

function findDefinition(record: JsonRecord): JsonRecord | null {
  for (const candidate of definitionCandidates(record)) {
    const definition = Array.isArray(candidate) ? candidate[0] : candidate;
    if (!isRecord(definition)) continue;
    const ui = isRecord(definition.ui) ? definition.ui : null;
    if (ui || definition.nodes !== undefined) return definition;
  }
  return null;
}

function nodeEntries(value: unknown): Array<{ id: string; record: JsonRecord }> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => {
      if (!isRecord(entry)) return [];
      const id = text(entry.id ?? entry.name ?? entry.key) ?? `node_${index + 1}`;
      return [{ id, record: entry }];
    });
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    if (!isRecord(entry)) return [];
    const id = key || text(entry.id ?? entry.name) || `node_${key}`;
    return [{ id, record: entry }];
  });
}

function summarize(uiNode: JsonRecord, graphNode: JsonRecord | null, sourceCount: number): string[] {
  const uiParameters = isRecord(uiNode.parameters) ? uiNode.parameters : null;
  const graphParameters = graphNode && isRecord(graphNode.parameters) ? graphNode.parameters : null;
  const parameters = uiParameters && graphParameters
    ? { ...uiParameters, ...graphParameters }
    : uiParameters ?? graphParameters;
  if (!parameters) return sourceCount > 0 ? [`${sourceCount} upstream source${sourceCount === 1 ? '' : 's'}`] : [];

  const values: string[] = [];
  const input = named(parameters.dataset ?? parameters.source ?? parameters.input);
  if (input) values.push(`Input: ${input}`);
  const output = named(parameters.target ?? parameters.output ?? parameters);
  if (output && output !== input) values.push(`Output: ${output}`);
  const writeMode = text(parameters.writeMode);
  if (writeMode) values.push(`Write mode: ${writeMode}`);
  const sampleSize = numeric(parameters.sampleSize);
  if (sampleSize !== null) values.push(`Sample: ${sampleSize}`);
  const fields = countAt(parameters, ['fields', 'columns']);
  if (fields !== null) values.push(`${fields} field${fields === 1 ? '' : 's'}`);
  const mappings = countAt(parameters, ['fieldsMappings', 'fieldMappings']);
  if (mappings !== null) values.push(`${mappings} mapped field${mappings === 1 ? '' : 's'}`);
  const dedup = countAt(parameters, ['dedupOrder', 'keyFields']);
  if (dedup !== null && dedup > 0) values.push(`${dedup} dedup key${dedup === 1 ? '' : 's'}`);
  if (sourceCount > 0) values.push(`${sourceCount} upstream source${sourceCount === 1 ? '' : 's'}`);

  return values.slice(0, MAX_SUMMARY_ITEMS).map((value) =>
    value.length > MAX_SUMMARY_LENGTH ? `${value.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : value);
}

function sourcesOf(value: unknown): string[] {
  if (typeof value === 'string') return text(value) ? [text(value)!] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const id = text(entry);
    return id ? [id] : [];
  });
}

/**
 * Extract Salesforce's own read-only canvas metadata. Only labels, coordinates,
 * connector endpoints, and small parameter summaries are kept; large field lists
 * stay in the raw definition tab and never enter the graph model.
 */
export function parseTransformVisualDefinition(raw: unknown): TransformVisualDefinition | null {
  if (!isRecord(raw)) return null;
  const definition = findDefinition(raw);
  if (!definition) return null;

  const ui = isRecord(definition.ui) ? definition.ui : null;
  const uiNodes = nodeEntries(ui?.nodes ?? definition.nodes);
  const graphNodes = nodeEntries(definition.nodes);
  if (uiNodes.length === 0 && graphNodes.length === 0) return null;

  const byId = new Map(graphNodes.map((entry) => [entry.id, entry.record]));
  const ordered = uiNodes.length > 0 ? uiNodes : graphNodes;
  let positioned = 0;

  const nodes: TransformVisualNode[] = ordered.slice(0, MAX_VISUAL_NODES).map((entry, index) => {
    const graphNode = byId.get(entry.id) ?? null;
    const sourceTop = numeric(entry.record.top ?? entry.record.y ?? graphNode?.top ?? graphNode?.y);
    const sourceLeft = numeric(entry.record.left ?? entry.record.x ?? graphNode?.left ?? graphNode?.x);
    if (sourceTop !== null && sourceLeft !== null) positioned += 1;
    const top = sourceTop ?? 64 + Math.floor(index / 4) * 132;
    const left = sourceLeft ?? 64 + (index % 4) * 220;
    const sources = [
      ...sourcesOf(entry.record.sources),
      ...sourcesOf(graphNode?.sources),
    ];
    const sourceCount = new Set(sources).size;
    return {
      id: entry.id,
      label: text(entry.record.label ?? entry.record.title ?? graphNode?.label)
        ?? text(entry.record.name ?? graphNode?.name)
        ?? entry.id,
      type: text(entry.record.type ?? graphNode?.type),
      action: text(graphNode?.action ?? entry.record.action),
      description: text(entry.record.description ?? graphNode?.description),
      top,
      left,
      fieldCount: countAt(graphNode?.parameters ?? entry.record.parameters, ['fields', 'columns']),
      sourceCount,
      summary: summarize(entry.record, graphNode, sourceCount),
    };
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: TransformVisualEdge[] = [];
  const edgeKeys = new Set<string>();
  let edgeCapped = false;
  const connectors = ui && Array.isArray(ui.connectors) ? ui.connectors : [];
  const candidates: Array<{ source: string | null; target: string | null; label: string | null }> = connectors
    .filter(isRecord)
    .map((connector) => ({
      source: text(connector.source ?? connector.from ?? connector.sourceNode),
      target: text(connector.target ?? connector.to ?? connector.targetNode),
      label: text(connector.label),
    }));
  for (const node of nodes) {
    const graphNode = byId.get(node.id);
    for (const source of sourcesOf(graphNode?.sources)) {
      candidates.push({ source, target: node.id, label: null });
    }
  }
  for (const candidate of candidates) {
    if (!candidate.source || !candidate.target || !nodeIds.has(candidate.source) || !nodeIds.has(candidate.target)) continue;
    if (candidate.source === candidate.target) continue;
    const id = `${candidate.source}->${candidate.target}`;
    if (edgeKeys.has(id)) continue;
    edgeKeys.add(id);
    if (edges.length >= MAX_VISUAL_EDGES) {
      edgeCapped = true;
      break;
    }
    edges.push({ id, source: candidate.source, target: candidate.target, label: candidate.label });
  }

  if (nodes.length === 0) return null;
  return {
    name: text(definition.name),
    label: text(definition.label),
    version: text(definition.version),
    layout: positioned === nodes.length ? 'source' : 'generated',
    nodes,
    edges,
    truncated: ordered.length > nodes.length || edgeCapped,
  };
}
