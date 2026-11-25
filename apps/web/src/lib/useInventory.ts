import { useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { InventorySnapshot } from '@dcat/core';
import { api } from './api.ts';
import { mergeInventorySnapshot } from './inventoryMerge.ts';
import { persistedQueryOptions } from './queryPersistence.ts';
import type { WorkspaceContext } from './workspace.ts';

/**
 * Every cached snapshot is namespaced by the owning workspace context.
 * Partial snapshots are written to that same key as soon as each batch lands,
 * so every explorer sees progressive rows without a second cache contract.
 */
export function useInventory(context: WorkspaceContext | null) {
  const queryClient = useQueryClient();
  // The query function closes over the context it started with. A context
  // change updates this ref, so a late partial snapshot can never hydrate the
  // wrong workspace even though the old query is still draining.
  const contextRef = useRef(context);
  contextRef.current = context;

  return useQuery({
    queryKey: ['inventory', context?.contextId ?? 'none'],
    queryFn: ({ signal, queryKey }) => {
      if (!context?.alias) throw new Error('Select an org to load its inventory.');
      return api.inventory(context.alias, {
        signal,
        onSnapshot: (snapshot) => {
          if (contextRef.current?.contextId !== context.contextId) return;
          const merged = mergeInventorySnapshot(queryClient.getQueryData<InventorySnapshot>(queryKey), snapshot);
          queryClient.setQueryData(queryKey, merged);
        },
      }).then((snapshot) => mergeInventorySnapshot(
        queryClient.getQueryData<InventorySnapshot>(queryKey),
        snapshot,
      ));
    },
    enabled: Boolean(context?.alias),
    // The connector already retries individual pages. A second whole-session
    // retry here duplicates CLI discovery and can collide with the manual
    // refresh that owns the same relay slot.
    retry: false,
    ...persistedQueryOptions,
    // A complete snapshot is enough on reload. An incomplete one revalidates in
    // the background while its rows stay visible instead of freezing a gap.
    refetchOnMount: (query) => {
      const snapshot = query.state.data as InventorySnapshot | undefined;
      return !snapshot?.progress || snapshot.progress.state !== 'complete' ? 'always' : false;
    },
  });
}
