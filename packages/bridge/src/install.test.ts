import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CliError } from '@dcat/salesforce-cli';
import { cliVersionOutput } from '@dcat/test-fixtures';
import { normalizeRelayUrl, parseStoredBridge, validatePairingCode } from './config.ts';
import {
  createNodeCommandRunner,
  ensureSalesforceCli,
  resolveInstalledCommand,
  type CommandResult,
  type CommandRunner,
} from './install.ts';

interface Call {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function runnerWith(calls: Call[], responses: CommandResult[]): CommandRunner {
  return {
    run: vi.fn(async (command, args, env) => {
      calls.push({ command, args: [...args], env });
      return responses.shift() ?? { stdout: '', stderr: '', exitCode: 0 };
    }),
  };
}

describe('bridge installer configuration', () => {
  it('accepts only an HTTPS origin or a local Wrangler origin', () => {
    expect(normalizeRelayUrl('https://dcat.example/')).toBe('https://dcat.example');
    expect(normalizeRelayUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(() => normalizeRelayUrl('http://dcat.example')).toThrow(CliError);
    expect(() => normalizeRelayUrl('https://user:pass@dcat.example')).toThrow(CliError);
    expect(() => normalizeRelayUrl('https://dcat.example/connect')).toThrow(CliError);
    expect(() => normalizeRelayUrl('https://dcat.example?code=abc')).toThrow(CliError);
  });

  it('validates one-time pairing codes and saved configuration', () => {
    expect(validatePairingCode(' PAIR12345678 ')).toBe('PAIR12345678');
    expect(() => validatePairingCode('short')).toThrow(CliError);
    expect(parseStoredBridge({
      relayUrl: 'https://dcat.example',
      token: 'agent-token-1234567890',
      version: '0.1.0',
    })).toEqual({
      relayUrl: 'https://dcat.example',
      token: 'agent-token-1234567890',
      version: '0.1.0',
    });
    expect(() => parseStoredBridge({ relayUrl: 'https://dcat.example', token: 'bad' })).toThrow(CliError);
  });
});

describe('createNodeCommandRunner', () => {
  function fakeChild() {
    return Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
  }

  it('kills a stalled installer instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const spawnFn = (() => child) as unknown as Parameters<typeof createNodeCommandRunner>[1];
      const runner = createNodeCommandRunner(1_000, spawnFn);
      const pending = runner.run('npm', ['install'], {});
      const rejection = expect(pending).rejects.toMatchObject({ code: 'COMMAND_FAILED' });

      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(child.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps captured output so a noisy installer cannot exhaust memory', async () => {
    const child = fakeChild();
    const spawnFn = (() => child) as unknown as Parameters<typeof createNodeCommandRunner>[1];
    const pending = createNodeCommandRunner(60_000, spawnFn).run('npm', ['install'], {});

    child.stdout.emit('data', Buffer.alloc(3 * 1024 * 1024, 'x'));
    child.emit('close', 0);

    const result = await pending;
    expect(result.stdout).toHaveLength(2 * 1024 * 1024);
    expect(result.exitCode).toBe(0);
  });
});

describe('resolveInstalledCommand', () => {
  it('passes non-SF commands through without a shim lookup', () => {
    expect(resolveInstalledCommand('npm', ['install', '-g', '@salesforce/cli'], {})).toEqual({
      command: 'npm',
      args: ['install', '-g', '@salesforce/cli'],
    });
  });
});

describe('ensureSalesforceCli', () => {
  it('uses an existing Salesforce CLI without invoking npm', async () => {
    const calls: Call[] = [];
    const env: NodeJS.ProcessEnv = { PATH: '/base', npm_execpath: '/tools/npm-cli.js' };
    const status = await ensureSalesforceCli({
      env,
      runner: runnerWith(calls, [{ stdout: cliVersionOutput, stderr: '', exitCode: 0 }]),
      platform: 'linux',
    });

    expect(status).toEqual({ installed: true, version: '2.116.6', error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: 'sf', args: ['--version'] });
    expect(env.PATH).toBe('/base');
  });

  it('installs the CLI, updates PATH, and verifies the new shim', async () => {
    const calls: Call[] = [];
    const env: NodeJS.ProcessEnv = { PATH: '/base', npm_execpath: '/tools/npm-cli.js' };
    const responses: CommandResult[] = [
      { stdout: '', stderr: 'not found', exitCode: 1 },
      { stdout: 'added @salesforce/cli', stderr: '', exitCode: 0 },
      { stdout: '/opt/npm-global\n', stderr: '', exitCode: 0 },
      { stdout: cliVersionOutput, stderr: '', exitCode: 0 },
    ];
    const logger = vi.fn();

    const status = await ensureSalesforceCli({
      env,
      runner: runnerWith(calls, responses),
      logger,
      platform: 'linux',
    });

    expect(status.version).toBe('2.116.6');
    expect(calls[1]?.args).toEqual(['/tools/npm-cli.js', 'install', '-g', '@salesforce/cli']);
    expect(calls[2]?.args).toEqual(['/tools/npm-cli.js', 'config', 'get', 'prefix']);
    expect(env.PATH).toBe('/opt/npm-global/bin:/opt/npm-global:/base');
    expect(calls[3]?.env.PATH).toBe('/opt/npm-global/bin:/opt/npm-global:/base');
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Installing @salesforce/cli'));
  });

  it('reports install failures and honours skip-install checks', async () => {
    const calls: Call[] = [];
    const env: NodeJS.ProcessEnv = { PATH: '/base', npm_execpath: '/tools/npm-cli.js' };
    await expect(ensureSalesforceCli({
      env,
      runner: runnerWith(calls, [
        { stdout: '', stderr: 'not found', exitCode: 1 },
        { stdout: '', stderr: 'network down', exitCode: 1 },
      ]),
      platform: 'linux',
    })).rejects.toMatchObject({ code: 'COMMAND_FAILED', message: expect.stringContaining('network down') });

    const skipped: Call[] = [];
    await expect(ensureSalesforceCli({
      env,
      runner: runnerWith(skipped, [{ stdout: '', stderr: 'not found', exitCode: 1 }]),
      platform: 'linux',
      skipInstall: true,
    })).rejects.toMatchObject({ code: 'CLI_NOT_FOUND' });
    expect(skipped).toHaveLength(1);
  });
});
