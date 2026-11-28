import { describe, expect, it } from 'vitest';
import { buildNextPath, extractContinuation, extractTotal, offsetContinuation } from './pagination.ts';

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

  it('ignores URL-style continuations that leave the current REST endpoint', () => {
    const continuation = extractContinuation({
      done: false,
      nextRecordsUrl: '/services/data/v65.0/query/01gABC?locator=abc%2B123',
    });
    expect(continuation.nextPath).toBe('services/data/v65.0/query/01gABC?locator=abc%2B123');
    expect(buildNextPath('services/data/v65.0/ssot/data-lake-objects', continuation))
      .toBe('services/data/v65.0/ssot/data-lake-objects');
  });

  it('ignores continuations that switch API version or resource family', () => {
    const continuation = extractContinuation({
      nextPageUrl: '/services/data/v68.0/ssot/data-model-objects?offset=20',
    });
    expect(buildNextPath('services/data/v65.0/ssot/data-lake-objects', continuation))
      .toBe('services/data/v65.0/ssot/data-lake-objects');
  });

  it('follows Salesforce nextPageUrl responses for DLOs and streams', () => {
    const continuation = extractContinuation({
      totalSize: 23,
      nextPageUrl: '/services/data/v68.0/ssot/data-lake-objects?limit=20&offset=20',
    });
    expect(continuation.nextPath).toBe('services/data/v68.0/ssot/data-lake-objects?limit=20&offset=20');
    expect(buildNextPath('services/data/v68.0/ssot/data-lake-objects', continuation))
      .toBe('services/data/v68.0/ssot/data-lake-objects?limit=20&offset=20');
  });

  it('continues full DMO offset pages and stops on a short page', () => {
    const path = 'services/data/v68.0/ssot/data-model-objects?limit=100&offset=0';
    const full = offsetContinuation({ dataModelObject: new Array(100).fill({ name: 'DMO' }) }, path, 100, 100);
    expect(full.hasMore).toBe(true);
    expect(buildNextPath(path, full)).toBe('services/data/v68.0/ssot/data-model-objects?limit=100&offset=100');

    const short = offsetContinuation({ dataModelObject: [{ name: 'DMO' }] }, path, 100, 46);
    expect(short.hasMore).toBe(false);
    expect(buildNextPath(path, short)).toBe(path);
  });

  it('stops a full one-record page when the reported total has been reached', () => {
    const path = 'services/data/v68.0/ssot/data-transforms?filterGroup=Small&limit=1&offset=2';
    const continuation = offsetContinuation(
      { dataTransforms: [{ apiName: 'Transform_003' }], totalSize: 3 },
      path,
      1,
      1,
    );
    expect(continuation.hasMore).toBe(false);
    expect(continuation.cursor).toBeNull();
    expect(buildNextPath(path, continuation)).toBe(path);
  });

  it('reads totals from common envelopes and stops on explicit completion', () => {
    expect(extractTotal({ result: { totalSize: 200, records: [] } })).toBe(200);
    expect(extractTotal({ meta: { totalCount: '42' } })).toBe(42);
    expect(extractContinuation({ totalSize: 10, done: true, nextToken: 'ignored' }).hasMore).toBe(false);
  });

  it('honors an explicit end before requesting another offset page', () => {
    const path = 'services/data/v68.0/ssot/data-transforms?filterGroup=Medium&limit=20&offset=0';
    const rows = new Array(20).fill({ name: 'Transform' });
    const continuation = offsetContinuation({ dataTransforms: rows, hasMore: false }, path, 20, 20);
    expect(continuation.hasMore).toBe(false);
    expect(buildNextPath(path, continuation)).toBe(path);
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
