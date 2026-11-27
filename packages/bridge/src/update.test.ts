import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner } from './install.ts';
import { updateBridge } from './update.ts';

function runner(exitCode: number): CommandRunner {
  return {
    run: vi.fn(async (): Promise<CommandResult> => ({
      stdout: '',
      stderr: exitCode === 0 ? '' : 'npm install failed',
      exitCode,
    })),
  };
}

describe('bridge self-update', () => {
  it('installs the latest package and starts a detached replacement', async () => {
    const commandRunner = runner(0);
    const child = { unref: vi.fn() };
    const spawnDetached = vi.fn(() => child);
    const logger = vi.fn();

    const result = await updateBridge({
      env: { PATH: '/usr/bin' },
      runner: commandRunner,
      spawnDetached,
      logger,
    });

    expect(result).toEqual({ updated: true, restarting: true, message: 'Bridge updated and restarting.' });
    const [command, args] = vi.mocked(commandRunner.run).mock.calls[0]!;
    expect(args).toContain('install');
    expect(args).toContain('-g');
    expect(args).toContain('@dcat-toolkit/bridge@latest');
    expect(command).toBeTruthy();
    expect(spawnDetached).toHaveBeenCalledWith(
      command,
      expect.arrayContaining(['exec', '--yes', '--package=@dcat-toolkit/bridge@latest', 'dcat-bridge', 'start']),
      expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Bridge update installed'));
  });

  it('keeps the requested log level when starting the replacement', async () => {
    const spawnDetached = vi.fn(() => ({ unref: vi.fn() }));

    await updateBridge({
      env: { PATH: '/usr/bin' },
      runner: runner(0),
      spawnDetached,
      logArgs: ['--quiet'],
    });

    expect(spawnDetached).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['dcat-bridge', 'start', '--quiet']),
      expect.anything(),
    );
  });

  it('reports an install failure without starting a replacement', async () => {
    const spawnDetached = vi.fn(() => ({ unref: vi.fn() }));
    await expect(updateBridge({
      env: { PATH: '/usr/bin' },
      runner: runner(1),
      spawnDetached,
    })).rejects.toThrow(/npm install failed/);
    expect(spawnDetached).not.toHaveBeenCalled();
  });
});
