// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DetailDrawer } from './DetailDrawer.tsx';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open detail</button>
      <DetailDrawer open={open} title="Stream detail" breadcrumbs="Explorer / Stream" onClose={() => setOpen(false)}>
        <p>Read-only metadata</p>
      </DetailDrawer>
    </>
  );
}

function UnmountHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open detail</button>
      {open ? (
        <DetailDrawer open title="Stream detail" onClose={() => setOpen(false)}>
          <p>Read-only metadata</p>
        </DetailDrawer>
      ) : null}
    </>
  );
}

describe('DetailDrawer', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('restores focus only after the exit animation removes the dialog', () => {
    vi.useFakeTimers();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open detail' });
    trigger.focus();

    fireEvent.click(trigger);
    const close = screen.getAllByRole('button', { name: 'Close details' }).at(-1)!;
    expect(close).toHaveFocus();

    fireEvent.click(close);
    expect(screen.getByRole('dialog', { name: 'Stream detail' })).toBeInTheDocument();
    expect(close).toHaveFocus();

    // The dialog is still visible while it animates out, so Tab must stay trapped.
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);

    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByRole('dialog', { name: 'Stream detail' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('restores focus when a caller unmounts the drawer directly', () => {
    render(<UnmountHarness />);
    const trigger = screen.getByRole('button', { name: 'Open detail' });
    trigger.focus();

    fireEvent.click(trigger);
    const close = screen.getAllByRole('button', { name: 'Close details' }).at(-1)!;
    expect(close).toHaveFocus();

    fireEvent.click(close);
    expect(screen.queryByRole('dialog', { name: 'Stream detail' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
