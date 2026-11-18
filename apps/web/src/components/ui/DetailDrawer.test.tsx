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

    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByRole('dialog', { name: 'Stream detail' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
