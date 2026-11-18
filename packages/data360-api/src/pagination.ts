import { isRecord } from './normalize.ts';

/**
 * Salesforce and Data 360 endpoints do not share one continuation contract.
 * Treat every cursor as opaque and discover its key, nesting, and transport
 * from the response instead of assuming `nextToken` in every payload.
 */
export interface Continuation {
  cursor: string | null;
  /** Query parameter to use when the cursor is a plain value. */
  param: string | null;
  /** Followable REST path when Salesforce returned a URL-style continuation. */
  nextPath: string | null;
  total: number | null;
  hasMore: boolean;
  /** Salesforce said there is more data but did not expose a usable cursor. */
  uncertain: boolean;
}

const TOKEN_KEYS = [
  'nextToken',
  'nextPageToken',
  'continuationToken',
  'paginationToken',
  'pageToken',
  'nextCursor',
  'endCursor',
  'cursor',
  'locator',
  'nextRecordsUrl',
  'nextUrl',
  'nextLink',
  'after',
  'offset',
  'start',
  'page',
  'nextPage',
  'next',
  'token',
] as const;

const NESTED_KEYS = [
  'pagination',
  'pageInfo',
  'paging',
  'page',
  'meta',
  'metadata',
  'result',
  'response',
  'data',
  'payload',
  'links',
] as const;

const PARAM_BY_KEY: Record<string, string> = {
  nextToken: 'nextToken',
  nextPageToken: 'nextPageToken',
  continuationToken: 'continuationToken',
  paginationToken: 'paginationToken',
  pageToken: 'pageToken',
  nextCursor: 'nextCursor',
  endCursor: 'endCursor',
  cursor: 'cursor',
  locator: 'locator',
  after: 'after',
  offset: 'offset',
  start: 'start',
  page: 'page',
  nextPage: 'page',
  next: 'nextToken',
  token: 'token',
  nextRecordsUrl: 'nextToken',
  nextUrl: 'nextToken',
  nextLink: 'nextToken',
};

const TOTAL_KEYS = ['totalSize', 'totalCount', 'totalRecords', 'totalElements', 'totalItems', 'recordCount', 'total'];
const MORE_KEYS = ['hasMore', 'hasNext', 'hasNextPage', 'more'];
const DONE_KEYS = ['done', 'isLast', 'last', 'isLastPage'];

function normalizeNextPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let path = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      path = `${url.pathname.replace(/^\//, '')}${url.search}`;
    } catch {
      return null;
    }
  } else {
    path = trimmed.replace(/^\//, '');
  }
  return path.startsWith('services/data/') ? path : null;
}

function numericTotal(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Read the first trustworthy total exposed by a response envelope. */
export function extractTotal(value: unknown): number | null {
  const seen = new WeakSet<object>();
  let frontier: unknown[] = [value];
  for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
    const next: unknown[] = [];
    for (const candidate of frontier) {
      if (!isRecord(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      for (const key of TOTAL_KEYS) {
        const total = numericTotal(candidate[key]);
        if (total !== null) return total;
      }
      for (const key of NESTED_KEYS) {
        const nested = candidate[key];
        if (isRecord(nested)) next.push(nested);
      }
    }
    frontier = next;
  }
  return null;
}

function explicitEnd(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of DONE_KEYS) {
    if (value[key] === true) return true;
  }
  for (const key of MORE_KEYS) {
    if (value[key] === false) return true;
  }
  return false;
}

function explicitMore(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of MORE_KEYS) {
    if (value[key] === true) return true;
  }
  for (const key of DONE_KEYS) {
    if (value[key] === false) return true;
  }
  return false;
}

function declaredParam(record: Record<string, unknown>): string | null {
  for (const key of ['param', 'parameter', 'pageParameter']) {
    const value = record[key];
    if (typeof value === 'string' && /^[A-Za-z0-9_$-]{1,64}$/.test(value)) return value;
  }
  return null;
}

function cursorFromValue(key: string, value: unknown, parent: Record<string, unknown>): Omit<Continuation, 'total' | 'hasMore' | 'uncertain'> | null {
  const param = declaredParam(parent) ?? PARAM_BY_KEY[key] ?? null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const nextPath = normalizeNextPath(trimmed);
    return { cursor: nextPath ? null : trimmed, param, nextPath };
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return { cursor: String(value), param, nextPath: null };
  }
  if (!isRecord(value)) return null;

  // Object-shaped continuations such as `next: { cursor, param }` or
  // `pagination: { token, url }` carry their own transport hints.
  for (const inner of ['nextToken', 'token', 'cursor', 'value', 'locator', 'after']) {
    const candidate = value[inner];
    if (typeof candidate === 'string' && candidate.trim()) {
      return {
        cursor: candidate.trim(),
        param: declaredParam(value) ?? declaredParam(parent) ?? PARAM_BY_KEY[inner] ?? param,
        nextPath: null,
      };
    }
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) {
      return {
        cursor: String(candidate),
        param: declaredParam(value) ?? declaredParam(parent) ?? PARAM_BY_KEY[inner] ?? param,
        nextPath: null,
      };
    }
  }
  for (const inner of ['url', 'href', 'nextUrl', 'path', 'nextRecordsUrl']) {
    const candidate = value[inner];
    if (typeof candidate === 'string') {
      const nextPath = normalizeNextPath(candidate);
      if (nextPath) return { cursor: null, param, nextPath };
    }
  }
  return null;
}

/**
 * Find a continuation anywhere in a response without treating an unrelated
 * `next: true` flag or a `total` field as a cursor.
 */
export function extractContinuation(value: unknown): Continuation {
  const total = extractTotal(value);
  const empty: Continuation = {
    cursor: null,
    param: null,
    nextPath: null,
    total,
    hasMore: explicitMore(value),
    uncertain: explicitMore(value),
  };

  const seen = new WeakSet<object>();
  let sawMore = empty.hasMore;
  let frontier: unknown[] = [value];
  for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
    const next: unknown[] = [];
    for (const candidate of frontier) {
      if (!isRecord(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);

      if (explicitMore(candidate)) sawMore = true;
      if (explicitEnd(candidate)) return { ...empty, hasMore: false, uncertain: false };

      for (const key of TOKEN_KEYS) {
        const found = cursorFromValue(key, candidate[key], candidate);
        if (!found) continue;
        return { ...found, total, hasMore: true, uncertain: false };
      }

      for (const key of NESTED_KEYS) {
        const nested = candidate[key];
        if (Array.isArray(nested)) next.push(...nested);
        else if (isRecord(nested)) next.push(nested);
      }
    }
    frontier = next;
  }

  return { ...empty, hasMore: sawMore, uncertain: sawMore };
}

/** Append or replace a cursor on an already allowlisted Data 360 REST path. */
export function buildNextPath(path: string, continuation: Continuation): string {
  if (continuation.nextPath) return continuation.nextPath;
  if (!continuation.cursor) return path;
  const param = continuation.param ?? 'nextToken';
  try {
    const url = new URL(path, 'https://dcat.local');
    url.searchParams.set(param, continuation.cursor);
    return `${url.pathname.replace(/^\//, '')}${url.search}`;
  } catch {
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}${param}=${encodeURIComponent(continuation.cursor)}`;
  }
}
