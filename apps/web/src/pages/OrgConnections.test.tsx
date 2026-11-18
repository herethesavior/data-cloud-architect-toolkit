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
    agentVersion: '0.1.4',
    latestVersion: '0.1.4',
    updateAvailable: false,
    selfUpdateSupported: true,
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

interface RenderOptions {
  hiddenAliases?: readonly string[];
}

function renderOrgConnections(onSelect = vi.fn(), options: RenderOptions = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onRemoveOrg = vi.fn();
  const onRestoreOrg = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <OrgConnections
        selectedAlias={null}
        onSelect={onSelect}
        hiddenAliases={options.hiddenAliases ?? []}
        onRemoveOrg={onRemoveOrg}
        onRestoreOrg={onRestoreOrg}
      />
    </QueryClientProvider>,
  );
  return { onSelect, onRemoveOrg, onRestoreOrg, queryClient };
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

  it('hides the bridge update control when the paired agent is current', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({
      agentVersion: '0.1.4',
      latestVersion: '0.1.4',
      updateAvailable: false,
      selfUpdateSupported: true,
    }));
    renderOrgConnections();

    expect(await screen.findByText('Bridge connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update bridge' })).not.toBeInTheDocument();
  });

  it('offers a self-update for a paired hosted bridge with a newer npm release', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({
      agentVersion: '0.1.4',
      latestVersion: '0.1.5',
      updateAvailable: true,
      selfUpdateSupported: true,
    }));
    const update = vi.spyOn(api, 'updateBridge').mockResolvedValue({
      updated: true,
      restarting: true,
      message: 'Bridge updated and restarting.',
    });
    renderOrgConnections();

    expect(await screen.findByText(/Bridge update available/)).toBeInTheDocument();
    expect(screen.getByText(/Running 0\.1\.4/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Update bridge' }));

    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(await screen.findByText('Bridge updated and restarting.')).toBeInTheDocument();
  });

  it('offers a fixed copyable command for older bridges that cannot self-update', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({
      agentVersion: '0.1.3',
      latestVersion: '0.1.5',
      updateAvailable: true,
      selfUpdateSupported: false,
    }));
    const update = vi.spyOn(api, 'updateBridge');
    renderOrgConnections();

    expect(await screen.findByText(/bridge predates in-app updates/)).toBeInTheDocument();
    expect(screen.getByText('npm install -g @dcat-toolkit/bridge@latest')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update bridge' })).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('seeds the connected org into the shared cache before selection so inventory starts immediately', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.orgs).mockResolvedValue([]);
    const connect = vi.spyOn(api, 'connectOrg').mockResolvedValue(connectedOrg);
    const { onSelect, onRestoreOrg, queryClient } = renderOrgConnections();

    await userEvent.click(await screen.findByRole('button', { name: 'Connect org' }));

    await waitFor(() => expect(connect).toHaveBeenCalledWith('my-data360-org', '', undefined));
    await waitFor(() => expect(queryClient.getQueryData<OrgSummary[]>(['orgs'])).toEqual([connectedOrg]));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('prod-org'));
    expect(onRestoreOrg).toHaveBeenCalledWith('prod-org');
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

  it('hides an org from DCAT only after an explicit per-row confirmation', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.orgs).mockResolvedValue([connectedOrg]);
    const { onRemoveOrg } = renderOrgConnections();

    expect(await screen.findByRole('table', { name: 'Authenticated Salesforce orgs' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove prod-org' }));

    expect(screen.getByText('Hide from DCAT?')).toBeInTheDocument();
    expect(onRemoveOrg).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Confirm remove prod-org' }));

    expect(onRemoveOrg).toHaveBeenCalledWith('prod-org');
    expect(await screen.findByText(/hidden from DCAT only/)).toBeInTheDocument();
  });

  it('shows and restores removed orgs without touching Salesforce CLI auth', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.orgs).mockResolvedValue([connectedOrg]);
    const { onRestoreOrg } = renderOrgConnections(vi.fn(), { hiddenAliases: ['prod-org'] });

    const showRemoved = await screen.findByRole('button', { name: 'Show removed orgs (1)' });
    expect(screen.queryByRole('table', { name: 'Authenticated Salesforce orgs' })).not.toBeInTheDocument();

    await userEvent.click(showRemoved);

    expect(await screen.findByRole('table', { name: 'Orgs hidden from DCAT' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restore prod-org' }));

    expect(onRestoreOrg).toHaveBeenCalledWith('prod-org');
    expect(await screen.findByText(/visible in DCAT again/)).toBeInTheDocument();
  });

  it('never shows demo-fixture orgs in a live inventory table', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    const demoOrg: OrgSummary = {
      ...connectedOrg,
      alias: 'demo-uat',
      environment: 'sandbox',
      source: 'demo-fixture',
    };
    vi.mocked(api.orgs).mockResolvedValue([demoOrg, connectedOrg]);
    renderOrgConnections();

    expect(await screen.findByRole('table', { name: 'Authenticated Salesforce orgs' })).toBeInTheDocument();
    expect(screen.queryByText('demo-uat')).not.toBeInTheDocument();
    expect(screen.getByText('prod-org')).toBeInTheDocument();
  });
});
