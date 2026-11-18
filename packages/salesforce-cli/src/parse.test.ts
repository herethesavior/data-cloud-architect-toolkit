import { describe, expect, it } from 'vitest';
import {
  cliVersionOutput,
  orgDisplayJson,
  orgListAlternateJson,
  orgListEnvironmentJson,
  orgListJson,
  orgListUnexpectedJson,
} from '@dcat/test-fixtures';
import { CliError } from './errors.ts';
import { parseCliVersion, parseOrgDisplay, parseOrgList } from './parse.ts';

describe('parseOrgList', () => {
  it('parses the installed CLI shape and returns only safe identity fields', () => {
    const orgs = parseOrgList(orgListJson);
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({
      alias: 'demo-uat',
      username: 'architect@demo-uat.example.invalid',
      orgId: '00DDEMO000000000AAA',
      environment: 'sandbox',
      isDefault: true,
      source: 'salesforce-cli',
    });
    expect(JSON.stringify(orgs)).not.toContain('00DDEMOTOKEN');
    expect(JSON.stringify(orgs)).not.toContain('accessToken');
  });

  it('accepts an alternate CLI response shape', () => {
    const orgs = parseOrgList(orgListAlternateJson);
    expect(orgs[0]?.alias).toBe('demo-alt');
    expect(orgs[0]?.environment).toBe('production');
  });

  it('classifies orgs from CLI metadata instead of treating hyphens as sandbox signals', () => {
    const orgs = parseOrgList(orgListEnvironmentJson);
    const byAlias = new Map(orgs.map((org) => [org.alias, org.environment]));

    expect(byAlias.get('dev-ed')).toBe('production');
    expect(byAlias.get('uat')).toBe('sandbox');
    expect(byAlias.get('hub')).toBe('dev-hub');
    expect(byAlias.get('scratch')).toBe('scratch');
    expect([...byAlias.values()]).not.toContain('unknown');
  });

  it('rejects an unrecognized shape instead of inventing data', () => {
    expect(() => parseOrgList(orgListUnexpectedJson)).toThrow(CliError);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseOrgList('not json')).toThrow(/valid JSON/);
  });
});

describe('parseOrgDisplay', () => {
  it('drops token-bearing fields from org display output', () => {
    const org = parseOrgDisplay(orgDisplayJson);
    expect(org.alias).toBe('demo-uat');
    expect(org.orgId).toBe('00DDEMO000000000AAA');
    expect(JSON.stringify(org)).not.toContain('accessToken');
  });
});

describe('parseCliVersion', () => {
  it('reads the version from real CLI output', () => {
    expect(parseCliVersion(cliVersionOutput)).toBe('2.116.6');
  });
});
