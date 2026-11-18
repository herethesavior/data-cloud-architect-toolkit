import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { CliError } from './errors.ts';
import { redactSensitive } from './redact.ts';

interface ResolvedCliCommand {
  command: string;
  prefixArgs: readonly string[];
}

/**
 * Windows installs `sf` as a .cmd shim, which Node cannot spawn with shell:false.
 * Read that shim and run its Node entry point directly so the no-shell guarantee
 * is preserved. No credential files are read.
 */
export function resolveSfShim(shimPath: string, depth = 0): ResolvedCliCommand | null {
  if (depth > 3 || !existsSync(shimPath)) return null;
  const contents = readFileSync(shimPath, 'utf8');

  const delegated = /if exist "([^"]+)"\s*\(/i.exec(contents)?.[1];
  if (delegated) {
    const resolved = resolveSfShim(delegated, depth + 1);
    if (resolved) return resolved;
  }

  const match = /"([^"]+node\.exe)"\s+--no-deprecation\s+"([^"]+run[^"]*)"/i.exec(contents);
  const expand = (value: string): string => resolve(value.replace(/%~dp0/g, `${dirname(shimPath)}${sep}`));
  const nodeExe = match?.[1] ? expand(match[1]) : null;
  const rawRun = match?.[2] ? expand(match[2]) : null;
  if (!nodeExe || !rawRun || !existsSync(nodeExe)) return null;

  const runScript = [rawRun, `${rawRun}.js`].find((candidate) => existsSync(candidate));
  if (!runScript) return null;

  return { command: nodeExe, prefixArgs: ['--no-deprecation', runScript] };
}

let windowsResolution: ResolvedCliCommand | null | undefined;

async function resolveCliCommand(command: string): Promise<ResolvedCliCommand> {
  if (process.platform !== 'win32' || command !== 'sf') {
    return { command, prefixArgs: [] };
  }

  // Retry a failed lookup: the CLI may be installed after the first attempt.
  if (windowsResolution === undefined || windowsResolution === null) {
    const where = spawnSync('where.exe', ['sf'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    const found = (where.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const shim = found.find((path) => path.toLowerCase().endsWith('.cmd')) ?? found[0];
    windowsResolution = shim ? resolveSfShim(shim) : null;
  }

  return windowsResolution ?? { command, prefixArgs: [] };
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface RunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Keep hidden by default; login uses false so the CLI can open a browser on Windows. */
  windowsHide?: boolean;
}

export interface ProcessRunner {
  run(args: readonly string[], options?: RunOptions): Promise<ProcessRunResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;

/**
 * Runs a fixed Salesforce CLI argument list without a shell. Raw output is
 * redacted here so no caller can accidentally expose a token-bearing string.
 */
export class NodeProcessRunner implements ProcessRunner {
  constructor(
    private readonly command = 'sf',
    private readonly spawnFn: typeof spawn = spawn,
    private readonly resolver: (command: string) => Promise<ResolvedCliCommand> = resolveCliCommand,
  ) {}

  async run(args: readonly string[], options: RunOptions = {}): Promise<ProcessRunResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const windowsHide = options.windowsHide ?? true;
    const resolved = await this.resolver(this.command);

    return new Promise<ProcessRunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn(resolved.command, [...resolved.prefixArgs, ...args], {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide,
          env: {
            ...process.env,
            SF_DISABLE_AUTOUPDATE: '1',
            SF_SKIP_NEW_VERSION_CHECK: '1',
            SF_DISABLE_TELEMETRY: 'true',
          },
        });
      } catch (error) {
        reject(new CliError('CLI_NOT_FOUND', 'Could not start the Salesforce CLI.', { cause: error }));
        return;
      }

      let stdout = '';
      let stderr = '';
      let totalBytes = 0;
      let timedOut = false;
      let limitExceeded = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        complete();
      };

      const collect = (stream: Readable | null, kind: 'stdout' | 'stderr'): void => {
        stream?.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > maxOutputBytes) {
            limitExceeded = true;
            child.kill();
            return;
          }
          if (kind === 'stdout') stdout += chunk.toString('utf8');
          else stderr += chunk.toString('utf8');
        });
      };

      collect(child.stdout, 'stdout');
      collect(child.stderr, 'stderr');

      child.on('error', (error: NodeJS.ErrnoException) => {
        finish(() =>
          reject(
            new CliError(
              error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'COMMAND_FAILED',
              'Could not run the Salesforce CLI.',
              { cause: error },
            ),
          ),
        );
      });

      child.on('close', (exitCode) => {
        finish(() => {
          if (timedOut) {
            reject(new CliError('TIMEOUT', `Salesforce CLI command timed out after ${timeoutMs} ms.`));
          } else if (limitExceeded) {
            reject(new CliError('OUTPUT_LIMIT', 'Salesforce CLI output exceeded the safe size limit.'));
          } else {
            resolve({
              stdout: redactSensitive(stdout),
              stderr: redactSensitive(stderr),
              exitCode,
            });
          }
        });
      });
    });
  }
}
