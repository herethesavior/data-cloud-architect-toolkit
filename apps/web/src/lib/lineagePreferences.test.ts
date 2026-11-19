// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLineageViewState,
  defaultLineageViewState,
  loadLineageViewState,
  saveLineageViewState,
} from './lineagePreferences.ts';

const store = new Map<string, string>();
const storage: Storage = {
  get length() { return store.size; },
  clear: () => store.clear(),
  getItem: (key) => store.get(key) ?? null,
  key: (index) => [...store.keys()][index] ?? null,
  removeItem: (key) => { store.delete(key); },
  setItem: (key, value) => { store.set(key, value); },
};

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  store.clear();
});

describe('lineage preferences', () => {
  it('returns isolated defaults for every context', () => {
    expect(loadLineageViewState('')).toEqual(defaultLineageViewState());
    expect(loadLineageViewState('demo-uat')).toEqual(defaultLineageViewState());
    expect(storage.length).toBe(0);
  });

  it('round-trips filters, trace mode, positions, and viewport under a versioned prefix', () => {
    const state = defaultLineageViewState();
    state.kinds = ['stream', 'dlo', 'transform', 'dmo'];
    state.confidences = ['source'];
    state.dataSpace = 'sales_space';
    state.direction = 'TB';
    state.traceMode = 'upstream';
    state.grid = false;
    state.minimap = false;
    state.positions = { 'dlo:Account_DLO__dll': { x: 10, y: 20 } };
    state.viewport = { x: -5, y: 15, zoom: 0.75 };

    saveLineageViewState('live-org', state);

    expect(storage.getItem('dcat.lineage.v1.live-org')).toBeTruthy();
    expect(storage.getItem('dcat.erd.v1.live-org')).toBeNull();
    expect(loadLineageViewState('live-org')).toEqual(state);
    expect(loadLineageViewState('other-org')).toEqual(defaultLineageViewState());
  });

  it('sanitizes malformed stored values instead of breaking the canvas', () => {
    storage.setItem('dcat.lineage.v1.demo-uat', JSON.stringify({
      kinds: ['dlo', 'not-a-kind', 'dlo'],
      confidences: ['source', 'nope'],
      dataSpace: '   ',
      direction: 'diagonal',
      traceMode: 'sideways',
      grid: 'yes',
      minimap: 1,
      positions: {
        good: { x: 1, y: 2 },
        bad: { x: 'left', y: 2 },
      },
      viewport: { x: 0, y: 0, zoom: 0 },
    }));

    const loaded = loadLineageViewState('demo-uat');
    expect(loaded.kinds).toEqual(['dlo']);
    expect(loaded.confidences).toEqual(['source']);
    expect(loaded.dataSpace).toBeNull();
    expect(loaded.direction).toBe('LR');
    expect(loaded.traceMode).toBe('off');
    expect(loaded.grid).toBe(true);
    expect(loaded.minimap).toBe(true);
    expect(loaded.positions).toEqual({ good: { x: 1, y: 2 } });
    expect(loaded.viewport).toBeNull();
  });

  it('restores full defaults when stored filter arrays are empty', () => {
    storage.setItem('dcat.lineage.v1.demo-uat', JSON.stringify({ kinds: [], confidences: [] }));
    const loaded = loadLineageViewState('demo-uat');
    expect(loaded.kinds).toEqual(defaultLineageViewState().kinds);
    expect(loaded.confidences).toEqual(defaultLineageViewState().confidences);
  });

  it('tolerates corrupt JSON, storage failures, and clearing an unknown context', () => {
    storage.setItem('dcat.lineage.v1.demo-uat', '{not json');
    expect(loadLineageViewState('demo-uat')).toEqual(defaultLineageViewState());

    const getItem = vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadLineageViewState('demo-uat')).toEqual(defaultLineageViewState());
    getItem.mockRestore();

    const setItem = vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => saveLineageViewState('demo-uat', defaultLineageViewState())).not.toThrow();
    setItem.mockRestore();

    const removeItem = vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => clearLineageViewState('demo-uat')).not.toThrow();
    removeItem.mockRestore();

    clearLineageViewState('demo-uat');
    expect(storage.getItem('dcat.lineage.v1.demo-uat')).toBeNull();
  });
});
