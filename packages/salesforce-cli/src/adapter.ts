import type { CliStatus, OrgSummary } from '@dcat/core';
import { CliError } from './errors.ts';
import { parseCliVersion, parseOrgDisplay, parseOrgList } from './parse.ts';
import { redactSensitive, safeErrorMessage, stripCliNotices } from './redact.ts';
import { NodeProcessRunner } from './run.ts';
import type { ProcessRunner, RunOptions } from './run.ts';

const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
// `encodeURIComponent` deliberately leaves !'()* unescaped in continuation
// tokens. They are safe here because the CLI is spawned with shell: false.
const REST_PATH_PATTERN = /^\/?services\/data\/[A-Za-z0-9._~/?=&%:!*'()-]{0,480}$/;

// Salesforce CLI org commands can perform a network status check before
// returning JSON; slow orgs have been observed taking tens of seconds.
const ORG_COMMAND_TIMEOUT_MS = 90_000;
const REST_TIMEOUT_MS = 90_000;
// `sf org login web` waits for a browser round trip, so it needs a longer budget.
const LOGIN_TIMEOUT_MS = 5 * 60_000;
// Local-only org listing skips the network status probe and returns quickly.
const LOCAL_ORG_TIMEOUT_MS = 15_000;
const ORG_DETECT_INTERVAL_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * `sf api request rest` writes the Salesforce API body to stdout even on a
 * non-zero exit. Prefer that structured error over advisory CLI stderr.
 */
function extractApiErrorDetail(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const details = entries.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const code = typeof entry.errorCode === 'string' ? entry.errorCode.trim() : '';
      const message = typeof entry.message === 'string' ? entry.message.trim() : '';
      if (!code && !message) return [];
      return [code && message ? `${code}: ${message}` : code || message];
    });
    return details.length > 0 ? details.join('; ') : null;
  } catch {
    return null;
  }
}

export function validateAlias(alias: string): string {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new CliError('INVALID_ARGUMENT', 'The org alias contains unsupported characters.');
  }
  return alias;
}

/** Allow only base HTTPS Salesforce domains; no arbitrary login endpoints. */
export function validateInstanceUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    const valid =
      url.protocol === 'https:' &&
      /^[A-Za-z0-9.-]+\.salesforce\.com$/.test(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash;
    if (!valid) throw new Error('Invalid instance URL.');
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new CliError('INVALID_ARGUMENT', 'Use only a base https://<domain>.salesforce.com URL.');
  }
}

/** Only allow versioned Salesforce REST data paths; no arbitrary URLs or shell fragments. */
export function validateRestPath(path: string): string {
  if (!REST_PATH_PATTERN.test(path) || path.includes('..')) {
    throw new CliError('INVALID_ARGUMENT', 'The REST path is not an allowed services/data path.');
  }
  return path.startsWith('/') ? path : `/${path}`;
}

export class SalesforceCliAdapter {
  constructor(private readonly runner: ProcessRunner = new NodeProcessRunner()) {}

  async status(): Promise<CliStatus> {
    try {
      const result = await this.runner.run(['--version'], { timeoutMs: 15_000 });
      if (result.exitCode !== 0) {
        return {
          installed: true,
          version: null,
          error: stripCliNotices(result.stderr).slice(0, 300) || 'CLI version check failed.',
        };
      }
      return { installed: true, version: parseCliVersion(result.stdout), error: null };
    } catch (error) {
      if (error instanceof CliError && error.code === 'CLI_NOT_FOUND') {
        return { installed: false, version: null, error: null };
      }
      return { installed: false, version: null, error: safeErrorMessage(error) };
    }
  }

  async listOrgs(): Promise<OrgSummary[]> {
    const result = await this.run(['org', 'list', '--json'], { timeoutMs: ORG_COMMAND_TIMEOUT_MS });
    return parseOrgList(result.stdout);
  }

  /** Fast local-only listing; no network status check, so it can poll during login. */
  async listOrgsLocal(): Promise<OrgSummary[]> {
    const result = await this.run(['org', 'list', '--skip-connection-status', '--json'], {
      timeoutMs: LOCAL_ORG_TIMEOUT_MS,
    });
    return parseOrgList(result.stdout);
  }

