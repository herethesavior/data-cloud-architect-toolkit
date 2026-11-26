// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createApiVersionStatus } from '@dcat/core';
import type { BridgeStatus, ConnectorHealth } from '@dcat/core';
import { api } from '../lib/api.ts';
import type { ThemeController } from '../lib/useTheme.ts';
import { Settings } from './Settings.tsx';

const health: ConnectorHealth = {
  status: 'ok',
  mode: 'live',
  version: '0.1.0',
  time: '2026-01-01T00:00:00.000Z',
  cli: { installed: true, version: '2.0.0' },
  compatibility: {
    ...createApiVersionStatus(),
    used: '67.0',
    latest: '68.0',
    verifiedAt: '2026-01-01T00:00:00.000Z',
    probeStatus: 'available',
  },
};

const bridge: BridgeStatus = {
  paired: true,
  mode: 'live',
  version: '0.1.0',
  cli: health.cli,
  compatibility: health.compatibility,
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  relay: 'connected',
  working: false,
  canRepairPairing: false,
  pairing: null,
  agentVersion: '0.1.6',
  latestVersion: '0.1.6',
  updateAvailable: false,
  selfUpdateSupported: true,
};

const theme: ThemeController = {
  preference: 'system',
  resolved: 'light',
  palette: 'forest',
  fontSize: 'medium',
  density: 'comfortable',
  choose: () => {},
  choosePalette: () => {},
  chooseFontSize: () => {},
  chooseDensity: () => {},
  toggle: () => {},
  reset: () => {},
};

interface RenderOptions {
  mode?: 'demo' | 'live';
  theme?: ThemeController;
  onClearCachedMetadata?: () => Promise<void>;
  onResetSavedLayouts?: () => void;
  onEraseLocalData?: () => Promise<void>;
  onRefreshInventory?: () => void;
}

function renderSettings(options: RenderOptions = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mode = options.mode ?? 'live';
  const appearance = options.theme ?? theme;
  const settings = (
    <Settings
      theme={appearance}
      mode={mode}
      onClearCachedMetadata={options.onClearCachedMetadata ?? vi.fn().mockResolvedValue(undefined)}
      onResetSavedLayouts={options.onResetSavedLayouts ?? vi.fn()}
      onEraseLocalData={options.onEraseLocalData ?? vi.fn().mockResolvedValue(undefined)}
      onRefreshInventory={options.onRefreshInventory ?? vi.fn()}
    />
  );
  const view = render(<QueryClientProvider client={queryClient}>{settings}</QueryClientProvider>);
  return {
    queryClient,
    rerenderWithMode: (nextMode: 'demo' | 'live') => view.rerender(
      <QueryClientProvider client={queryClient}>
        <Settings
          theme={appearance}
          mode={nextMode}
          onClearCachedMetadata={vi.fn().mockResolvedValue(undefined)}
          onResetSavedLayouts={vi.fn()}
          onEraseLocalData={vi.fn().mockResolvedValue(undefined)}
        />
      </QueryClientProvider>,
    ),
  };
}

function diagnosticValue(label: string): HTMLElement | null {
  const term = screen.queryAllByText(label).find((element) => element.tagName === 'DT');
  return term?.parentElement?.querySelector('dd') ?? null;
}

