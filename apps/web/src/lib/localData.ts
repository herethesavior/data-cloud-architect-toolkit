import type { QueryClient } from '@tanstack/react-query';
import { clearPersistedCache } from './queryPersistence.ts';
import { isContextScopedQuery } from './workspace.ts';

const DCAT_KEY_PREFIX = 'dcat.';
const LAYOUT_PREFIXES = ['dcat.erd.v1.', 'dcat.lineage.v1.', 'dcat.impact.v1.'] as const;

function localStorageKeys(): string[] {
  try {
    const storage = window.localStorage;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function removeKeys(keys: string[]): void {
  try {
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Locked-down storage cannot be cleared from JavaScript.
  }
}

/** Only DCAT-owned keys are removed; unrelated browser data is left alone. */
export function clearDcatLocalPreferences(): void {
  removeKeys(localStorageKeys().filter((key) => key.startsWith(DCAT_KEY_PREFIX)));
}

/** ERD and Lineage layouts are stored per context, so every key uses a prefix. */
export function clearDcatSavedLayouts(): void {
  removeKeys(localStorageKeys().filter((key) =>
    LAYOUT_PREFIXES.some((prefix) => key.startsWith(prefix))));
}

/** Re-fetchable metadata only: org lists and context-scoped snapshots. */
function isCachedDataQuery(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === 'orgs' || isContextScopedQuery(queryKey);
}

/** Session and diagnostics stay warm so clearing data does not flash a boot screen. */
export async function clearDcatCachedMetadata(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries({ predicate: (query) => isCachedDataQuery(query.queryKey) });
  queryClient.removeQueries({ predicate: (query) => isCachedDataQuery(query.queryKey) });
  await clearPersistedCache();
}
