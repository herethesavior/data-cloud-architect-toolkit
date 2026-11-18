// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BridgeStatus, OrgSummary } from '@dcat/core';
import { api } from '../lib/api.ts';
import { OrgConnections } from './OrgConnections.tsx';

function status(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
  return {
    paired: true,
    mode: 'live',
    version: '0.1.0',
    cli: { installed: true, version: '2.116.6', error: null },
    lastSeenAt: '2026-11-18T00:00:00.000Z',
    relay: 'connected',
    pairing: null,
    ...overrides,
  };
}

const connectedOrg: OrgSummary = {
  alias: 'prod-org',
  username: 'dev@example.com',
  orgId: '00DXX0000001PROD',
  environment: 'production',
  connectedStatus: 'Connected',
  isDefault: true,
  isDevHub: false,
  source: 'salesforce-cli',
};

function renderOrgConnections(onSelect = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <OrgConnections selectedAlias={null} onSelect={onSelect} />
    </QueryClientProvider>,
  );
  return { onSelect, queryClient };
}

describe('OrgConnections connect wizard', () => {
  beforeEach(() => {
    vi.spyOn(api, 'orgs').mockResolvedValue([]);
    vi.spyOn(api, 'bridgeStatus').mockResolvedValue(status());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('unlocks Connect org when the local Salesforce CLI is ready', async () => {
    renderOrgConnections();

    expect(await screen.findByRole('heading', { name: 'Set up SF CLI' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Connect org' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'View inventory' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect org' })).toBeEnabled());
    expect(screen.queryByText(/OAuth/i)).not.toBeInTheDocument();
  });

  it('shows the one-time pairing command and keeps Connect org locked when hosted setup is pending', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({
      paired: false,
      relay: 'waiting',
      cli: { installed: false, version: null, error: null },
      lastSeenAt: null,
      pairing: {
        code: 'PAIR12345678',
        expiresAt: '2026-11-18T00:10:00.000Z',
        installCommand: 'npx -y @dcat-toolkit/bridge@latest setup --relay https://dcat.example --code PAIR12345678',
      },
    }));
    renderOrgConnections();

    expect(await screen.findByText('PAIR12345678')).toBeInTheDocument();
    expect(screen.getByText(/npx -y @dcat-toolkit\/bridge@latest setup/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect org' })).toBeDisabled();
    expect(screen.getByText('Complete step 1 first')).toBeInTheDocument();
  });

  it('seeds the connected org into the shared cache before selection so inventory starts immediately', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.orgs).mockResolvedValue([]);
    const connect = vi.spyOn(api, 'connectOrg').mockResolvedValue(connectedOrg);
    const { onSelect, queryClient } = renderOrgConnections();

    await userEvent.click(await screen.findByRole('button', { name: 'Connect org' }));

    await waitFor(() => expect(connect).toHaveBeenCalledWith('my-data360-org', '', undefined));
    await waitFor(() => expect(queryClient.getQueryData<OrgSummary[]>(['orgs'])).toEqual([connectedOrg]));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('prod-org'));
    expect(await screen.findByText(/prod-org is connected/)).toBeInTheDocument();
    expect(vi.mocked(api.orgs).mock.calls).toHaveLength(1);
  });

  it('ignores repeated Connect org clicks while a login is in flight', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    let finish!: (org: OrgSummary) => void;
    const pending = new Promise<OrgSummary>((resolve) => {
      finish = resolve;
    });
    const connect = vi.spyOn(api, 'connectOrg').mockReturnValue(pending);
    renderOrgConnections();

    const button = await screen.findByRole('button', { name: 'Connect org' });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await userEvent.click(button);

    expect(connect).toHaveBeenCalledTimes(1);
    finish(connectedOrg);
    await pending;
  });

  it('keeps live inventory locked while step 1 and step 2 are incomplete', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.orgs).mockResolvedValue([]);
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({
      paired: false,
      relay: 'waiting',
      cli: { installed: false, version: null, error: null },
      lastSeenAt: null,
    }));
    renderOrgConnections();

    expect(await screen.findByText('Finish setup to view live inventory')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh org list' })).toBeDisabled();
    expect(screen.queryByRole('table', { name: 'Authenticated Salesforce orgs' })).not.toBeInTheDocument();
  });

  it('asks for an org before showing live inventory when the bridge is ready', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.orgs).mockResolvedValue([]);
    renderOrgConnections();

    expect(await screen.findByText('Connect an org to view live inventory')).toBeInTheDocument();
    expect(screen.getByText('Complete steps 1 and 2 first')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh org list' })).toBeDisabled();
  });

  it('unlocks live inventory once an authenticated org exists', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.orgs).mockResolvedValue([connectedOrg]);
    renderOrgConnections();

    expect(await screen.findByRole('table', { name: 'Authenticated Salesforce orgs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh org list' })).toBeEnabled();
    expect(screen.queryByText('Connect an org to view live inventory')).not.toBeInTheDocument();
  });

  it('does not gate inventory in hosted demo mode', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.orgs).mockResolvedValue([]);
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({ mode: 'demo', paired: false, relay: 'waiting' }));
    renderOrgConnections();

    expect(await screen.findByText('No authenticated orgs yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh org list' })).toBeEnabled();
  });
});
