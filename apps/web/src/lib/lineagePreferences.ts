import {
  ALL_LINEAGE_CONFIDENCES,
  ALL_LINEAGE_NODE_KINDS,
} from '@dcat/exporters';
import type { LineageConfidence, LineageLayoutDirection, LineageNodeKind, LineageTraceMode } from '@dcat/exporters';
import type { LineagePosition } from './lineageGraph.ts';

export interface LineageViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface LineageViewState {
  kinds: LineageNodeKind[];
  confidences: LineageConfidence[];
  dataSpace: string | null;
  direction: LineageLayoutDirection;
  traceMode: LineageTraceMode;
  grid: boolean;
  minimap: boolean;
  positions: Record<string, LineagePosition>;
  viewport: LineageViewport | null;
}

const STORAGE_PREFIX = 'dcat.lineage.v1.';

const NODE_KINDS = new Set<string>(ALL_LINEAGE_NODE_KINDS);
const CONFIDENCES = new Set<string>(ALL_LINEAGE_CONFIDENCES);

export function defaultLineageViewState(): LineageViewState {
  return {
    kinds: [...ALL_LINEAGE_NODE_KINDS],
    confidences: [...ALL_LINEAGE_CONFIDENCES],
    dataSpace: null,
    direction: 'LR',
    traceMode: 'off',
    grid: true,
    minimap: true,
    positions: {},
    viewport: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readKinds(value: unknown): LineageNodeKind[] {
  if (!Array.isArray(value)) return [...ALL_LINEAGE_NODE_KINDS];
  const kinds = value.filter((entry): entry is LineageNodeKind => typeof entry === 'string' && NODE_KINDS.has(entry));
  const unique = [...new Set(kinds)];
  return unique.length > 0 ? unique : [...ALL_LINEAGE_NODE_KINDS];
}

function readConfidences(value: unknown): LineageConfidence[] {
  if (!Array.isArray(value)) return [...ALL_LINEAGE_CONFIDENCES];
  const confidences = value.filter((entry): entry is LineageConfidence =>
    typeof entry === 'string' && CONFIDENCES.has(entry));
  const unique = [...new Set(confidences)];
  return unique.length > 0 ? unique : [...ALL_LINEAGE_CONFIDENCES];
}

function readPositions(value: unknown): Record<string, LineagePosition> {
  if (!isRecord(value)) return {};
  const positions: Record<string, LineagePosition> = {};
  for (const [id, candidate] of Object.entries(value)) {
    if (!isRecord(candidate)) continue;
    const { x, y } = candidate;
    if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
      positions[id] = { x, y };
    }
  }
  return positions;
}

function readViewport(value: unknown): LineageViewport | null {
  if (!isRecord(value)) return null;
  const zoom = finite(value.zoom, 0);
  if (zoom <= 0) return null;
  return { x: finite(value.x, 0), y: finite(value.y, 0), zoom };
}

/** Per-context canvas preferences; all storage failures are non-fatal. */
export function loadLineageViewState(contextId: string): LineageViewState {
  const fallback = defaultLineageViewState();
  if (!contextId || typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${contextId}`);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return fallback;
    const direction = parsed.direction;
    const traceMode = parsed.traceMode;
    return {
      kinds: readKinds(parsed.kinds),
      confidences: readConfidences(parsed.confidences),
      dataSpace: typeof parsed.dataSpace === 'string' && parsed.dataSpace.trim() ? parsed.dataSpace : null,
      direction: direction === 'LR' || direction === 'TB' ? direction : fallback.direction,
      traceMode: traceMode === 'both' || traceMode === 'upstream' || traceMode === 'downstream'
        ? traceMode
        : 'off',
      grid: typeof parsed.grid === 'boolean' ? parsed.grid : fallback.grid,
      minimap: typeof parsed.minimap === 'boolean' ? parsed.minimap : fallback.minimap,
      positions: readPositions(parsed.positions),
      viewport: readViewport(parsed.viewport),
    };
  } catch {
    return fallback;
  }
}

export function saveLineageViewState(contextId: string, state: LineageViewState): void {
  if (!contextId || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${contextId}`, JSON.stringify(state));
  } catch {
    // Locked-down storage must not break the canvas.
  }
}

export function clearLineageViewState(contextId: string): void {
  if (!contextId || typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${contextId}`);
  } catch {
    // Nothing else to do.
  }
}
