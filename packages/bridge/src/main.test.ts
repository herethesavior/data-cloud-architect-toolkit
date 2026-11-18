import { beforeEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({
  chmod: vi.fn(async (_path: string, _mode: number) => {}),
  mkdir: vi.fn(async (_path: string, _options: unknown) => {}),
  readFile: vi.fn(async (_path: string, _encoding: string) => ''),
  writeFile: vi.fn(async (_path: string, _data: string, _options: unknown) => {}),
}));

vi.mock('node:fs/promises', () => fs);
vi.mock('node:os', () => ({ homedir: () => '/home/test' }));
vi.mock('../../../apps/local-connector/src/bridge.ts', () => ({
  runBridge: vi.fn(async (options: { onPaired?: (token: string) => void }) => {
    options.onPaired?.('agent-token-1234567890');
  }),
}));
vi.mock('./install.ts', () => ({
  ensureSalesforceCli: vi.fn(async () => ({ installed: true, version: '2.116.6', error: null })),
}));

import { runBridge } from '../../../apps/local-connector/src/bridge.ts';
import { main } from './main.ts';
import { ensureSalesforceCli } from './install.ts';

describe('@dcat-toolkit/bridge CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.readFile.mockResolvedValue('');
  });

  it('installs/checks the CLI, pairs once, and starts the bridge with saved storage', async () => {
    await main(['setup', '--relay', 'https://dcat.example', '--code', 'PAIR12345678']);

    expect(ensureSalesforceCli).toHaveBeenCalledOnce();
    expect(runBridge).toHaveBeenCalledWith(expect.objectContaining({
      relayUrl: 'https://dcat.example',
      code: 'PAIR12345678',
    }));
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('bridge.json'),
      JSON.stringify({ relayUrl: 'https://dcat.example', token: 'agent-token-1234567890', version: '0.1.0' }, null, 2),
      { mode: 0o600 },
    );
    expect(fs.chmod).toHaveBeenCalledWith(expect.stringContaining('bridge.json'), 0o600);
  });

  it('restarts from saved pairing without asking for a code or credentials', async () => {
    fs.readFile.mockResolvedValue(JSON.stringify({
      relayUrl: 'https://dcat.example',
      token: 'agent-token-1234567890',
      version: '0.1.0',
    }));

    await main(['start']);

    expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('bridge.json'), 'utf8');
    expect(runBridge).toHaveBeenCalledWith(expect.objectContaining({
      relayUrl: 'https://dcat.example',
      token: 'agent-token-1234567890',
    }));
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('rejects a relay URL that is not the base HTTPS site origin', async () => {
    await expect(main(['setup', '--relay', 'http://dcat.example', '--code', 'PAIR12345678']))
      .rejects.toThrow('Use only the base HTTPS site URL');
    expect(runBridge).not.toHaveBeenCalled();
  });
});
