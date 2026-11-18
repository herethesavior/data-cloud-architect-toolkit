import { describe, expect, it, vi } from 'vitest';
import { cliVersionOutput, orgListJson } from '@dcat/test-fixtures';
import { SalesforceCliAdapter, validateAlias, validateRestPath } from './adapter.ts';
import { CliError } from './errors.ts';
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
});
