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

  const expand = (value: string): string => resolve(
    value
      .replace(/%~dp0/g, `${dirname(shimPath)}${sep}`)
      .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (token, name: string) =>
        process.env[name] ?? process.env[name.toUpperCase()] ?? token),
  );

  const delegated = /if exist "([^"]+)"\s*\(/i.exec(contents)?.[1]
    ?? /^\s*"([^"]+\.cmd)"[^\r\n]*%\*/im.exec(contents)?.[1];
  if (delegated) {
    // Salesforce shims redirect through %LOCALAPPDATA% and %~dp0; following
    // raw tokens would miss the user's updated CLI and find an older copy.
    const resolved = resolveSfShim(expand(delegated), depth + 1);
    if (resolved) return resolved;
  }

  const match = /"([^"]+node\.exe)"\s+--no-deprecation\s+"([^"]+run[^"]*)"/i.exec(contents);
  const nodeExe = match?.[1] ? expand(match[1]) : null;
  const rawRun = match?.[2] ? expand(match[2]) : null;
  if (!nodeExe || !rawRun || !existsSync(nodeExe)) return null;

  const runScript = [rawRun, `${rawRun}.js`].find((candidate) => existsSync(candidate));
  if (!runScript) return null;

  return { command: nodeExe, prefixArgs: ['--no-deprecation', runScript] };
}

let windowsResolution: ResolvedCliCommand | null | undefined;
let windowsResolutionPromise: Promise<ResolvedCliCommand | null> | undefined;

function resolveCliCommand(command: string): Promise<ResolvedCliCommand> {
  if (process.platform !== 'win32' || command !== 'sf') {
    return Promise.resolve({ command, prefixArgs: [] });
  }

  // Share one shim lookup across concurrent discovery calls.
  windowsResolutionPromise ??= (async () => {
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
    return windowsResolution;
  })();

  return windowsResolutionPromise.then((resolved) => {
    // Allow a later call to retry if the CLI was not installed yet.
    if (!resolved) windowsResolutionPromise = undefined;
    return resolved ?? { command, prefixArgs: [] };
  });
}

/**
 * Salesforce CLI commands share auth/config state and a single org token cache.
 * Run discovery reads one at a time so internal `Promise.all` fan-out cannot
 * spawn overlapping `sf` processes.
 */
let commandTail: Promise<unknown> = Promise.resolve();

function enqueueCommand<T>(operation: () => Promise<T>): Promise<T> {
  const result = commandTail.then(operation, operation);
  // A rejected command must not wedge the queue for every later call.
  commandTail = result.then(() => undefined, () => undefined);
  return result;
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
  /** Cancels an in-flight CLI process when a discovery session is stopped. */
  signal?: AbortSignal;
  /** How long to wait for `close` after a kill before unwedging the queue. */
  closeGraceMs?: number;
  /**
   * Serialize with other CLI calls by default. Only the web-login race opts
   * out: its org-list probe must run while the browser login command is open.
   */
  queue?: boolean;
}

export interface ProcessRunner {
  run(args: readonly string[], options?: RunOptions): Promise<ProcessRunResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_GRACE_MS = 1_500;
const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;

function cancelledRunError(): CliError {
  return new CliError('TIMEOUT', 'Salesforce CLI command was cancelled.');
}

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
    if (options.queue === false) return this.runCommand(args, options);

    const signal = options.signal;
    if (signal?.aborted) throw cancelledRunError();

    let rejectAbort: (error: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(cancelledRunError());
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      // Abort rejects immediately, but the queued operation still checks the
      // signal before spawning so a cancelled caller never starts a CLI process.
      const queued = enqueueCommand(async () => {
        if (signal?.aborted) throw cancelledRunError();
        return this.runCommand(args, options);
      });
      return await Promise.race([queued, aborted]);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async runCommand(args: readonly string[], options: RunOptions): Promise<ProcessRunResult> {
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
      let aborted = false;
      let limitExceeded = false;
      let settled = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;

      const errorFor = (kind: 'timeout' | 'abort' | 'limit'): CliError => {
        if (kind === 'abort') return new CliError('TIMEOUT', 'Salesforce CLI command was cancelled.');
        if (kind === 'limit') {
          return new CliError('OUTPUT_LIMIT', 'Salesforce CLI output exceeded the safe size limit.');
        }
        return new CliError('TIMEOUT', `Salesforce CLI command timed out after ${timeoutMs} ms.`);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killAndForceSettle('timeout');
      }, timeoutMs);

      const onAbort = () => {
        aborted = true;
        killAndForceSettle('abort');
      };

      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        options.signal?.removeEventListener('abort', onAbort);
        complete();
      };

      // A killed CLI can leave a grandchild holding stdio open, so `close` may
      // never arrive. Settle after a short grace period or the global command
      // queue would wedge and block every later discovery call.
      function killAndForceSettle(kind: 'timeout' | 'abort' | 'limit'): void {
        child.kill();
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (!forceTimer) {
          forceTimer = setTimeout(
            () => finish(() => reject(errorFor(kind))),
            options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS,
          );
        }
      }

      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });

      const collect = (stream: Readable | null, kind: 'stdout' | 'stderr'): void => {
        stream?.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > maxOutputBytes) {
            limitExceeded = true;
            killAndForceSettle('limit');
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
          if (aborted) {
            reject(new CliError('TIMEOUT', 'Salesforce CLI command was cancelled.'));
          } else if (timedOut) {
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