describe('Settings bridge diagnostics', () => {
  beforeEach(() => {
    vi.spyOn(api, 'health').mockResolvedValue(health);
    vi.spyOn(api, 'bridgeStatus').mockResolvedValue(bridge);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('shows local connector diagnostics in local mode', async () => {
    vi.mocked(api.bridgeStatus).mockResolvedValue({ ...bridge, agentVersion: null });
    renderSettings();

    expect(await screen.findByRole('heading', { name: 'Bridge and API compatibility' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-check CLI/ })).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(diagnosticValue('Bridge version')).toHaveTextContent('0.1.0');
    expect(screen.queryByText(/OAuth/i)).not.toBeInTheDocument();
  });

  it('shows both Salesforce CLI and API versions with the recommended label', async () => {
    renderSettings();

    expect(await screen.findByRole('heading', { name: 'Bridge and API compatibility' })).toBeInTheDocument();
    expect(diagnosticValue('Salesforce CLI version')).toHaveTextContent('v2.0.0');
    expect(diagnosticValue('Salesforce API version')).toHaveTextContent('v67.0');
    expect(diagnosticValue('API version setting')).toHaveTextContent('DCAT-recommended');
  });

  it('keeps one flat panel free of duplicated and low-value diagnostics', async () => {
    renderSettings();

    expect(await screen.findByRole('heading', { name: 'Bridge and API compatibility' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Local bridge' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Compatibility' })).not.toBeInTheDocument();
    for (const label of [
      'Mode',
      'Checked at',
      'Last check-in',
      'Latest available',
      'DCAT-recommended',
      'Last verified',
    ]) {
      expect(diagnosticValue(label), `no ${label} diagnostic row`).toBeNull();
    }
    expect(screen.getAllByText('Salesforce CLI version')).toHaveLength(1);
    expect(screen.queryByText('Advanced: update Salesforce CLI')).not.toBeInTheDocument();
  });

  it('keeps demo mode on the fixed fixture version', async () => {
    renderSettings({ mode: 'demo' });

    expect(await screen.findByRole('heading', { name: 'Bridge and API compatibility' })).toBeInTheDocument();
    expect(diagnosticValue('Salesforce API version')).toHaveTextContent('v65.0');
    expect(diagnosticValue('API version setting')).toHaveTextContent('Demo fixture');
    await userEvent.click(screen.getByText('Change API version'));
    expect(screen.getByText(/Demo mode always uses the sample API version/)).toBeInTheDocument();
  });

  it('saves a constrained selection and reuses the inventory refresh', async () => {
    const setCompatibility = vi.spyOn(api, 'setCompatibility').mockResolvedValue({
      ...health.compatibility!,
      selection: { mode: 'latest' },
      used: '68.0',
    });
    const onRefreshInventory = vi.fn();
    renderSettings({ onRefreshInventory });

    await userEvent.click(await screen.findByText('Change API version'));
    await userEvent.click(screen.getByRole('radio', { name: /Latest available/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save & refresh' }));

    await waitFor(() => expect(setCompatibility).toHaveBeenCalledWith({ mode: 'latest' }));
    expect(onRefreshInventory).toHaveBeenCalledOnce();
  });

  it('translates a failed compatibility save into guided copy', async () => {
    vi.spyOn(api, 'setCompatibility').mockRejectedValue(new Error('TypeError: TypeError: raw stack trace'));
    renderSettings();

    await userEvent.click(await screen.findByText('Change API version'));
    await userEvent.click(screen.getByRole('button', { name: 'Save & refresh' }));

    expect(await screen.findByText("We couldn't save the API version.")).toBeInTheDocument();
    expect(screen.queryByText(/raw stack trace/)).not.toBeInTheDocument();
  });

  it('shows the paired bridge version instead of the relay version in hosted mode', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    renderSettings();

    expect(await screen.findByRole('heading', { name: 'Bridge and API compatibility' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh status/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Re-check CLI/ })).not.toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(diagnosticValue('Bridge version')).toHaveTextContent('0.1.6');
    expect(diagnosticValue('Bridge version')).not.toHaveTextContent('0.1.0');
    expect(screen.queryByRole('heading', { name: 'Salesforce OAuth' })).not.toBeInTheDocument();
  });

  it('derives hosted health from the single bridge status query', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.health).mockClear();
    renderSettings();

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(api.bridgeStatus).toHaveBeenCalled();
    expect(api.health).not.toHaveBeenCalled();
  });

  it('shows a working bridge without an offline warning', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue({
      ...bridge,
      relay: 'working',
      working: true,
      lastSeenAt: new Date(Date.now() - 90_000).toISOString(),
    });
    renderSettings();

    expect(await screen.findByText('Working')).toBeInTheDocument();
    expect(screen.getByText(/running a long operation/)).toBeInTheDocument();
    expect(screen.queryByText(/has not checked in/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Change API version'));
    expect(screen.getByText('Wait for the bridge to finish its current operation before changing the API version.')).toBeInTheDocument();
    expect(screen.queryByText(/bridge to reconnect/)).not.toBeInTheDocument();
  });

  it('asks for a stale bridge to come back online before changing the API version', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue({ ...bridge, relay: 'stale' });
    renderSettings();

    expect(await screen.findByText('Offline')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Change API version'));
    expect(screen.getByText('Bring the bridge back online before changing the API version.')).toBeInTheDocument();
  });

  it('shows a degraded status when the relay state is temporarily unavailable', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue({ ...bridge, relay: 'unavailable', canRepairPairing: false });
    renderSettings();

    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Bridge status is temporarily unavailable. Refresh to try again.')).toBeInTheDocument();
    expect(diagnosticValue('Bridge status')).toHaveTextContent('Unavailable');

    await userEvent.click(screen.getByText('Change API version'));
    expect(screen.getByText('Bridge status is temporarily unavailable. Refresh status before changing the API version.')).toBeInTheDocument();
  });

  it('does not show the relay version before a hosted bridge has paired', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    vi.mocked(api.bridgeStatus).mockResolvedValue({
      ...bridge,
      paired: false,
      relay: 'waiting',
      agentVersion: null,
    });
    renderSettings();

    expect(await screen.findByRole('heading', { name: 'Bridge and API compatibility' })).toBeInTheDocument();
    expect(diagnosticValue('Bridge version')).toHaveTextContent('—');
  });

  it('clears a stale CLI status error when switching to demo mode', async () => {
    vi.spyOn(api, 'refreshCli').mockRejectedValue(new Error('CLI probe failed.'));
    const { rerenderWithMode } = renderSettings({ mode: 'live' });

    expect(await screen.findByRole('heading', { name: 'Bridge and API compatibility' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Re-check CLI' }));
    expect(await screen.findByText("We couldn't read diagnostics.")).toBeInTheDocument();

    rerenderWithMode('demo');

    expect(screen.queryByText("We couldn't read diagnostics.")).not.toBeInTheDocument();
  });

  it('keeps the page usable when a background diagnostics poll fails', async () => {
    vi.mocked(api.health).mockResolvedValueOnce(health).mockRejectedValue(new Error('Poll failed.'));
    const { queryClient } = renderSettings();

    expect(await screen.findByRole('heading', { name: 'Bridge and API compatibility' })).toBeInTheDocument();
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['health'] });
    });

    expect(await screen.findByText(/Diagnostics refresh failed: We couldn't read diagnostics\./)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Stored data' })).toBeInTheDocument();
  });

  it('shows a full-page error when diagnostics never loaded', async () => {
    vi.mocked(api.health).mockRejectedValue(new Error('Connector offline.'));
    renderSettings();

    expect(await screen.findByText("We couldn't read diagnostics.")).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Bridge and API compatibility' })).not.toBeInTheDocument();
  });
});

