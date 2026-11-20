// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InventorySnapshot } from '@dcat/core';
import { demoInventory, demoOrgs } from '@dcat/test-fixtures';
import { api } from '../lib/api.ts';
import { InventoryActionsProvider } from '../lib/inventoryActions.tsx';
import { createWorkspaceContext } from '../lib/workspace.ts';
import { ChangeImpactAnalyzer } from './ChangeImpactAnalyzer.tsx';

const context = createWorkspaceContext('live', {
  ...demoOrgs[0]!,
  alias: 'prod-org',
  orgId: '00DXX0000001PROD',
})!;

function renderAnalyzer(inventory: InventorySnapshot = structuredClone(demoInventory), onNavigate = vi.fn()) {
  vi.spyOn(api, 'inventory').mockResolvedValue(inventory);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <InventoryActionsProvider value={{
        context,
        mode: 'live',
        orgList: { status: 'idle' },
        onGoToOrgs: vi.fn(),
        onToggleMode: vi.fn(),
        isTogglingMode: false,
        refreshInventory: vi.fn(),
        cancelRefresh: vi.fn(),
        isRefreshingInventory: false,
        refreshError: '',
      }}>
        <ChangeImpactAnalyzer context={context} onNavigate={onNavigate} />
      </InventoryActionsProvider>
    </QueryClientProvider>,
  );
  return { onNavigate };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/change-impact');
});

describe('ChangeImpactAnalyzer', () => {
  it('prompts for a target and shows grounded results for a selected object', async () => {
    renderAnalyzer();
    expect(await screen.findByRole('heading', { name: 'Change Impact Analyzer' })).toBeInTheDocument();
    expect(screen.getByText(/Select a DLO, DMO, field, or relationship and see its upstream and downstream dependencies/i)).toBeInTheDocument();
    expect(screen.getByText(/What could be affected if I change this field/i)).toBeInTheDocument();

    const targetList = screen.getByLabelText('Impact targets');
    const accountButton = within(targetList).getAllByRole('button').find((button) =>
      within(button).queryByText('Account_DLO__dll') && !within(button).queryByText('Account_DLO__dll.Name'),
    );
    if (!accountButton) throw new Error('Account DLO target button not found');
    fireEvent.click(accountButton);

    expect(await screen.findByText('Direct dependencies')).toBeInTheDocument();
    expect(screen.getByText('All reviewed paths')).toBeInTheDocument();
    expect(screen.getByText('Downstream / Upstream')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Downstream' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '1 hop' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('link', { name: /Open in Data Lineage Explorer/i }).length).toBeGreaterThan(0);
    expect(screen.getByText(/computed from the current inventory snapshot in this browser/i)).toBeInTheDocument();
  });

  it('honors a deep-linked field target and switches direction and depth', async () => {
    window.history.replaceState(null, '', '/change-impact?target=field:dlo:Account_DLO__dll:Industry&direction=downstream&depth=direct');
    renderAnalyzer();

    expect(await screen.findByText('Direct dependencies')).toBeInTheDocument();
    expect(screen.getByText(/Shareable link/i)).toBeInTheDocument();
    expect(screen.getByText(/target=field/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Downstream' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Both directions' }));
    expect(screen.getByRole('button', { name: 'Both directions' })).toHaveAttribute('aria-pressed', 'true');
    expect(window.location.search).toContain('direction=both');

    fireEvent.click(screen.getByRole('button', { name: 'All paths' }));
    expect(screen.getByRole('button', { name: 'All paths' })).toHaveAttribute('aria-pressed', 'true');
    expect(window.location.search).toContain('depth=all');
    expect(screen.getByText('All reviewed paths')).toBeInTheDocument();
  });

  it('surfaces partial snapshot warnings', async () => {
    const incomplete = structuredClone(demoInventory);
    const capability = incomplete.capabilities.find((entry) => entry.family === 'mappings');
    if (capability) capability.status = 'error';
    renderAnalyzer(incomplete);

    expect(await screen.findByText(/Partial snapshot\./i)).toBeInTheDocument();
    const targetList = screen.getByLabelText('Impact targets');
    fireEvent.click(within(targetList).getAllByRole('button', { name: /Account DLO/i })[0]!);
    expect(await screen.findByText('Direct dependencies')).toBeInTheDocument();
  });

  it('drops a stale deep-linked target id', async () => {
    window.history.replaceState(null, '', '/change-impact?target=object:missing:Nope');
    renderAnalyzer();
    expect(await screen.findByRole('heading', { name: 'Change Impact Analyzer' })).toBeInTheDocument();
    expect(screen.getByText(/Review impact before you change it/i)).toBeInTheDocument();
    await screen.findByLabelText('Impact targets');
    expect(window.location.search).not.toContain('target=');
  });
});
