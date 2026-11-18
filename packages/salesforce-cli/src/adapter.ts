import type { CliStatus, OrgSummary } from '@dcat/core';
import { CliError } from './errors.ts';
import { parseCliVersion, parseOrgDisplay, parseOrgList } from './parse.ts';
import { redactSensitive, safeErrorMessage } from './redact.ts';
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
        return { installed: true, version: null, error: result.stderr.slice(0, 300) || 'CLI version check failed.' };
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
    // A hidden child window stops the CLI's `open` call from raising the login
    // browser on Windows, so this is the one command that keeps its console.
    await this.run(args, { timeoutMs: LOGIN_TIMEOUT_MS, windowsHide: false });
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
      options ?? { timeoutMs: REST_TIMEOUT_MS },
    );
    return result.stdout;
  }

  private async run(args: readonly string[], options?: RunOptions) {
    const result = await this.runner.run(args, options);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || 'Unknown CLI error.';
      throw new CliError('COMMAND_FAILED', redactSensitive(`Salesforce CLI command failed: ${detail}`).slice(0, 500));
    }
    return result;
  }
}
