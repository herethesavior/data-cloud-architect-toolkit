import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { App } from './App.tsx';
import {
  createPersistedCacheStorage,
  PERSISTED_CACHE_KEY,
  PERSISTED_CACHE_MAX_AGE,
  shouldPersistQuery,
} from './lib/queryPersistence.ts';
import '@xyflow/react/dist/style.css';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Hydrated queries are built before their observers apply query-specific
      // options, so the client default must outlive the persister's maxAge.
      gcTime: PERSISTED_CACHE_MAX_AGE,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const persister = createAsyncStoragePersister({
  key: PERSISTED_CACHE_KEY,
  storage: createPersistedCacheStorage(),
  // Keep the window where a fresh reload could miss the latest snapshot small.
  throttleTime: 100,
});

const root = document.getElementById('root');
if (!root) throw new Error('Application root element is missing.');

createRoot(root).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: PERSISTED_CACHE_MAX_AGE,
        buster: `${import.meta.env.MODE}-v1`,
        dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
      }}
    >
      <App />
    </PersistQueryClientProvider>
  </StrictMode>,
);
