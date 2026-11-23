// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelpPage } from './HelpPage.tsx';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('HelpPage', () => {
  it('opens with quick answers and actions that navigate to the right views', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<HelpPage onNavigate={onNavigate} />);

    expect(screen.getByRole('heading', { name: 'Help & documentation' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Start here' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('What do I need to get started?')).toBeInTheDocument();
    expect(screen.getByText('What do I use after Hypercare?')).toBeInTheDocument();
    expect(screen.getByText(/When the customer owns the org, use DCAT/)).toBeInTheDocument();
    expect(screen.getByText('After Hypercare: customer-owned support')).toBeInTheDocument();
    expect(screen.getByText(/Will I see customer or transaction records/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Read the handover use case' }));
    expect(onNavigate).toHaveBeenCalledWith('about');

    await user.click(screen.getByRole('button', { name: 'Open Data Lineage Explorer' }));
    expect(onNavigate).toHaveBeenCalledWith('lineage');
  });

  it('explains connection, status, and refresh behaviour', async () => {
    const user = userEvent.setup();
    render(<HelpPage onNavigate={vi.fn()} />);

    await user.click(screen.getByRole('tab', { name: 'Connect & refresh' }));
    expect(await screen.findByText('Connect in three steps')).toBeInTheDocument();
    expect(screen.getByText('Forbidden')).toBeInTheDocument();
    expect(screen.getByText(/Ask your admin for metadata API access/)).toBeInTheDocument();
  });

  it('maps questions to explorers and explains link grounding', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<HelpPage onNavigate={onNavigate} />);

    await user.click(screen.getByRole('tab', { name: 'Explore & trace' }));
    expect(await screen.findByText('Pick the view for your question')).toBeInTheDocument();
    expect(screen.getByText(/The header picker switches the active org/)).toBeInTheDocument();
    expect(screen.getByText('Named in metadata')).toBeInTheDocument();
    expect(screen.getByText(/never presented as a declared edge/)).toBeInTheDocument();

    const openButtons = screen.getAllByRole('button', { name: 'Open' });
    await user.click(openButtons[0]!);
    expect(onNavigate).toHaveBeenCalledWith('dlos');
  });

  it('filters glossary terms and keeps the privacy guarantees', async () => {
    const user = userEvent.setup();
    render(<HelpPage onNavigate={vi.fn()} />);

    await user.click(screen.getByRole('tab', { name: 'Glossary' }));
    expect(await screen.findByText('Data Lake Object (DLO)')).toBeInTheDocument();
    expect(screen.getByText('Discovery Health')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Filter glossary terms' }), 'mapping');
    expect(screen.getByText('Mapping')).toBeInTheDocument();
    expect(screen.getByText('Data Lineage Explorer')).toBeInTheDocument();
    expect(screen.queryByText('Discovery Health')).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 2 of 13 terms/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Status & privacy' }));
    expect(await screen.findByText(/Read metadata with allowlisted, read-only Salesforce CLI commands/)).toBeInTheDocument();
    expect(screen.getByText(/inventory.start, inventory.status, transform.get/)).toBeInTheDocument();
    expect(screen.getByText('No hosted OAuth')).toBeInTheDocument();
    expect(screen.getByText(/\/api\/auth\/\* routes are intentionally removed and return 404/)).toBeInTheDocument();
  });

  it('keeps the selected topic in the URL for reload, back, and deep links', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/help?topic=glossary');
    render(<HelpPage onNavigate={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Glossary' })).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('tab', { name: 'Status & privacy' }));
    expect(window.location.pathname).toBe('/help');
    expect(window.location.search).toBe('?topic=status');

    window.history.replaceState(null, '', '/help?topic=connect');
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(await screen.findByRole('tab', { name: 'Connect & refresh' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps authorship and contact links without repeating the product story', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<HelpPage onNavigate={onNavigate} />);

    await user.click(screen.getByRole('tab', { name: 'Contact' }));
    expect(await screen.findByText('Ryan Joshua Dela Cruz')).toBeInTheDocument();
    expect(screen.getByText('Technical Architect at Salesforce')).toBeInTheDocument();
    expect(screen.getByText(/Created in a personal capacity/)).toBeInTheDocument();
    expect(screen.getByText(/Looking for the product story/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Read the product story' }));
    expect(onNavigate).toHaveBeenCalledWith('about');

    expect(screen.queryByText(/See the architecture\. Understand the connections\. Make better decisions\./)).not.toBeInTheDocument();
    expect(screen.queryByText(/local-first, read-only workbench designed to make Salesforce Data Cloud/)).not.toBeInTheDocument();
    expect(screen.queryByText(/distinguishes confirmed relationships from inferred ones/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open GitHub Issues \(opens in a new tab\)/ })).toHaveAttribute(
      'href',
      'https://github.com/herethesavior/data-cloud-architect-toolkit/issues',
    );
    expect(screen.getByRole('link', { name: /Connect on LinkedIn \(opens in a new tab\)/ })).toHaveAttribute(
      'href',
      'https://www.linkedin.com/in/ryanjoshuadc',
    );
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });
});
