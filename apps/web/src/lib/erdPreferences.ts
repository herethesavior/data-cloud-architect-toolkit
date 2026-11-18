import type { ErdCertaintyFilter, ErdLayoutDirection } from '@dcat/exporters';
import type { ErdPosition, ErdSortMode } from './erdGraph.ts';

export interface ErdViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ErdViewState {
  filter: ErdCertaintyFilter;
  direction: ErdLayoutDirection;
  sortMode: ErdSortMode;
  grid: boolean;
  minimap: boolean;
  positions: Record<string, ErdPosition>;
  viewport: ErdViewport | null;
}

const STORAGE_PREFIX = 'dcat.erd.v1.';

export function defaultErdViewState(): ErdViewState {
  return {
    filter: 'all',
    direction: 'LR',
    sortMode: 'connected',
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

function readPositions(value: unknown): Record<string, ErdPosition> {
  if (!isRecord(value)) return {};
  const positions: Record<string, ErdPosition> = {};
  for (const [id, candidate] of Object.entries(value)) {
    if (!isRecord(candidate)) continue;
    const x = candidate.x;
    const y = candidate.y;
    if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
      positions[id] = { x, y };
    }
  }
  return positions;
}

function readViewport(value: unknown): ErdViewport | null {
  if (!isRecord(value)) return null;
  const zoom = finite(value.zoom, 0);
  if (zoom <= 0) return null;
  return { x: finite(value.x, 0), y: finite(value.y, 0), zoom };
}

/** Per-context layout and viewport preferences; all storage failures are non-fatal. */
export function loadErdViewState(contextId: string): ErdViewState {
  const fallback = defaultErdViewState();
  if (!contextId || typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${contextId}`);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return fallback;
    const filter = parsed.filter;
    const direction = parsed.direction;
    const sortMode = parsed.sortMode;
    return {
      filter: filter === 'all' || filter === 'confirmed' || filter === 'inferred' ? filter : fallback.filter,
      direction: direction === 'LR' || direction === 'TB' ? direction : fallback.direction,
      sortMode: sortMode === 'connected' || sortMode === 'alphabetical' ? sortMode : fallback.sortMode,
      grid: typeof parsed.grid === 'boolean' ? parsed.grid : fallback.grid,
      minimap: typeof parsed.minimap === 'boolean' ? parsed.minimap : fallback.minimap,
      positions: readPositions(parsed.positions),
      viewport: readViewport(parsed.viewport),
    };
  } catch {
    return fallback;
  }
}

export function saveErdViewState(contextId: string, state: ErdViewState): void {
  if (!contextId || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${contextId}`, JSON.stringify(state));
  } catch {
    // Locked-down storage must not break the canvas.
  }
}

export function clearErdViewState(contextId: string): void {
  if (!contextId || typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${contextId}`);
  } catch {
    // Nothing else to do.
  }
}
