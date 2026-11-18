// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { InventoryActions } from '../lib/inventoryActions.tsx';
import { InventoryActionsProvider } from '../lib/inventoryActions.tsx';
import { NoOrgState } from './NoOrgState.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

function actions(overrides: Partial<InventoryActions> = {}): InventoryActions {
  return {
    context: null,
    mode: 'live',
    onGoToOrgs: vi.fn(),
    onToggleMode: vi.fn(),
    isTogglingMode: false,
    refreshInventory: vi.fn(),
    isRefreshingInventory: false,
    refreshError: '',
    ...overrides,
  };
}

function renderState(value: InventoryActions) {
  render(
    <InventoryActionsProvider value={value}>
      <NoOrgState />
    </InventoryActionsProvider>,
  );
}

describe('NoOrgState', () => {
  it('keeps the local live-mode recovery actions unchanged', () => {
    renderState(actions());

    expect(screen.getByRole('button', { name: 'Select an org' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use demo mode' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect Salesforce' })).not.toBeInTheDocument();
  });

  it('keeps the same recovery path in hosted live mode', () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    renderState(actions());

    expect(screen.getByRole('button', { name: 'Select an org' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use demo mode' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('keeps hosted demo-mode recovery on the local copy', () => {
    vi.stubEnv('VITE_HOSTED', 'true');
    renderState(actions({ mode: 'demo' }));

    expect(screen.getByRole('button', { name: 'Select an org' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use demo mode' })).not.toBeInTheDocument();
  });
});
