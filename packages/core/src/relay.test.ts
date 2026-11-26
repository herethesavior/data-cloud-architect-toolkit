import { describe, expect, it } from 'vitest';
import { relayOperationSchema } from './relay.ts';

describe('relayOperationSchema', () => {
  it('accepts a scoped inventory refresh with known families', () => {
    const parsed = relayOperationSchema.parse({
      operation: 'inventory.start',
      alias: 'prod-org',
      refresh: true,
      families: ['dlos', 'mappings', 'data-streams'],
    });

    expect(parsed).toMatchObject({ operation: 'inventory.start', refresh: true });
  });

  it('rejects an empty or unknown refresh family list', () => {
    expect(() => relayOperationSchema.parse({
      operation: 'inventory.start',
      alias: 'prod-org',
      families: [],
    })).toThrow();
    expect(() => relayOperationSchema.parse({
      operation: 'inventory.start',
      alias: 'prod-org',
      families: ['not-a-family'],
    })).toThrow();
  });
});
