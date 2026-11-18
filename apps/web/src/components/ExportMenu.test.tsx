// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExportMenu } from './ExportMenu.tsx';
import type { ExportMenuItem } from './ExportMenu.tsx';

afterEach(cleanup);

function makeItems(onSelect: () => void = () => {}): ExportMenuItem[] {
  return [
    { id: 'csv', label: 'CSV', description: 'Comma-separated values', icon: 'database', onSelect },
    { id: 'json', label: 'JSON', icon: 'layers', onSelect },
    { id: 'markdown', label: 'Markdown', icon: 'book', onSelect },
  ];
}

describe('ExportMenu', () => {
  it('exposes menu semantics and focuses the first item when opened', async () => {
    const user = userEvent.setup();
    render(<ExportMenu items={makeItems()} />);
    const trigger = screen.getByRole('button', { name: 'Export' });

    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveFocus();
  });

  it('portals the menu outside a clipping parent', async () => {
    const user = userEvent.setup();
    render(
      <div data-testid="clipping-parent" style={{ overflow: 'hidden', width: 120, height: 32 }}>
        <ExportMenu items={makeItems()} />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'Export' }));

    const menu = screen.getByRole('menu');
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getByTestId('clipping-parent')).not.toContainElement(menu);
  });

  it('navigates with arrow keys, Home, and End', async () => {
    const user = userEvent.setup();
    render(<ExportMenu items={makeItems()} />);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    const items = screen.getAllByRole('menuitem');

    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(items[2]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(items[2]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(items[0]).toHaveFocus();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<ExportMenu items={makeItems()} />);
    const trigger = screen.getByRole('button', { name: 'Export' });
    await user.click(trigger);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('closes on Tab and lets focus continue to the next control', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ExportMenu items={makeItems()} />
        <button type="button">After menu</button>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Export' }));

    await user.tab();

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'After menu' })).toHaveFocus();
  });

  it('closes when clicking outside', async () => {
    const user = userEvent.setup();
    render(<ExportMenu items={makeItems()} />);
    await user.click(screen.getByRole('button', { name: 'Export' }));

    await user.click(document.body);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('does not open when disabled', async () => {
    const user = userEvent.setup();
    render(<ExportMenu items={makeItems()} disabled />);
    const trigger = screen.getByRole('button', { name: 'Export' });

    expect(trigger).toBeDisabled();
    await user.click(trigger);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('only calls onSelect after an item is chosen', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ExportMenu items={makeItems(onSelect)} />);
    const trigger = screen.getByRole('button', { name: 'Export' });

    await user.click(trigger);
    expect(onSelect).not.toHaveBeenCalled();

    await user.click(screen.getByRole('menuitem', { name: /CSV/i }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