  /**
   * Watch for the CLI to write a new/changed authorization for `alias`. The web
   * login command can stay alive long after the browser auth succeeds, so this
   * gives callers a prompt, credential-free completion signal.
   */
  async waitForOrgConnected(
    alias: string,
    baseline: readonly OrgSummary[],
    options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<OrgSummary> {
    const safeAlias = validateAlias(alias);
    const previous = baseline.find((org) => org.alias === safeAlias);
    const deadline = Date.now() + (options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    const interval = options.intervalMs ?? ORG_DETECT_INTERVAL_MS;
    const signal = options.signal;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new CliError('COMMAND_FAILED', 'Login detection stopped.');
      let found: OrgSummary | undefined;
      try {
        found = (await this.listOrgsLocal()).find((org) => org.alias === safeAlias);
      } catch {
        // A concurrent login can briefly make `org list` fail. Keep polling.
      }
      if (found && (!previous || found.username !== previous.username || found.orgId !== previous.orgId)) {
        return found;
      }
      if (signal?.aborted) throw new CliError('COMMAND_FAILED', 'Login detection stopped.');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, interval);
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    throw new CliError('TIMEOUT', 'The org did not appear in the Salesforce CLI after login. Check the login window.');
  }

  async displayOrg(alias: string): Promise<OrgSummary> {
    const safeAlias = validateAlias(alias);
    const result = await this.run(['org', 'display', '--target-org', safeAlias, '--json'], {
      timeoutMs: ORG_COMMAND_TIMEOUT_MS,
    });
    return parseOrgDisplay(result.stdout);
  }

  /** Run the fixed web-login flow locally. No credentials enter this process. */
  async loginOrg(
    alias: string,
    instanceUrl?: string,
    browser?: 'chrome' | 'edge' | 'firefox',
  ): Promise<{ alias: string; connected: true }> {
    const safeAlias = validateAlias(alias);
    const safeInstanceUrl = validateInstanceUrl(instanceUrl);
    const args = ['org', 'login', 'web', '--alias', safeAlias, '--set-default'];
    if (safeInstanceUrl) args.push('--instance-url', safeInstanceUrl);
    if (browser) args.push('--browser', browser);
    const baseline = await this.listOrgsLocal().catch(() => []);

    // A hidden child window stops the CLI's `open` call from raising the login
    // browser on Windows, so this is the one command that keeps its console.
    const login = this.run(args, { timeoutMs: LOGIN_TIMEOUT_MS, windowsHide: false });
    const controller = new AbortController();
    const detected = this.waitForOrgConnected(safeAlias, baseline, {
      timeoutMs: LOGIN_TIMEOUT_MS,
      signal: controller.signal,
    });
    // The losing side must not become an unhandled rejection.
    void login.catch(() => undefined);
    void detected.catch(() => undefined);
    try {
      await Promise.race([login, detected]);
    } finally {
      controller.abort();
    }
    return { alias: safeAlias, connected: true };
  }

  /**
   * GET-only REST access through the CLI's own authenticated session.
   * Note: this CLI version uses a positional URL and returns the raw body;
   * `--url` and `--json` are not valid flags here.
   */
  async restGet(alias: string, path: string, options?: RunOptions): Promise<string> {
    const safeAlias = validateAlias(alias);
    const safePath = validateRestPath(path);
    const result = await this.run(
      ['api', 'request', 'rest', safePath, '--method', 'GET', '--target-org', safeAlias],
      { timeoutMs: REST_TIMEOUT_MS, ...options },
    );
    return result.stdout;
  }

  private async run(args: readonly string[], options?: RunOptions) {
    const result = await this.runner.run(args, options);
    if (result.exitCode !== 0) {
      const stderr = stripCliNotices(result.stderr);
      const stdout = stripCliNotices(result.stdout);
      const detail = extractApiErrorDetail(result.stdout) || stderr || stdout || 'Unknown CLI error.';
      throw new CliError('COMMAND_FAILED', redactSensitive(`Salesforce CLI command failed: ${detail}`).slice(0, 500));
    }
    return result;
  }
}
