import { describe, expect, it } from 'vitest';
import { isValidTransformId } from './transform-id.ts';

describe('isValidTransformId', () => {
  it.each([
    'Account_Transform',
    'ns__Transform__dtm',
    '0TfDEMO000000001AAA',
    'Transform-01.v2~beta',
    'a'.repeat(128),
  ])('accepts %s', (id) => {
    expect(isValidTransformId(id)).toBe(true);
  });

  it.each(['', 'a'.repeat(129), '.hidden', 'id/../secret', 'id?x=1', 'id with spaces', 42, null])(
    'rejects %s',
    (id) => {
      expect(isValidTransformId(id)).toBe(false);
    },
  );
});
