// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { clearDcatCachedMetadata, clearDcatLocalPreferences, clearDcatSavedLayouts } from './localData.ts';
import { clearPersistedCache } from './queryPersistence.ts';
import { orgsQueryKey } from './workspace.ts';

const store = new Map<string, string>();
const storage: Storage = {
  get length() { return store.size; },
  clear: () => store.clear(),
  getItem: (key) => store.get(key) ?? null,
  key: (index) => [...store.keys()][index] ?? null,
  removeItem: (key) => { store.delete(key); },
  setItem: (key, value) => { store.set(key, value); },
};

vi.mock('./queryPersistence.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('./queryPersistence.ts')>(),
  clearPersistedCache: vi.fn().mockResolvedValue(undefined),
}));

describe('local data controls', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
    store.clear();
    vi.mocked(clearPersistedCache).mockClear();
  });

  it('removes only DCAT-owned preferences', () => {
    window.localStorage.setItem('dcat.mode', 'demo');
    window.localStorage.setItem('dcat.hiddenOrgs', '[]');
    window.localStorage.setItem('dcat.erd.v1.demo:demo-uat', '{}');
    window.localStorage.setItem('unrelated-app', 'keep');

    clearDcatLocalPreferences();

    expect(window.localStorage.getItem('dcat.mode')).toBeNull();
    expect(window.localStorage.getItem('dcat.hiddenOrgs')).toBeNull();
    expect(window.localStorage.getItem('dcat.erd.v1.demo:demo-uat')).toBeNull();
    expect(window.localStorage.getItem('unrelated-app')).toBe('keep');
  });

  it('removes saved layouts for every context without touching other preferences', () => {
    window.localStorage.setItem('dcat.erd.v1.demo:demo-uat', '{}');
    window.localStorage.setItem('dcat.lineage.v1.live:org:00D', '{}');
    window.localStorage.setItem('dcat.impact.v1.live:org:00D', '{}');
    window.localStorage.setItem('dcat.theme', 'dark');

    clearDcatSavedLayouts();

    expect(window.localStorage.getItem('dcat.erd.v1.demo:demo-uat')).toBeNull();
    expect(window.localStorage.getItem('dcat.lineage.v1.live:org:00D')).toBeNull();
    expect(window.localStorage.getItem('dcat.impact.v1.live:org:00D')).toBeNull();
    expect(window.localStorage.getItem('dcat.theme')).toBe('dark');
  });

  it('clears re-fetchable caches but keeps the session and diagnostics warm', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData<unknown[]>(orgsQueryKey('demo'), []);
    client.setQueryData(['inventory', 'demo:demo-uat'], { ok: true });
    client.setQueryData(['session'], { mode: 'demo' });
    client.setQueryData(['health'], { status: 'ok' });

    await clearDcatCachedMetadata(client);

    expect(client.getQueryData(orgsQueryKey('demo'))).toBeUndefined();
    expect(client.getQueryData(['inventory', 'demo:demo-uat'])).toBeUndefined();
    expect(client.getQueryData(['session'])).toEqual({ mode: 'demo' });
    expect(client.getQueryData(['health'])).toEqual({ status: 'ok' });
    expect(clearPersistedCache).toHaveBeenCalledOnce();
  });
});
