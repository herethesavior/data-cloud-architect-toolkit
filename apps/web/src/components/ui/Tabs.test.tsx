// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs } from './Tabs.tsx';

afterEach(cleanup);

const items = [
  { id: 'one', label: 'One', content: <p>First panel</p> },
  { id: 'two', label: 'Two', content: <p>Second panel</p> },
  { id: 'three', label: 'Three', content: <p>Third panel</p> },
];

describe('Tabs', () => {
  it('moves selection and focus with arrow keys, Home, and End', async () => {
    const user = userEvent.setup();
    render(<Tabs items={items} label="Sections" />);
    const first = screen.getByRole('tab', { name: 'One' });
    expect(first).toHaveAttribute('aria-selected', 'true');

    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Second panel')).toBeInTheDocument();

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Three' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
  });

  it('only advertises the panel that is actually rendered', () => {
    render(<Tabs items={items} label="Sections" />);
    const active = screen.getByRole('tab', { name: 'One' });
    const inactive = screen.getByRole('tab', { name: 'Two' });
    const panel = document.getElementById(active.getAttribute('aria-controls')!);

    expect(panel).toHaveTextContent('First panel');
    expect(inactive).not.toHaveAttribute('aria-controls');
  });

  it('supports controlled selection for URL-backed tabs', async () => {
    const user = userEvent.setup();
    const onActiveChange = vi.fn();
    const { rerender } = render(
      <Tabs items={items} label="Sections" activeId="one" onActiveChange={onActiveChange} />,
    );

    await user.click(screen.getByRole('tab', { name: 'Two' }));
    expect(onActiveChange).toHaveBeenCalledWith('two');
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');

    rerender(<Tabs items={items} label="Sections" activeId="two" onActiveChange={onActiveChange} />);
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Second panel')).toBeInTheDocument();
  });
});
