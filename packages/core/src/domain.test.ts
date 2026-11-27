import { describe, expect, it } from 'vitest';
import { familyProgressSchema } from './domain.ts';

const family = {
  family: 'dmos',
  status: 'running',
  loaded: 10,
  total: null,
  pagesFetched: 1,
  hasMore: true,
};

describe('familyProgressSchema', () => {
  it('accepts cached progress written before lookup activity existed', () => {
    expect(familyProgressSchema.safeParse(family).success).toBe(true);
  });

  it('accepts an active lookup phase without a known denominator', () => {
    const result = familyProgressSchema.safeParse({
      ...family,
      activity: {
        phase: 'relationship-lookups',
        completed: 4,
        pending: 6,
        failed: 0,
        total: null,
        startedAt: '2026-11-27T15:00:00.000Z',
      },
    });
    expect(result.success).toBe(true);
  });
});
