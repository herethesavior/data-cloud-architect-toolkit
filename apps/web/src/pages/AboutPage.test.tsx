// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AboutPage } from './AboutPage.tsx';

afterEach(() => {
  cleanup();
});

describe('AboutPage', () => {
  it('presents the product story as readable chapters with a jump index', () => {
    render(<AboutPage onNavigate={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'About DCAT', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('A product story: why DCAT exists, what it does, and where it can go next.')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Chapters' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /See the architecture behind the data/ })).toBeInTheDocument();
    expect(screen.getAllByText(/See the architecture\. Understand the connections\. Make better decisions\./).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: /Trust makes it valuable/ })).toBeInTheDocument();
    expect(screen.getAllByText(/These are recommended success measures/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Roadmap concepts are proposals/).length).toBeGreaterThan(0);
  });

  it('keeps external links safe and preserves the personal-capacity disclaimer', () => {
    render(<AboutPage onNavigate={vi.fn()} />);

    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(screen.getAllByText(/Created in a personal capacity/).length).toBeGreaterThan(0);
  });

  it('reports when the browser cannot enter full screen', async () => {
    const user = userEvent.setup();
    render(<AboutPage onNavigate={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Present' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Full screen is unavailable in this browser.');
  });

  it('offers a path back into the workbench', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<AboutPage onNavigate={onNavigate} />);

    await user.click(screen.getByRole('button', { name: 'Open Dashboard' }));
    expect(onNavigate).toHaveBeenCalledWith('dashboard');

    await user.click(screen.getByRole('button', { name: 'Read the docs' }));
    expect(onNavigate).toHaveBeenCalledWith('help');
  });
});
