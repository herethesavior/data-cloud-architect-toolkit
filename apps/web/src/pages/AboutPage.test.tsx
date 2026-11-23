// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AboutPage } from './AboutPage.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'fullscreenElement');
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  window.history.replaceState(null, '', '/');
});

function enterFullscreen(deck: HTMLElement) {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => deck });
  act(() => document.dispatchEvent(new Event('fullscreenchange')));
}

describe('AboutPage', () => {
  it('presents the product story as readable chapters with a jump index', () => {
    render(<AboutPage onNavigate={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'About DCAT', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('Scroll through the story below, or open the full-screen deck.')).toBeInTheDocument();
    const chapterNav = screen.getByRole('navigation', { name: 'Chapters' });
    expect(chapterNav).toBeInTheDocument();
    expect(within(chapterNav).getAllByRole('button')).toHaveLength(14);
    expect(screen.getByRole('button', { name: '07 Handover' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Carry the architecture forward after Hypercare/ })).toBeInTheDocument();
    expect(screen.getAllByText(/When the support period ends, the customer owns the org/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/It does not replace runbooks, monitoring, or change approvals/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Present' })).toHaveClass('btn-secondary');
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

  it('advances exactly one slide per keypress and ignores repeat events', () => {
    render(<AboutPage onNavigate={vi.fn()} />);
    const deck = document.querySelector('.deck-shell') as HTMLElement;
    enterFullscreen(deck);
    const counter = document.querySelector('.deck-counter') as HTMLElement;
    expect(counter).toHaveTextContent('01');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true }));
    });
    expect(counter).toHaveTextContent('01');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(counter).toHaveTextContent('02');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true }));
    });
    expect(counter).toHaveTextContent('02');
  });

  it('locks page scrolling and ignores chapter hashes while presenting', () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const previousOverflow = document.body.style.overflow;
    render(<AboutPage onNavigate={vi.fn()} />);
    const deck = document.querySelector('.deck-shell') as HTMLElement;
    enterFullscreen(deck);

    expect(document.body.style.overflow).toBe('hidden');
    expect(document.documentElement.style.overflow).toBe('hidden');

    window.history.replaceState(null, '', '/about#story-scroll-flow');
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(scrollIntoView).not.toHaveBeenCalled();

    Reflect.deleteProperty(document, 'fullscreenElement');
    act(() => document.dispatchEvent(new Event('fullscreenchange')));
    expect(document.body.style.overflow).toBe(previousOverflow);

    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'instant', block: 'start' });
  });
});
