import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, posix, resolve, win32 } from 'node:path';
import type { CliStatus } from '@dcat/core';
import { CliError, parseCliVersion, redactSensitive, resolveSfShim, safeErrorMessage } from '@dcat/salesforce-cli';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<CommandResult>;
}

interface ResolvedCommand {
  command: string;
  args: string[];
}

/** Windows installs `sf` as a .cmd shim; run its Node entry point with shell: false. */
export function resolveInstalledCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ResolvedCommand {
  if (process.platform !== 'win32' || command !== 'sf') {
    return { command, args: [...args] };
  }

  const where = spawnSync('where.exe', ['sf'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    env,
  });
  const found = (where.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const shim = found.find((path) => path.toLowerCase().endsWith('.cmd')) ?? found[0];
  const resolved = shim ? resolveSfShim(shim) : null;
  return resolved
    ? { command: resolved.command, args: [...resolved.prefixArgs, ...args] }
    : { command, args: [...args] };
}

/** Spawn fixed argument arrays without a shell; raw output is redacted before it is returned. */
export const nodeCommandRunner: CommandRunner = {
  run(command, args, env) {
    return new Promise<CommandResult>((resolveResult, rejectResult) => {
      const resolved = resolveInstalledCommand(command, args, env);
      let child: ChildProcess;
      try {
        child = spawn(resolved.command, resolved.args, {
          env,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        rejectResult(new CliError('CLI_NOT_FOUND', 'Could not start the installer command.', { cause: error }));
        return;
      }

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', (error) => {
        rejectResult(new CliError('CLI_NOT_FOUND', 'Could not run the installer command.', { cause: error }));
      });
      child.on('close', (exitCode) => {
        resolveResult({
          stdout: redactSensitive(stdout),
          stderr: redactSensitive(stderr),
          exitCode: exitCode ?? 1,
        });
      });
    });
  },
};

export interface NpmInvocation {
  command: string;
  args: string[];
}

function bundledNpmCli(): string | null {
  const nodeDir = dirname(process.execPath);
  return [
    resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((candidate) => existsSync(candidate)) ?? null;
}

/** Prefer the npm that launched npx, then npm bundled with Node, before a PATH lookup. */
export function npmInvocation(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NpmInvocation {
  const execPath = env.npm_execpath ?? bundledNpmCli();
  if (execPath) return { command: process.execPath, args: [execPath] };
  return { command: platform === 'win32' ? 'npm.cmd' : 'npm', args: [] };
}

export function prependGlobalBinToPath(
  env: NodeJS.ProcessEnv,
  prefix: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const trimmed = prefix.trim();
  if (!trimmed) return;
  const candidates = platform === 'win32'
    ? [trimmed, win32.join(trimmed, 'node_modules', '.bin')]
    : [posix.join(trimmed, 'bin'), trimmed];
  const current = env.PATH ?? env.Path ?? '';
  const next = [...candidates, current].filter(Boolean).join(platform === 'win32' ? win32.delimiter : posix.delimiter);
  env.PATH = next;
  if (platform === 'win32') env.Path = next;
}

export interface EnsureCliOptions {
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  logger?: (message: string) => void;
  platform?: NodeJS.Platform;
  skipInstall?: boolean;
}

/** Install Salesforce CLI when missing, then make `sf` available to the bridge process. */
export async function ensureSalesforceCli(options: EnsureCliOptions = {}): Promise<CliStatus> {
  const env = options.env ?? process.env;
  const runner = options.runner ?? nodeCommandRunner;
  const logger = options.logger ?? (() => {});
  const platform = options.platform ?? process.platform;
  const skipInstall = options.skipInstall ?? env.DCAT_SKIP_CLI_INSTALL === '1';

  const check = async (): Promise<string> => {
    const result = await runner.run('sf', ['--version'], env);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'Salesforce CLI check failed.');
    }
    return parseCliVersion(result.stdout) ?? 'unknown';
  };

  try {
    const version = await check();
    return { installed: true, version, error: null };
  } catch (error) {
    if (skipInstall) {
      throw new CliError('CLI_NOT_FOUND', `Salesforce CLI is required: ${safeErrorMessage(error)}`);
    }
  }

  logger('Salesforce CLI was not detected. Installing @salesforce/cli globally…');
  const npm = npmInvocation(env, platform);
  const install = await runner.run(npm.command, [...npm.args, 'install', '-g', '@salesforce/cli'], env);
  if (install.exitCode !== 0) {
    const detail = safeErrorMessage(new Error(install.stderr.trim() || install.stdout.trim() || 'npm install failed.'));
    throw new CliError('COMMAND_FAILED', `Could not install Salesforce CLI: ${detail}`);
  }

  const prefix = await runner.run(npm.command, [...npm.args, 'config', 'get', 'prefix'], env);
  if (prefix.exitCode === 0) prependGlobalBinToPath(env, prefix.stdout, platform);

  try {
    const version = await check();
    logger(`Salesforce CLI ${version} is ready.`);
    return { installed: true, version, error: null };
  } catch (error) {
    throw new CliError('COMMAND_FAILED', `Salesforce CLI was installed but is not on PATH: ${safeErrorMessage(error)}`);
  }
}
