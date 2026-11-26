import { describe, expect, it } from 'vitest';
import { ApiError } from './api.ts';
import { describeError, sanitizeDetail } from './userError.ts';

describe('describeError', () => {
  it('never renders raw exception text', () => {
    const described = describeError(
      new TypeError("Cannot read properties of undefined (reading 'idFromString')"),
      'orgs',
    );

    expect(described).toEqual({
      message: "We couldn't check your Salesforce orgs.",
      hint: 'Try again. If it keeps happening, open Org Connections and check the bridge.',
      recovery: 'retry',
    });
  });

  it('points a disconnected bridge to the setup steps', () => {
    expect(describeError(new ApiError('BRIDGE_NOT_CONNECTED', 'raw detail'), 'orgs')).toEqual({
      message: 'The bridge is not connected.',
      hint: 'Open Org Connections and run the bridge setup command shown there.',
      recovery: 'connect',
    });
  });

  it('prefers a specific recovery path when the code is known', () => {
    expect(describeError(new ApiError('BRIDGE_PAIRING_RESET', 'raw reset detail'), 'refresh')).toEqual({
      message: 'The bridge pairing was reset.',
      hint: 'Open Org Connections, create a new pairing code, and run the setup command again.',
      recovery: 'connect',
    });
  });

  it('routes oversized metadata to a real continue action', () => {
    expect(describeError(new ApiError('RESPONSE_TOO_LARGE', 'raw detail'), 'inventory')).toEqual({
      message: 'That metadata is too large to display in one view.',
      hint: 'Continue loading to receive this org in smaller batches.',
      recovery: 'continue',
    });
  });

  it('does not offer inventory batching for an oversized transform detail', () => {
    expect(describeError(new ApiError('RESPONSE_TOO_LARGE', 'raw detail'), 'transform')).toEqual({
      message: 'That transform is too large to display in one view.',
      hint: 'Refresh the inventory, then open the transform again.',
    });
  });

  it('uses the context fallback for unmapped codes', () => {
    expect(describeError(new ApiError('COMMAND_FAILED', 'Production CLI is unavailable.'), 'refresh')).toEqual({
      message: "We couldn't refresh the org list.",
      hint: 'Try again. If it keeps happening, open Org Connections and check the bridge.',
    });
  });

  it('never asks hosted users to switch sites', () => {
    const copy = [
      describeError(new TypeError('unexpected failure'), 'orgs'),
      describeError(new ApiError('BRIDGE_RELAY_UNAVAILABLE', 'raw detail'), 'bridge'),
      describeError(new ApiError('BRIDGE_STATUS_UNAVAILABLE', 'raw detail'), 'bridge'),
    ].flatMap((described) => [described.message, described.hint ?? '']);

    expect(copy.some((text) => /production site/i.test(text))).toBe(false);
  });
});

describe('sanitizeDetail', () => {
  it('keeps an authored explanation', () => {
    expect(sanitizeDetail('Skipped: no DMOs were found.', 'Fallback.')).toBe('Skipped: no DMOs were found.');
  });

  it('replaces technical payloads with the caller fallback', () => {
    expect(sanitizeDetail('Salesforce CLI command failed: sf org list --json', 'Fallback.')).toBe('Fallback.');
    expect(sanitizeDetail('Cannot read properties of undefined (reading idFromString)', 'Fallback.')).toBe('Fallback.');
    expect(sanitizeDetail('{"code":"ERROR"}', 'Fallback.')).toBe('Fallback.');
    expect(sanitizeDetail(null, 'Fallback.')).toBe('Fallback.');
    expect(sanitizeDetail('   ', 'Fallback.')).toBe('Fallback.');
  });

  it('caps long detail so the UI cannot be flooded', () => {
    const detail = 'A'.repeat(500);
    expect(sanitizeDetail(detail, 'Fallback.')).toHaveLength(300);
  });
});
