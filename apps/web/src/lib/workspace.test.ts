import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { demoOrgs } from '@dcat/test-fixtures';
import type { OrgSummary } from '@dcat/core';
import {
  clearWorkspaceCaches,
  createWorkspaceContext,
  invalidateBridgeState,
  invalidateWorkspaceState,
  isContextScopedQuery,
  orgsQueryKey,
  shouldDiscardQuery,
  workspaceBadge,
} from './workspace.ts';

const demoOrg = demoOrgs[0]!;
const liveOrg: OrgSummary = {
  ...demoOrg,
  alias: 'prod-org',
  orgId: '00DXX0000001ABC',
  environment: 'production',
  source: 'salesforce-cli',
};

describe('workspace contexts', () => {
  it('requires an org before creating a context', () => {
    expect(createWorkspaceContext('demo', null)).toBeNull();
    expect(createWorkspaceContext('live', null)).toBeNull();
  });

  it('namespaces demo and live contexts so sample data cannot appear as live data', () => {
    const demo = createWorkspaceContext('demo', demoOrg);
    const live = createWorkspaceContext('live', demoOrg);

    expect(demo).toMatchObject({
      mode: 'demo',
      contextId: 'demo:demo-uat',
      alias: 'demo-uat',
      environment: 'demo',
    });
    expect(live).toMatchObject({
      mode: 'live',
      contextId: `live:demo-uat:${demoOrg.orgId}`,
      environment: 'sandbox',
    });
    expect(demo?.contextId).not.toBe(live?.contextId);
  });

  it('includes the org id so one live org never inherits another org’s cache', () => {
    const first = createWorkspaceContext('live', liveOrg);
    const rotated: OrgSummary = { ...liveOrg, orgId: '00DXX0000002DEF' };
    const second = createWorkspaceContext('live', rotated);
    const unverified = createWorkspaceContext('live', { ...liveOrg, orgId: null });

    expect(first?.contextId).toBe('live:prod-org:00DXX0000001ABC');
    expect(second?.contextId).toBe('live:prod-org:00DXX0000002DEF');
    expect(unverified?.contextId).toBe('live:prod-org:unverified');
    expect(new Set([first?.contextId, second?.contextId, unverified?.contextId]).size).toBe(3);
  });

  it('discards only context-scoped queries that belong to another context', () => {
    const activeId = 'live:prod-org:00DXX0000001ABC';

    expect(isContextScopedQuery(['inventory', activeId])).toBe(true);
    expect(isContextScopedQuery(['transforms', activeId])).toBe(true);
    expect(isContextScopedQuery(['erd', activeId])).toBe(true);
    expect(isContextScopedQuery(['orgs'])).toBe(false);
    expect(isContextScopedQuery(['session'])).toBe(false);

    expect(shouldDiscardQuery(['inventory', 'demo:demo-uat'], activeId)).toBe(true);
    expect(shouldDiscardQuery(['inventory', activeId], activeId)).toBe(false);
    expect(shouldDiscardQuery(['inventory', activeId], null)).toBe(true);
    expect(shouldDiscardQuery(['orgs'], null)).toBe(false);
    expect(shouldDiscardQuery(['session'], null)).toBe(false);
  });

  it('cancels in-flight work and removes stale context caches on a context switch', () => {
    const client = new QueryClient();
    const cancel = vi.spyOn(client, 'cancelQueries');
    const demoId = 'demo:demo-uat';
    const liveId = 'live:prod-org:00DXX0000001ABC';

    client.setQueryData(['inventory', demoId], { marker: 'demo' });
    client.setQueryData(['transforms', demoId], { marker: 'demo-transforms' });
    client.setQueryData(['inventory', liveId], { marker: 'live' });
    client.setQueryData(orgsQueryKey('demo'), [{ marker: 'org-list' }]);
    client.setQueryData(['session'], { marker: 'session' });

    clearWorkspaceCaches(client, liveId);

    expect(cancel).toHaveBeenCalledOnce();
    expect(client.getQueryData(['inventory', demoId])).toBeUndefined();
    expect(client.getQueryData(['transforms', demoId])).toBeUndefined();
    expect(client.getQueryData(['inventory', liveId])).toEqual({ marker: 'live' });
    expect(client.getQueryData(orgsQueryKey('demo'))).toEqual([{ marker: 'org-list' }]);
    expect(client.getQueryData(['session'])).toEqual({ marker: 'session' });

    // Leaving a context entirely (org removal or mode switch) drops all data.
    clearWorkspaceCaches(client, null);
    expect(client.getQueryData(['inventory', liveId])).toBeUndefined();
    expect(client.getQueryData(orgsQueryKey('demo'))).toEqual([{ marker: 'org-list' }]);
  });

  it('invalidates shared and context-scoped state in one place', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['bridge-status'], { paired: true });
    client.setQueryData(['health'], { status: 'ok' });
    client.setQueryData(orgsQueryKey('demo'), [demoOrg]);
    client.setQueryData(['inventory', 'demo:demo-uat'], { marker: 'inventory' });
    client.setQueryData(['transforms', 'demo:demo-uat', 'bundle', 't1'], { marker: 'transform' });
    client.setQueryData(['session'], { mode: 'demo' });

    invalidateWorkspaceState(client);

    for (const key of [
      ['bridge-status'],
      ['health'],
      orgsQueryKey('demo'),
      ['inventory', 'demo:demo-uat'],
      ['transforms', 'demo:demo-uat', 'bundle', 't1'],
    ]) {
      expect(client.getQueryState(key)?.isInvalidated, `query ${key.join('/')}`).toBe(true);
    }
    expect(client.getQueryState(['session'])?.isInvalidated).toBe(false);
  });

  it('syncs bridge state without adding an org.list before connect', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['bridge-status'], { paired: true });
    client.setQueryData(['health'], { status: 'ok' });
    client.setQueryData(orgsQueryKey('demo'), [demoOrg]);
    client.setQueryData(['inventory', 'demo:demo-uat'], { marker: 'inventory' });

    invalidateBridgeState(client);

    expect(client.getQueryState(['bridge-status'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['health'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['inventory', 'demo:demo-uat'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(orgsQueryKey('demo'))?.isInvalidated).toBe(false);
  });

  it('labels the active context explicitly in the header', () => {
    expect(workspaceBadge(null, 'live')).toEqual({ label: 'LIVE · NOT CONNECTED', tone: 'neutral' });
    expect(workspaceBadge(null, 'demo')).toEqual({ label: 'DEMO · NO ORG SELECTED', tone: 'warning' });
    expect(workspaceBadge(createWorkspaceContext('demo', demoOrg))).toEqual({
      label: 'DEMO DATA',
      tone: 'warning',
    });
    expect(workspaceBadge(createWorkspaceContext('live', liveOrg))).toEqual({
      label: 'LIVE · PRODUCTION',
      tone: 'success',
    });
    expect(workspaceBadge(createWorkspaceContext('live', demoOrg))).toEqual({
      label: 'LIVE · SANDBOX',
      tone: 'success',
    });
    expect(workspaceBadge(createWorkspaceContext('live', { ...liveOrg, environment: 'unknown' }))).toEqual({
      label: 'LIVE · UNKNOWN',
      tone: 'success',
    });
  });
});
