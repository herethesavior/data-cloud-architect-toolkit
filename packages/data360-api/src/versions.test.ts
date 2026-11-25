import { describe, expect, it, vi } from 'vitest';
import { CliError } from '@dcat/salesforce-cli';
import { forbiddenRestOutput, versionsJson } from '@dcat/test-fixtures';
import { describeApiVersionResult, resolveApiVersion, selectApiVersions } from './versions.ts';

describe('API version resolution', () => {
  it('normalizes and sorts the versions an org reports', () => {
    expect(selectApiVersions(versionsJson)).toEqual(['65.0', '64.0']);
    expect(selectApiVersions(JSON.stringify([
      { version: 68 },
      { version: '67.0' },
      { version: '68.0' },
      { version: 'not-a-version' },
    ]))).toEqual(['68.0', '67.0']);
  });

  it('follows the highest org version in latest mode', async () => {
    const onResolved = vi.fn();
    const result = await resolveApiVersion(async () => versionsJson, { mode: 'latest' }, onResolved);

    expect(result.apiVersion).toBe('65.0');
    expect(result.probe).toMatchObject({ status: 'available', latest: '65.0', failed: false });
    expect(onResolved).toHaveBeenCalledWith(result);
  });

  it('uses the recommended pin even when the org reports a newer version', async () => {
    const result = await resolveApiVersion(async () => versionsJson);

    expect(result.apiVersion).toBe('67.0');
    expect(result.selection).toEqual({ mode: 'recommended' });
    expect(result.probe.latest).toBe('65.0');
  });

  it('keeps a pinned version when only the diagnostic probe fails', async () => {
    const result = await resolveApiVersion(
      async () => { throw new CliError('COMMAND_FAILED', forbiddenRestOutput); },
      { mode: 'specific', version: '68.0' },
    );

    expect(result.apiVersion).toBe('68.0');
    expect(result.probe).toMatchObject({ status: 'forbidden', failed: true, latest: null });
  });

  it('stays fail-closed in latest mode when the probe fails', async () => {
    const result = await resolveApiVersion(
      async () => { throw new CliError('COMMAND_FAILED', forbiddenRestOutput); },
      { mode: 'latest' },
    );

    expect(result.apiVersion).toBeNull();
    expect(result.probe.failed).toBe(true);
  });

  it('keeps raw CLI output out of user-facing version copy', async () => {
    const result = await resolveApiVersion(
      async () => { throw new CliError('COMMAND_FAILED', forbiddenRestOutput); },
      { mode: 'latest' },
    );

    expect(result.probe.message).not.toContain('ERROR running api request');
    expect(describeApiVersionResult(result).message).not.toContain('ERROR running api request');
  });
});
