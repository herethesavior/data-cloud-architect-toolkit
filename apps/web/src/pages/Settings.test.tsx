// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
};

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Settings theme={theme} />
    </QueryClientProvider>,
  );
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
});
