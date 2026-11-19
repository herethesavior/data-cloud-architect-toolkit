import type { Query } from '@tanstack/react-query';
import { del, get, set } from 'idb-keyval';
import type { WorkspaceMode } from './workspace.ts';
import { isWorkspaceContextId } from './workspace.ts';

/** Persisted snapshots expire after a week; the UI's stale threshold is much shorter. */
export const PERSISTED_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
export const PERSISTED_CACHE_KEY = 'dcat.inventory-cache.v1';

/** Options for the two data sets that are allowed to survive a reload. */
export const persistedQueryOptions = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: PERSISTED_CACHE_MAX_AGE,
  refetchOnMount: false,
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
} as const;

type StringStorage = {
  getItem: (key: string) => Promise<string | null | undefined>;
  setItem: (key: string, value: string) => Promise<unknown>;
  removeItem: (key: string) => Promise<void>;
};

/** IndexedDB holds larger inventory snapshots without localStorage's tight quota. */
export function createPersistedCacheStorage(): StringStorage {
  return {
    getItem: (key) => get<string>(key),
    setItem: (key, value) => set(key, value),
    removeItem: (key) => del(key),
  };
}

function isOrgQueryKey(key: readonly unknown[]): key is readonly ['orgs', WorkspaceMode] {
  return key.length === 2 && key[0] === 'orgs' && (key[1] === 'demo' || key[1] === 'live');
}

function isInventoryQueryKey(key: readonly unknown[]): key is readonly ['inventory', string] {
  return key.length === 2 && key[0] === 'inventory' && isWorkspaceContextId(key[1]);
}

/**
 * Persistence is an explicit allowlist. Session tokens, pairing codes, health
 * checks, transform details, and disabled-query placeholders never reach disk.
 */
export function shouldPersistQuery(query: Query): boolean {
  if (query.state.status !== 'success') return false;
  return isOrgQueryKey(query.queryKey) || isInventoryQueryKey(query.queryKey);
}
