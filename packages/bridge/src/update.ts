import { spawn } from 'node:child_process';
import { CliError, safeErrorMessage } from '@dcat/salesforce-cli';
import { createNodeCommandRunner, npmInvocation, type CommandRunner } from './install.ts';

const BRIDGE_PACKAGE = '@dcat-toolkit/bridge';
/** npm dist-tags resolve to an exact release; only that release may be installed and launched. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface PreparedBridgeUpdate {
  version: string;
  /** Resolves only when the replacement has actually spawned. */
  complete: () => Promise<void>;
}

interface DetachedChild {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
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
  /** Log-level flags from the current process, so the replacement keeps the same verbosity. */
  logArgs?: readonly string[];
  spawnDetached?: SpawnDetached;
}

const defaultSpawnDetached: SpawnDetached = (command, args, options) => spawn(command, args, options);

async function resolvedLatestVersion(runner: CommandRunner, npm: { command: string; args: string[] }, env: NodeJS.ProcessEnv): Promise<string> {
  const lookup = await runner.run(npm.command, [...npm.args, 'view', BRIDGE_PACKAGE, 'version', '--json'], env);
  if (lookup.exitCode !== 0) {
    const detail = safeErrorMessage(new Error(lookup.stderr || lookup.stdout || 'Could not read the latest bridge version.'));
    throw new CliError('COMMAND_FAILED', detail);
  }
  let version: unknown;
  try {
    version = JSON.parse(lookup.stdout.trim());
  } catch {
    throw new CliError('UNEXPECTED_RESPONSE', 'npm did not return a readable bridge version.');
  }
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new CliError('UNEXPECTED_RESPONSE', 'npm returned an invalid bridge version.');
  }
  return version;
}

/**
 * Install one resolved release and return the handoff. The caller starts the
 * replacement only after the relay has accepted the result, so a failed POST
 * cannot leave two agents on one token or a stopped bridge with no successor.
 */
export async function prepareBridgeUpdate(options: UpdateOptions = {}): Promise<PreparedBridgeUpdate> {
  const env = options.env ?? process.env;
  const runner = options.runner ?? createNodeCommandRunner(options.timeoutMs ?? 5 * 60_000);
  const logger = options.logger ?? (() => {});
  const spawnDetached = options.spawnDetached ?? defaultSpawnDetached;
  const npm = npmInvocation(env);
  const version = await resolvedLatestVersion(runner, npm, env);

  const install = await runner.run(
    npm.command,
    [...npm.args, 'install', '-g', `${BRIDGE_PACKAGE}@${version}`],
    env,
  );
  if (install.exitCode !== 0) {
    const detail = safeErrorMessage(new Error(
      install.stderr || install.stdout || 'Could not install the latest bridge.',
    ));
    throw new CliError('COMMAND_FAILED', detail);
  }

  return {
    version,
    complete: () => new Promise<void>((resolve, reject) => {
      let child: DetachedChild;
      try {
        child = spawnDetached(
          npm.command,
          [...npm.args, 'exec', '--yes', `--package=${BRIDGE_PACKAGE}@${version}`, '--', 'dcat-bridge', 'start', ...(options.logArgs ?? [])],
          {
            cwd: process.cwd(),
            env,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          },
        );
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        child.unref();
        logger(`Bridge update ${version} installed. Starting the replacement bridge.`);
        resolve();
      });
    }),
  };
}
