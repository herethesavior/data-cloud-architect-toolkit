import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner } from './install.ts';
import { prepareBridgeUpdate } from './update.ts';

function runner(results: Array<{ stdout?: string; stderr?: string; exitCode?: number }>): CommandRunner {
  const run = vi.fn(async (): Promise<CommandResult> => {
    const next = results.shift() ?? { stdout: '', stderr: '', exitCode: 0 };
    return { stdout: next.stdout ?? '', stderr: next.stderr ?? '', exitCode: next.exitCode ?? 0 };
  });
  return { run };
}

function callArgs(commandRunner: CommandRunner, index: number): string[] {
  const call = vi.mocked(commandRunner.run).mock.calls[index];
  if (!call) throw new Error(`Missing runner call ${index}`);
  return [...call[1]];
}

function detachedChild() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const child = {
    unref: vi.fn(),
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
      return child;
    }),
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.(...args);
    },
  };
  return child;
}

describe('bridge self-update', () => {
  it('installs one resolved version and starts that exact version on handoff', async () => {
    const commandRunner = runner([
      { stdout: '"0.2.2"' },
      { stdout: 'added 1 package' },
    ]);
    const child = detachedChild();
    const spawnDetached = vi.fn((_command: string, _args: readonly string[], _options: unknown) => child);
    const logger = vi.fn();

    const update = await prepareBridgeUpdate({
      env: { PATH: '/usr/bin' },
      runner: commandRunner,
      spawnDetached,
      logger,
      logArgs: ['--verbose'],
    });

    expect(update.version).toBe('0.2.2');
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(callArgs(commandRunner, 0)).toEqual(expect.arrayContaining(['view', '@dcat-toolkit/bridge', 'version', '--json']));
    expect(callArgs(commandRunner, 1)).toEqual(expect.arrayContaining(['install', '-g', '@dcat-toolkit/bridge@0.2.2']));

    const completion = update.complete();
    child.emit('spawn');
    await expect(completion).resolves.toBeUndefined();

    expect(spawnDetached).toHaveBeenCalledOnce();
    const [command, args, options] = vi.mocked(spawnDetached).mock.calls[0]!;
    expect(command).toBeTruthy();
    expect(args).toContain('--package=@dcat-toolkit/bridge@0.2.2');
    expect(args).toContain('--verbose');
    expect(options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('0.2.2'));
  });

  it('refuses to install when npm cannot return a valid version', async () => {
    await expect(prepareBridgeUpdate({
      env: { PATH: '/usr/bin' },
      runner: runner([{ stdout: 'not json' }]),
      spawnDetached: vi.fn(),
    })).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });

    await expect(prepareBridgeUpdate({
      env: { PATH: '/usr/bin' },
      runner: runner([{ stdout: '"latest"', exitCode: 1 }]),
      spawnDetached: vi.fn(),
    })).rejects.toMatchObject({ code: 'COMMAND_FAILED' });

    await expect(prepareBridgeUpdate({
      env: { PATH: '/usr/bin' },
      runner: runner([{ stdout: '"../../evil"' }]),
      spawnDetached: vi.fn(),
    })).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('does not start a replacement when installation fails', async () => {
    const commandRunner = runner([
      { stdout: '"0.2.2"' },
      { stderr: 'EACCES', exitCode: 1 },
    ]);
    const spawnDetached = vi.fn();

    await expect(prepareBridgeUpdate({
      env: { PATH: '/usr/bin' },
      runner: commandRunner,
      spawnDetached,
    })).rejects.toMatchObject({ code: 'COMMAND_FAILED' });

    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('reports synchronous and asynchronous spawn failures through the handoff', async () => {
    const sync = await prepareBridgeUpdate({
      env: { PATH: '/usr/bin' },
      runner: runner([{ stdout: '"0.2.2"' }, {}]),
      spawnDetached: () => {
        throw new Error('spawn failed');
      },
    });
    await expect(sync.complete()).rejects.toThrow('spawn failed');

    const child = detachedChild();
    const asyncUpdate = await prepareBridgeUpdate({
      env: { PATH: '/usr/bin' },
      runner: runner([{ stdout: '"0.2.2"' }, {}]),
      spawnDetached: () => child,
    });
    const completion = asyncUpdate.complete();
    child.emit('error', new Error('ENOENT'));
    await expect(completion).rejects.toThrow('ENOENT');
    expect(child.unref).not.toHaveBeenCalled();
  });
});
