import { describe, expect, it, vi } from 'vitest';
import { cliVersionOutput, orgListJson } from '@dcat/test-fixtures';
import { SalesforceCliAdapter, validateAlias, validateRestPath } from './adapter.ts';
import { CliError } from './errors.ts';
import { stripCliNotices } from './redact.ts';
import type { ProcessRunner, RunOptions } from './run.ts';

function fakeRunner(overrides: Partial<ProcessRunner> = {}): ProcessRunner {
  return {
    run: vi.fn(async (args: readonly string[], _options?: RunOptions) => ({
      stdout: args[0] === '--version' ? cliVersionOutput : orgListJson,
      stderr: '',
      exitCode: 0,
    })),
    ...overrides,
  };
}

const cliNotices = [
  '»   Warning: @salesforce/cli update available from 2.116.6 to 2.158.7.',
  "Warning: This command is currently in beta. Any aspect of this command can change without advanced notice. Don't use beta commands in your scripts.",
].join('\n');

describe('SalesforceCliAdapter', () => {
  it('uses only fixed, allowlisted arguments', async () => {
    const runner = fakeRunner();
    const adapter = new SalesforceCliAdapter(runner);
    expect(await adapter.status()).toMatchObject({ installed: true, version: '2.116.6' });
    expect(await adapter.listOrgs()).toHaveLength(1);
    expect(runner.run).toHaveBeenNthCalledWith(1, ['--version'], { timeoutMs: 15_000 });
    expect(runner.run).toHaveBeenNthCalledWith(2, ['org', 'list', '--json'], { timeoutMs: 90_000 });
  });

  it('passes REST URLs positionally and never uses --url or --json', async () => {
    const runner = fakeRunner();
    const adapter = new SalesforceCliAdapter(runner);
    await adapter.restGet('demo-uat', 'services/data/v65.0/ssot/data-spaces');
    expect(runner.run).toHaveBeenCalledWith(
      [
        'api',
        'request',
        'rest',
        '/services/data/v65.0/ssot/data-spaces',
        '--method',
        'GET',
        '--target-org',
        'demo-uat',
      ],
      { timeoutMs: 90_000 },
    );
    const args = vi.mocked(runner.run).mock.calls[0]?.[0].join(' ') ?? '';
    expect(args).not.toContain('--url');
    expect(args).not.toContain('--json');
  });

  it('rejects unsafe aliases and REST paths before spawning', async () => {
    const adapter = new SalesforceCliAdapter(fakeRunner());
    await expect(adapter.listOrgs()).resolves.toHaveLength(1);
    expect(() => validateAlias('alias; rm -rf /')).toThrow(CliError);
    expect(() => validateRestPath('https://evil.example/')).toThrow(CliError);
    expect(() => validateRestPath('services/data/v65.0/../sobjects')).toThrow(CliError);
  });

  it('accepts unescaped continuation-token characters from encodeURIComponent', async () => {
    const runner = fakeRunner();
    const adapter = new SalesforceCliAdapter(runner);
    const path = "services/data/v65.0/ssot/data-lake-objects?nextToken=abc!def'ghi*jkl(mno)";
    await expect(adapter.restGet('demo-uat', path)).resolves.toBeTruthy();
    expect(runner.run).toHaveBeenCalledWith(
      ['api', 'request', 'rest', `/${path}`, '--method', 'GET', '--target-org', 'demo-uat'],
      { timeoutMs: 90_000 },
    );
  });

  it('resolves login as soon as a new authorization appears, without waiting for the CLI process', async () => {
    type RunResult = { stdout: string; stderr: string; exitCode: number };
    let finishLogin!: (result: RunResult) => void;
    const loginPending = new Promise<RunResult>((resolve) => {
      finishLogin = resolve;
    });
    let listCalls = 0;
    const changedOrgList = JSON.parse(orgListJson) as { result: { nonScratchOrgs: Array<{ username: string }> } };
    changedOrgList.result.nonScratchOrgs[0]!.username = 'new-user@example.invalid';

    const runner: ProcessRunner = {
      run: vi.fn(async (args: readonly string[]): Promise<RunResult> => {
        if (args[0] === 'org' && args[1] === 'list') {
          listCalls += 1;
          return { stdout: listCalls === 1 ? orgListJson : JSON.stringify(changedOrgList), stderr: '', exitCode: 0 };
        }
        if (args[0] === 'org' && args[1] === 'login') return loginPending;
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };
    const adapter = new SalesforceCliAdapter(runner);

    await expect(adapter.loginOrg('demo-uat', undefined, 'chrome')).resolves.toEqual({
      alias: 'demo-uat',
      connected: true,
    });
    expect(runner.run).toHaveBeenCalledWith(
      ['org', 'list', '--skip-connection-status', '--json'],
      { timeoutMs: 15_000 },
    );
    expect(runner.run).toHaveBeenCalledWith(
      ['org', 'login', 'web', '--alias', 'demo-uat', '--set-default', '--browser', 'chrome'],
      expect.objectContaining({ timeoutMs: 5 * 60_000, windowsHide: false }),
    );

    // The login command is still pending; the completion signal came from org detection.
    finishLogin({ stdout: '', stderr: '', exitCode: 0 });
    await loginPending;
  });

  it('propagates a failed login instead of waiting for the detection timeout', async () => {
    const runner: ProcessRunner = {
      run: vi.fn(async (args: readonly string[]) => {
        if (args[0] === 'org' && args[1] === 'list') return { stdout: orgListJson, stderr: '', exitCode: 0 };
        if (args[0] === 'org' && args[1] === 'login') {
          return { stdout: '', stderr: 'ERROR: login was cancelled', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };
    const adapter = new SalesforceCliAdapter(runner);

    await expect(adapter.loginOrg('demo-uat')).rejects.toThrow(/login was cancelled/);
  });

  it('ignores update and beta notices on a successful REST command', async () => {
    const runner = fakeRunner({
      run: vi.fn(async () => ({ stdout: orgListJson, stderr: cliNotices, exitCode: 0 })),
    });
    const adapter = new SalesforceCliAdapter(runner);

    await expect(adapter.restGet('demo-uat', 'services/data/')).resolves.toBe(orgListJson);
  });

  it('reports the Salesforce API error body instead of advisory CLI notices', async () => {
    const stdout = JSON.stringify([{
      message: 'This feature is not currently enabled for this user type or org: [CdpDataSpace]',
      errorCode: 'FUNCTIONALITY_NOT_ENABLED',
    }]);
    const runner = fakeRunner({
      run: vi.fn(async () => ({ stdout, stderr: cliNotices, exitCode: 1 })),
    });
    const adapter = new SalesforceCliAdapter(runner);

    await expect(adapter.restGet('demo-uat', 'services/data/v65.0/ssot/data-spaces'))
      .rejects.toThrow(/FUNCTIONALITY_NOT_ENABLED: This feature is not currently enabled/);
  });

  it('keeps real CLI errors when stripping advisory notices', async () => {
    expect(stripCliNotices(`${cliNotices}\nERROR running api request: authentication expired`))
      .toBe('ERROR running api request: authentication expired');
  });

  it('surfaces an unfiltered mapping INVALID_INPUT body verbatim', async () => {
    const stdout = JSON.stringify([{
      errorCode: 'INVALID_INPUT',
      message: 'DMO or Source Object (CRM) developer Name is missing',
    }]);
    const runner = fakeRunner({
      run: vi.fn(async () => ({ stdout, stderr: cliNotices, exitCode: 1 })),
    });
    const adapter = new SalesforceCliAdapter(runner);

    await expect(adapter.restGet('demo-uat', 'services/data/v65.0/ssot/data-model-object-mappings'))
      .rejects.toThrow(/^Salesforce CLI command failed: INVALID_INPUT: DMO or Source Object \(CRM\) developer Name is missing$/);
  });
});
