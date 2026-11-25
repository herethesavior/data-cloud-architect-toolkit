// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { OrgSummary } from '@dcat/core';
import { api } from './api.ts';
import { refreshModeOrgList } from './orgListRefresh.ts';
import { orgsQueryKey } from './workspace.ts';

vi.mock('./api.ts', () => ({
  api: { orgs: vi.fn() },
}));

const org: OrgSummary = {
  alias: 'prod-org',
  instanceUrl: 'https://example.my.salesforce.com',
  environment: 'production',
  isDefault: true,
  isDevHub: false,
  source: 'salesforce-cli',
};

describe('refreshModeOrgList', () => {
  beforeEach(() => {
    vi.mocked(api.orgs).mockReset();
  });

  it('seeds an empty list and fetches an unobserved mode without a missing queryFn', async () => {
    let finish!: (orgs: OrgSummary[]) => void;
    vi.mocked(api.orgs).mockReturnValueOnce(new Promise<OrgSummary[]>((resolve) => { finish = resolve; }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const fetching = refreshModeOrgList(queryClient, 'demo', false);
    expect(queryClient.getQueryData(orgsQueryKey('demo'))).toEqual([]);

    finish([org]);
    await expect(fetching).resolves.toEqual([org]);
    expect(queryClient.getQueryData(orgsQueryKey('demo'))).toEqual([org]);
    expect(api.orgs).toHaveBeenCalledTimes(1);
  });

  it('forwards cancellation so a later mode switch can abandon an old fetch', async () => {
    vi.mocked(api.orgs).mockReturnValueOnce(new Promise<OrgSummary[]>(() => undefined));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const controller = new AbortController();

    void refreshModeOrgList(queryClient, 'live', true, controller.signal).catch(() => undefined);
    expect(api.orgs).toHaveBeenCalledWith({ signal: controller.signal });
  });
});
