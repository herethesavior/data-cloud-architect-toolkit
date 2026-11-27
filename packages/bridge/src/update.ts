import { spawn } from 'node:child_process';
import { CliError, safeErrorMessage } from '@dcat/salesforce-cli';
import { createNodeCommandRunner, npmInvocation, type CommandRunner } from './install.ts';

export interface BridgeUpdateResult {
  updated: true;
  restarting: true;
  message: string;
}

interface DetachedChild {
  unref(): void;
}

type SpawnDetached = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached: boolean;
    stdio: 'ignore';
    windowsHide: boolean;
  },
) => DetachedChild;

export interface UpdateOptions {
  logger?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  timeoutMs?: number;
  spawnDetached?: SpawnDetached;
}

const defaultSpawnDetached: SpawnDetached = (command, args, options) => spawn(command, args, options);

/**
 * Install the newest published bridge, then hand off to a detached replacement
 * agent that reuses the saved pairing. No command text comes from the browser.
 */
export async function updateBridge(options: UpdateOptions = {}): Promise<BridgeUpdateResult> {
  const env = options.env ?? process.env;
  const runner = options.runner ?? createNodeCommandRunner(options.timeoutMs ?? 5 * 60_000);
  const logger = options.logger ?? (() => {});
  const spawnDetached = options.spawnDetached ?? defaultSpawnDetached;
  const npm = npmInvocation(env);

  const install = await runner.run(
    npm.command,
    [...npm.args, 'install', '-g', '@dcat-toolkit/bridge@latest'],
    env,
  );
  if (install.exitCode !== 0) {
    const detail = safeErrorMessage(new Error(
      install.stderr || install.stdout || 'Could not install the latest bridge.',
    ));
    throw new CliError('COMMAND_FAILED', detail);
  }

  const child = spawnDetached(
    npm.command,
    [...npm.args, 'exec', '--yes', '--package=@dcat-toolkit/bridge@latest', '--', 'dcat-bridge', 'start'],
    {
      cwd: process.cwd(),
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();
  logger('Bridge updated. Restarting with the latest version…');
  return { updated: true, restarting: true, message: 'Bridge updated and restarting.' };
}
