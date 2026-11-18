// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CopyButton } from './CopyButton.tsx';

describe('CopyButton', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('reports a rejected clipboard write instead of failing silently', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) },
    });

    render(<CopyButton value="Accounts_Stream" label="Copy API name" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy API name' }));

    const button = await screen.findByRole('button', { name: 'Copy failed' });
    expect(button).toHaveTextContent('Copy failed');
  });
});