describe('Settings stored data controls', () => {
  beforeEach(() => {
    vi.spyOn(api, 'health').mockResolvedValue(health);
    vi.spyOn(api, 'bridgeStatus').mockResolvedValue(bridge);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('explains what is stored and clears only cached metadata on request', async () => {
    const onClearCachedMetadata = vi.fn().mockResolvedValue(undefined);
    renderSettings({ onClearCachedMetadata });

    expect(await screen.findByRole('heading', { name: 'Stored data' })).toBeInTheDocument();
    expect(screen.getByText(/DCAT caches org lists and loaded inventory snapshots here for up to 7 days/i)).toBeInTheDocument();
    expect(screen.getByText(/Access tokens, pairing codes, and customer records are never persisted/i)).toBeInTheDocument();

    await act(async () => {
      screen.getByRole('button', { name: 'Clear cached metadata' }).click();
    });

    expect(onClearCachedMetadata).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Cached metadata cleared/)).toBeInTheDocument();
  });

  it('resets saved layouts with a separate scoped action', async () => {
    const onResetSavedLayouts = vi.fn();
    renderSettings({ onResetSavedLayouts });

    await screen.findByRole('heading', { name: 'Stored data' });
    await act(async () => {
      screen.getByRole('button', { name: 'Reset saved layouts' }).click();
    });

    expect(onResetSavedLayouts).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Saved ERD and Lineage layouts reset/)).toBeInTheDocument();
  });

  it('requires a named confirmation before erasing all local data', async () => {
    const onEraseLocalData = vi.fn().mockResolvedValue(undefined);
    renderSettings({ onEraseLocalData });

    expect(await screen.findByRole('heading', { name: 'Stored data' })).toBeInTheDocument();
    await act(async () => {
      screen.getByRole('button', { name: 'Erase all local data' }).click();
    });

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Erase all local data?' })).toBeInTheDocument();
    expect(within(dialog).getByText('Cached org lists and inventory snapshots')).toBeInTheDocument();
    expect(within(dialog).getByText(/Bridge pairing or the local bridge installation/)).toBeInTheDocument();
    expect(onEraseLocalData).not.toHaveBeenCalled();

    await act(async () => {
      within(dialog).getByRole('button', { name: 'Keep my data' }).click();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onEraseLocalData).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByRole('button', { name: 'Erase all local data' }).click();
    });
    await act(async () => {
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Erase all local data' }).click();
    });

    expect(onEraseLocalData).toHaveBeenCalledOnce();
    expect(await screen.findByText(/All local data erased/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a failed erase inside the dialog instead of hiding it behind the modal', async () => {
    const onEraseLocalData = vi.fn().mockRejectedValue(new Error('Connector offline.'));
    renderSettings({ onEraseLocalData });

    await screen.findByRole('heading', { name: 'Stored data' });
    await act(async () => {
      screen.getByRole('button', { name: 'Erase all local data' }).click();
    });
    await act(async () => {
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Erase all local data' }).click();
    });

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent("Couldn't erase local data.");
    expect(screen.queryByText(/All local data erased/)).not.toBeInTheDocument();
  });
});

describe('Settings appearance controls', () => {
  beforeEach(() => {
    vi.spyOn(api, 'health').mockResolvedValue(health);
    vi.spyOn(api, 'bridgeStatus').mockResolvedValue(bridge);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('updates palette, font size, and density from the Appearance panel', async () => {
    const choosePalette = vi.fn();
    const chooseFontSize = vi.fn();
    const chooseDensity = vi.fn();
    renderSettings({
      theme: {
        ...theme,
        preference: 'dark',
        resolved: 'dark',
        choosePalette,
        chooseFontSize,
        chooseDensity,
      },
    });

    expect(await screen.findByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByText(/with the Forest palette/)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Dark palette' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Midnight' }));
    await userEvent.selectOptions(screen.getByLabelText('Font size'), 'large');
    await userEvent.selectOptions(screen.getByLabelText('Interface density'), 'compact');

    expect(choosePalette).toHaveBeenCalledWith('midnight');
    expect(chooseFontSize).toHaveBeenCalledWith('large');
    expect(chooseDensity).toHaveBeenCalledWith('compact');
  });
});
