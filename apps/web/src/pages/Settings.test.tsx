// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
};

const bridge: BridgeStatus = {
  paired: true,
  mode: 'live',
  version: '0.1.0',
  cli: health.cli,
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  relay: 'connected',
  pairing: null,
  agentVersion: '0.1.4',
  latestVersion: '0.1.4',
  updateAvailable: false,
  selfUpdateSupported: true,
};

const theme: ThemeController = {
  preference: 'system',
  resolved: 'light',
  choose: () => {},
  toggle: () => {},
  reset: () => {},
};

interface RenderOptions {
  onClearCachedMetadata?: () => Promise<void>;
  onResetSavedLayouts?: () => void;
  onEraseLocalData?: () => Promise<void>;
}

function renderSettings(options: RenderOptions = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Settings
        theme={theme}
        onClearCachedMetadata={options.onClearCachedMetadata ?? vi.fn().mockResolvedValue(undefined)}
        onResetSavedLayouts={options.onResetSavedLayouts ?? vi.fn()}
        onEraseLocalData={options.onEraseLocalData ?? vi.fn().mockResolvedValue(undefined)}
      />
    </QueryClientProvider>,
  );
  return { queryClient };
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
    renderSettings();

    expect(await screen.findByRole('heading', { name: 'Local bridge' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-check CLI/ })).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText(/OAuth/i)).not.toBeInTheDocument();
  });

  it('shows the same bridge diagnostics in hosted mode', async () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    renderSettings();

    expect(await screen.findByRole('heading', { name: 'Local bridge' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-check CLI/ })).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Salesforce OAuth' })).not.toBeInTheDocument();
  });

  it('keeps the page usable when a background diagnostics poll fails', async () => {
    vi.mocked(api.health).mockResolvedValueOnce(health).mockRejectedValue(new Error('Poll failed.'));
    const { queryClient } = renderSettings();

    expect(await screen.findByRole('heading', { name: 'Local bridge' })).toBeInTheDocument();
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['health'] });
    });

    expect(await screen.findByText(/Diagnostics refresh failed: Poll failed./)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Stored data' })).toBeInTheDocument();
  });

  it('shows a full-page error when diagnostics never loaded', async () => {
    vi.mocked(api.health).mockRejectedValue(new Error('Connector offline.'));
    renderSettings();

    expect(await screen.findByText('Connector offline.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Local bridge' })).not.toBeInTheDocument();
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
});
