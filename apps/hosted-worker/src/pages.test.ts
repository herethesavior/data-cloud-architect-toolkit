import { beforeEach, describe, expect, it, vi } from 'vitest';
import pages from './pages.ts';
import type { KVNamespaceLike } from './types.ts';

class FakeKV implements KVNamespaceLike {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const assetFetch = vi.fn(async () => new Response('spa shell', { headers: { 'content-type': 'text/html' } }));
const env = { DCAT_SESSIONS: new FakeKV(), ASSETS: { fetch: assetFetch } };

describe('Cloudflare Pages advanced-mode entry', () => {
  beforeEach(() => {
    assetFetch.mockClear();
  });

  it('routes API requests through the Hono app and keeps them uncached', async () => {
    const response = await pages.fetch(
      new Request('https://dcat.example/api/session'),
      env,
      undefined as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'live' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(assetFetch).not.toHaveBeenCalled();
  });

  it('delegates SPA requests to the Pages asset binding', async () => {
    const response = await pages.fetch(
      new Request('https://dcat.example/org-connections'),
      env,
      undefined as never,
    );

    expect(await response.text()).toBe('spa shell');
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(assetFetch).toHaveBeenCalledTimes(1);
  });
});
