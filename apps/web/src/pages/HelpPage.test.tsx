// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelpPage } from './HelpPage.tsx';

afterEach(cleanup);

describe('HelpPage', () => {
  it('explains Data Cloud terms and privacy in grounded tabs', async () => {
    const user = userEvent.setup();
    render(<HelpPage onNavigate={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Help & documentation' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'What is DCAT?' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/Read metadata with allowlisted, read-only Salesforce CLI commands/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Data Cloud glossary' }));
    expect(await screen.findByText('Data Lake Object (DLO)')).toBeInTheDocument();
    expect(screen.getByText('Discovery Health')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Privacy' }));
    expect(await screen.findByText('No hosted OAuth')).toBeInTheDocument();
    expect(screen.getByText(/\/api\/auth\/\* routes are intentionally removed and return 404/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'About & contact' }));
    expect(await screen.findByText('Ryan Joshua Dela Cruz')).toBeInTheDocument();
    expect(screen.getByText('Technical Architect at Salesforce')).toBeInTheDocument();
    expect(screen.getByText(/Created in a personal capacity/)).toBeInTheDocument();
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
