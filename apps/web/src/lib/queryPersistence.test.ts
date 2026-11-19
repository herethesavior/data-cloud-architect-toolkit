import { dehydrate, QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { orgsQueryKey } from './workspace.ts';
import { orgsQueryOptions, shouldPersistQuery } from './queryPersistence.ts';

describe('inventory cache persistence', () => {
  it('persists only successful org and inventory snapshots', () => {
    const client = new QueryClient();
    const contextId = 'live:prod-org:00DXX0000001PROD';
    client.setQueryData(orgsQueryKey('demo'), []);
    client.setQueryData(orgsQueryKey('live'), []);
    client.setQueryData(['inventory', contextId], { marker: 'inventory' });

    const persisted = client.getQueryCache().getAll().filter(shouldPersistQuery).map((query) => query.queryKey);

    expect(persisted).toEqual([
      orgsQueryKey('demo'),
      orgsQueryKey('live'),
      ['inventory', contextId],
    ]);
  });

  it('keeps tokens, pairing state, transforms, and placeholders out of the persisted client', () => {
    const client = new QueryClient();
    client.setQueryData(orgsQueryKey('live'), [{ alias: 'prod-org' }]);
    client.setQueryData(['inventory', 'demo:demo-uat'], { marker: 'snapshot' });
    client.setQueryData(['session'], { token: 'do-not-persist', mode: 'live' });
    client.setQueryData(['bridge-status'], { pairing: { code: 'do-not-persist' } });
    client.setQueryData(['health'], { status: 'ok' });
    client.setQueryData(['transforms', 'demo:demo-uat', 'bundle', 't1'], { marker: 'transform' });
    client.setQueryData(['inventory', 'none'], { marker: 'placeholder' });

    const serialized = JSON.stringify(dehydrate(client, { shouldDehydrateQuery: shouldPersistQuery }));

    expect(serialized).toContain('prod-org');
    expect(serialized).toContain('snapshot');
    expect(serialized).not.toContain('do-not-persist');
    expect(serialized).not.toContain('bridge-status');
    expect(serialized).not.toContain('health');
    expect(serialized).not.toContain('transforms');
    expect(serialized).not.toContain('placeholder');
  });
});

describe('org list query options', () => {
  it('disables auto-retry for the hosted org list so a late retry cannot block inventory', () => {
    expect(orgsQueryOptions(true)).toMatchObject({ retry: false, retryOnMount: false });
  });

  it('keeps retry available for the local org list', () => {
    expect(orgsQueryOptions(false)).not.toHaveProperty('retry');
  });
});
