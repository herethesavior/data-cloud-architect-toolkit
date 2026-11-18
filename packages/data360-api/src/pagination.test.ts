import { describe, expect, it } from 'vitest';
import { buildNextPath, extractContinuation, extractTotal } from './pagination.ts';

describe('opaque continuation handling', () => {
  it('recognizes documented and nested token shapes without guessing a parameter', () => {
    const cases: Array<[unknown, string, string]> = [
      [{ nextToken: 'abc' }, 'abc', 'nextToken'],
      [{ pagination: { nextPageToken: 'page-2' } }, 'page-2', 'nextPageToken'],
      [{ meta: { cursor: 'cursor-9' } }, 'cursor-9', 'cursor'],
      [{ records: [], pageInfo: { endCursor: 'end-7', hasNextPage: true } }, 'end-7', 'endCursor'],
      [{ paging: { offset: 40, hasMore: true } }, '40', 'offset'],
      [{ next: { cursor: 'next-4', param: 'after' } }, 'next-4', 'after'],
    ];
    for (const [payload, cursor, param] of cases) {
      const continuation = extractContinuation(payload);
      expect(continuation.cursor).toBe(cursor);
      expect(continuation.param).toBe(param);
      expect(continuation.hasMore).toBe(true);
    }
  });

  it('follows URL-style continuations on the allowlisted REST path', () => {
    const continuation = extractContinuation({
      done: false,
      nextRecordsUrl: '/services/data/v65.0/query/01gABC?locator=abc%2B123',
    });
    expect(continuation.nextPath).toBe('services/data/v65.0/query/01gABC?locator=abc%2B123');
    expect(buildNextPath('services/data/v65.0/ssot/data-lake-objects', continuation))
      .toBe('services/data/v65.0/query/01gABC?locator=abc%2B123');
  });

  it('reads totals from common envelopes and stops on explicit completion', () => {
    expect(extractTotal({ result: { totalSize: 200, records: [] } })).toBe(200);
    expect(extractTotal({ meta: { totalCount: '42' } })).toBe(42);
    expect(extractContinuation({ totalSize: 10, done: true, nextToken: 'ignored' }).hasMore).toBe(false);
  });

  it('flags a reported next page that has no usable cursor', () => {
    const continuation = extractContinuation({ meta: { hasNextPage: true } });
    expect(continuation.hasMore).toBe(true);
    expect(continuation.uncertain).toBe(true);
    expect(buildNextPath('services/data/v65.0/ssot/data-lake-objects', continuation))
      .toBe('services/data/v65.0/ssot/data-lake-objects');
  });

  it('replaces an existing cursor parameter instead of appending a duplicate', () => {
    const continuation = extractContinuation({ pagination: { pageToken: 'page-3' } });
    expect(buildNextPath('services/data/v65.0/ssot/data-lake-objects?pageToken=page-2', continuation))
      .toBe('services/data/v65.0/ssot/data-lake-objects?pageToken=page-3');
  });
});
