// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BridgeStatus, OrgSummary, SessionInfo } from '@dcat/core';
import { api } from '../lib/api.ts';
import { orgsQueryKey } from '../lib/workspace.ts';
import { OrgConnections } from './OrgConnections.tsx';

function status(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
  return {
    paired: true,
    mode: 'live',
    version: '0.1.0',
    cli: { installed: true, version: '2.116.6', error: null },
    lastSeenAt: '2026-11-18T00:00:00.000Z',
    relay: 'connected',
    working: false,
    canRepairPairing: false,
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
  seedOrgs?: OrgSummary[];
  invalidateSeededOrgs?: boolean;
  mode?: 'demo' | 'live';
  queryClient?: QueryClient;
}

function renderOrgConnections(onSelect = vi.fn(), options: RenderOptions = {}) {
  const mode = options.mode ?? 'live';
  const queryClient = options.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (options.seedOrgs) {
    queryClient.setQueryData<OrgSummary[]>(orgsQueryKey(mode), options.seedOrgs);
    if (options.invalidateSeededOrgs) void queryClient.invalidateQueries({ queryKey: orgsQueryKey(mode) });
  }
  const onRemoveOrg = vi.fn();
  const onRestoreOrg = vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <OrgConnections
        mode={mode}
        selectedAlias={null}
        onSelect={onSelect}
        hiddenAliases={options.hiddenAliases ?? []}
        onRemoveOrg={onRemoveOrg}
        onRestoreOrg={onRestoreOrg}
      />
    </QueryClientProvider>,
  );
  const viewFor = (nextMode: 'demo' | 'live') => (
    <QueryClientProvider client={queryClient}>
      <OrgConnections
        mode={nextMode}
        selectedAlias={null}
        onSelect={onSelect}
        hiddenAliases={options.hiddenAliases ?? []}
        onRemoveOrg={onRemoveOrg}
        onRestoreOrg={onRestoreOrg}
      />
    </QueryClientProvider>
  );
  const rerenderWithMode = (nextMode: 'demo' | 'live') => view.rerender(viewFor(nextMode));
  // App keys the page by mode, so a real switch unmounts this component instead
  // of merely rerendering it with a new prop.
  const remountWithMode = (nextMode: 'demo' | 'live') => {
    view.unmount();
    return render(viewFor(nextMode));
  };
  return { onSelect, onRemoveOrg, onRestoreOrg, queryClient, rerenderWithMode, remountWithMode };
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

  it('labels both installed versions in hosted setup', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    renderOrgConnections();

    expect(await screen.findByTitle('Installed DCAT bridge version')).toHaveTextContent('v0.1.4');
    expect(screen.getByTitle('Installed Salesforce CLI version')).toHaveTextContent('v2.116.6');
  });

  it('shows only the SF CLI version in local setup', async () => {
    renderOrgConnections();

    expect(await screen.findByTitle('Installed Salesforce CLI version')).toHaveTextContent('v2.116.6');
    expect(screen.queryByTitle('Installed DCAT bridge version')).not.toBeInTheDocument();
  });

  it('does not show a bridge version before a hosted bridge has paired', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({ paired: false, agentVersion: null, relay: 'waiting' }));
    renderOrgConnections();

    expect(await screen.findByTitle('Installed Salesforce CLI version')).toHaveTextContent('v2.116.6');
    expect(screen.queryByTitle('Installed DCAT bridge version')).not.toBeInTheDocument();
  });

  it('names the hosted status action for what it actually refreshes', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    renderOrgConnections();

    expect(await screen.findByRole('button', { name: 'Refresh status' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Re-check CLI' })).not.toBeInTheDocument();
  });

  it('offers a copyable start command when a paired bridge is stale', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({ relay: 'stale' }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderOrgConnections();

    expect(await screen.findByText('The bridge stopped responding.')).toBeInTheDocument();
    expect(screen.getByText('npx -y @dcat-toolkit/bridge@latest start')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy start command' }));
    expect(writeText).toHaveBeenCalledWith('npx -y @dcat-toolkit/bridge@latest start');
  });

  it('offers the start command while a newly paired bridge checks in', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({ relay: 'waiting', lastSeenAt: null }));
    renderOrgConnections();

    expect(await screen.findByText('Bridge paired. Waiting for its first check-in.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy start command' })).toBeInTheDocument();
  });

  it('offers a fresh pairing code when the relay status is unavailable', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({ relay: 'unavailable' }));
    renderOrgConnections();

    expect(await screen.findByText('Bridge status is temporarily unavailable.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create new pairing code' })).toBeEnabled();
    expect(screen.queryByText('npx -y @dcat-toolkit/bridge@latest start')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy start command' })).not.toBeInTheDocument();
  });

  it('shows the setup command after recovering an unavailable pairing', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    const pairing = {
      code: 'PAIR98765432',
      expiresAt: '2026-11-18T00:10:00.000Z',
      installCommand: 'npx -y @dcat-toolkit/bridge@latest setup --relay https://dcat.example --code PAIR98765432',
    };
    vi.mocked(api.bridgeStatus)
      .mockResolvedValueOnce(status({ relay: 'unavailable' }))
      .mockResolvedValue(status({
        paired: false,
        relay: 'waiting',
        cli: { installed: false, version: null, error: null },
        pairing,
      }));
    const unpair = vi.spyOn(api, 'unpairBridge').mockResolvedValue({ paired: false });
    const relayPairing = vi.spyOn(api, 'relayPairing').mockResolvedValue(pairing);
    renderOrgConnections();

    await userEvent.click(await screen.findByRole('button', { name: 'Create new pairing code' }));

    expect(unpair).toHaveBeenCalledOnce();
    await waitFor(() => expect(relayPairing).toHaveBeenCalledOnce());
    expect(await screen.findByText('PAIR98765432')).toBeInTheDocument();
    expect(screen.getByText(pairing.installCommand)).toBeInTheDocument();
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

  it('does not offer re-pairing while a paired bridge is still waiting for its first check-in', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({
      relay: 'waiting',
      lastSeenAt: null,
      canRepairPairing: false,
    }));
    renderOrgConnections();

    expect(await screen.findByText('Bridge paired. Waiting for its first check-in.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create new pairing code' })).not.toBeInTheDocument();
  });

  it('keeps a long-running bridge working state ready without an offline warning', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({
      relay: 'working',
      working: true,
      lastSeenAt: new Date(Date.now() - 90_000).toISOString(),
    }));
    renderOrgConnections();

    expect(await screen.findByText('Bridge working')).toBeInTheDocument();
    expect(screen.getByText(/running a long operation/)).toBeInTheDocument();
    expect(screen.queryByText('The bridge stopped responding.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect org' })).toBeEnabled();
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
    expect(screen.queryByText(/Bridge update available/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update bridge' })).not.toBeInTheDocument();
  });

  it('offers a copyable update command for a paired hosted bridge with a newer npm release', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({
      agentVersion: '0.1.4',
      latestVersion: '0.1.5',
      updateAvailable: true,
      selfUpdateSupported: true,
    }));
    renderOrgConnections();

    expect(await screen.findByText(/Bridge update available · 0\.1\.5/)).toBeInTheDocument();
    expect(screen.getByText(/Running 0\.1\.4/)).toBeInTheDocument();
    expect(screen.getByText('npm install -g @dcat-toolkit/bridge@latest')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update bridge' })).not.toBeInTheDocument();
  });

  it('offers the same copyable update command when the bridge predates in-app updates', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({
      agentVersion: '0.1.3',
      latestVersion: '0.1.5',
      updateAvailable: true,
      selfUpdateSupported: false,
    }));
    renderOrgConnections();

    expect(await screen.findByText(/Bridge update available · 0\.1\.5/)).toBeInTheDocument();
    expect(screen.getByText('npm install -g @dcat-toolkit/bridge@latest')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update bridge' })).not.toBeInTheDocument();
  });

  it('seeds the connected org into the shared cache before selection so inventory starts immediately', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.orgs).mockResolvedValue([]);
    const connect = vi.spyOn(api, 'connectOrg').mockResolvedValue(connectedOrg);
    const { onSelect, onRestoreOrg, queryClient } = renderOrgConnections();

    await userEvent.click(await screen.findByRole('button', { name: 'Connect org' }));

    await waitFor(() => expect(connect).toHaveBeenCalledWith(
      'my-data360-org', '', undefined, { signal: expect.any(AbortSignal) },
    ));
    await waitFor(() => expect(queryClient.getQueryData<OrgSummary[]>(orgsQueryKey('live'))).toEqual([connectedOrg]));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('prod-org'));
    expect(onRestoreOrg).toHaveBeenCalledWith('prod-org');
    expect(await screen.findByText(/prod-org is connected/)).toBeInTheDocument();
    expect(vi.mocked(api.orgs).mock.calls).toHaveLength(1);
  });

  it('renders a persisted org list without another org.list request', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue(status());
    renderOrgConnections(vi.fn(), { seedOrgs: [connectedOrg] });

    expect(await screen.findByRole('table', { name: 'Authenticated Salesforce orgs' })).toBeInTheDocument();
    expect(api.orgs).not.toHaveBeenCalled();
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

  it('shows a checking skeleton while a seeded org list is refetching in locked live mode', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    let finish!: (orgs: OrgSummary[]) => void;
    const pending = new Promise<OrgSummary[]>((resolve) => {
      finish = resolve;
    });
    vi.mocked(api.orgs).mockReturnValue(pending);
    renderOrgConnections(vi.fn(), { seedOrgs: [], invalidateSeededOrgs: true });

    expect(await screen.findByText('Checking for Salesforce orgs...')).toBeInTheDocument();
    expect(screen.queryByText('Connect an org to view live inventory')).not.toBeInTheDocument();

    finish([]);
    await pending;
    expect(await screen.findByText('Connect an org to view live inventory')).toBeInTheDocument();
    expect(screen.queryByText('Checking for Salesforce orgs...')).not.toBeInTheDocument();
  });

  it('surfaces an org-list failure instead of hiding it behind the locked empty state', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.orgs).mockRejectedValue(new Error('Org check failed.'));
    renderOrgConnections(vi.fn(), { seedOrgs: [], invalidateSeededOrgs: true });

    expect(await screen.findByText("We couldn't check your Salesforce orgs.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry org check' })).toBeInTheDocument();
    expect(screen.queryByText('Connect an org to view live inventory')).not.toBeInTheDocument();
  });

  it('unlocks live inventory once an authenticated org exists', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.orgs).mockResolvedValue([connectedOrg]);
    renderOrgConnections();

    expect(await screen.findByRole('table', { name: 'Authenticated Salesforce orgs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh org list' })).toBeEnabled();
    expect(screen.queryByText('Connect an org to view live inventory')).not.toBeInTheDocument();
  });

  it('disables live setup controls and keeps inventory available in demo mode', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.orgs).mockResolvedValue([]);
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({ mode: 'demo', paired: false, relay: 'waiting' }));
    renderOrgConnections(vi.fn(), { mode: 'demo' });

    expect(await screen.findByText('No authenticated orgs yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh org list' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Connect org' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Re-check CLI' })).toBeDisabled();
    expect(screen.getByLabelText('Org alias')).toBeDisabled();
    expect(screen.getByLabelText(/Sandbox instance URL/)).toBeDisabled();
    expect(screen.getByText(/Demo mode runs on labelled sample data/)).toBeInTheDocument();
    expect(screen.getAllByText('Not needed in demo').length).toBeGreaterThan(0);
    expect(screen.queryByText('Complete step 1 first')).not.toBeInTheDocument();
    expect(screen.queryByText('Connect org unlocks when SF CLI is ready.')).not.toBeInTheDocument();
    expect(screen.queryByText('SF CLI missing')).not.toBeInTheDocument();
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

  it('does not write a connect result into the new mode cache after a mode switch', async () => {
    let finish!: (org: OrgSummary) => void;
    let signal: AbortSignal | undefined;
    const pending = new Promise<OrgSummary>((resolve) => { finish = resolve; });
    vi.spyOn(api, 'connectOrg').mockImplementation(async (_alias, _url, _browser, options) => {
      signal = options?.signal;
      return pending;
    });
    vi.mocked(api.orgs).mockResolvedValue([]);
    const { onSelect, queryClient, remountWithMode } = renderOrgConnections();

    const button = await screen.findByRole('button', { name: 'Connect org' });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    queryClient.setQueryData<SessionInfo>(['session'], { token: 'test-token', mode: 'demo' });
    remountWithMode('demo');
    expect(signal?.aborted).toBe(true);
    finish(connectedOrg);
    await pending;

    await waitFor(() => expect(queryClient.getQueryData<OrgSummary[]>(orgsQueryKey('demo')) ?? []).toEqual([]));
    expect(queryClient.getQueryData<OrgSummary[]>(orgsQueryKey('demo'))).not.toContainEqual(connectedOrg);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not write a refresh result into the new mode cache after a mode switch', async () => {
    let finish!: (orgs: OrgSummary[]) => void;
    const pending = new Promise<OrgSummary[]>((resolve) => { finish = resolve; });
    vi.spyOn(api, 'refreshOrgs').mockReturnValue(pending);
    vi.mocked(api.orgs).mockResolvedValue([]);
    const { queryClient, remountWithMode } = renderOrgConnections(vi.fn(), { seedOrgs: [connectedOrg] });
    await screen.findByRole('table', { name: 'Authenticated Salesforce orgs' });

    await userEvent.click(screen.getByRole('button', { name: 'Refresh org list' }));
    queryClient.setQueryData<SessionInfo>(['session'], { token: 'test-token', mode: 'demo' });
    remountWithMode('demo');
    await waitFor(() => expect(api.orgs).toHaveBeenCalled());
    finish([connectedOrg]);
    await pending;

    await waitFor(() => expect(api.refreshOrgs).toHaveBeenCalledOnce());
    expect(queryClient.getQueryData<OrgSummary[]>(orgsQueryKey('demo')) ?? []).toEqual([]);
  });

  it('surfaces a failed org refresh instead of silently keeping the old list', async () => {
    vi.mocked(api.orgs).mockResolvedValue([connectedOrg]);
    vi.spyOn(api, 'refreshOrgs').mockRejectedValue(new Error('Refresh failed.'));
    renderOrgConnections();

    expect(await screen.findByRole('table', { name: 'Authenticated Salesforce orgs' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh org list' }));

    expect(await screen.findByText(/We couldn't refresh the org list\./)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Authenticated Salesforce orgs' })).toBeInTheDocument();
  });

  it('refreshes bridge status when a pairing reset fails after unpairing', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue(status({ relay: 'stale', canRepairPairing: true }));
    vi.spyOn(api, 'unpairBridge').mockResolvedValue({ paired: false });
    vi.spyOn(api, 'relayPairing').mockRejectedValue(new Error('Pairing unavailable.'));
    const { queryClient } = renderOrgConnections(vi.fn(), { seedOrgs: [] });

    expect(await screen.findByText('The bridge stopped responding.')).toBeInTheDocument();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await userEvent.click(screen.getByRole('button', { name: 'Create new pairing code' }));

    expect(await screen.findByText(/We couldn't complete bridge setup\./)).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bridge-status'] });
  });
});
