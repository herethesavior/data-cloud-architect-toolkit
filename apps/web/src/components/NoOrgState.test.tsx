// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    orgList: { status: 'idle' },
    onGoToOrgs: vi.fn(),
    onToggleMode: vi.fn(),
    isTogglingMode: false,
    refreshInventory: vi.fn(),
    cancelRefresh: vi.fn(),
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

  it('shows only the checking copy while org discovery is running', () => {
    renderState(actions({ orgList: { status: 'checking' } }));

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Checking for Salesforce orgs...');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('No org selected')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select an org' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use demo mode' })).not.toBeInTheDocument();
  });

  it('keeps retry for org-check errors that a retry can resolve', () => {
    const retry = vi.fn();
    renderState(actions({ orgList: { status: 'error', message: 'Org list timed out.', retry } }));

    expect(screen.getByRole('alert')).toHaveTextContent('Org list timed out.');
    expect(screen.getByRole('button', { name: 'Retry org check' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select an org' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use demo mode' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry org check' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('sends bridge setup errors to Org Connections instead of offering a retry', () => {
    const onGoToOrgs = vi.fn();
    const retry = vi.fn();
    renderState(actions({
      onGoToOrgs,
      orgList: {
        status: 'error',
        message: 'The bridge is not connected.',
        hint: 'Open Org Connections and run the bridge setup command shown there.',
        recovery: 'connect',
        retry,
      },
    }));

    expect(screen.getByRole('alert')).toHaveTextContent('The bridge is not connected.');
    expect(screen.getByRole('button', { name: 'Go to Org Connections' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use demo mode' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry org check' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select an org' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Go to Org Connections' }));
    expect(onGoToOrgs).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});
