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

const shell = `<!doctype html>
<html lang="en">
  <head>
    <meta
      name="description"
      content="Dashboard description"
    />
    <meta property="og:title" content="DCAT | Data Cloud Architect Toolkit" />
    <meta
      property="og:description"
      content="Dashboard description"
    />
    <meta property="og:url" content="https://sfdcat.pages.dev/" />
    <meta name="twitter:title" content="DCAT | Data Cloud Architect Toolkit" />
    <meta
      name="twitter:description"
      content="Dashboard description"
    />
    <meta name="twitter:url" content="https://sfdcat.pages.dev/" />
    <link rel="canonical" href="https://sfdcat.pages.dev/" />
    <title>DCAT | Data Cloud Architect Toolkit</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

const assetFetch = vi.fn(async () => new Response(shell, { headers: { 'content-type': 'text/html' } }));
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
      new Request('https://dcat.example/unknown-path'),
      env,
      undefined as never,
    );

    expect(await response.text()).toBe(shell);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(assetFetch).toHaveBeenCalledTimes(1);
  });

  it('serves path-specific metadata in the raw HTML for non-rendering clients', async () => {
    const response = await pages.fetch(
      new Request('https://dcat.example/about'),
      env,
      undefined as never,
    );
    const html = await response.text();

    expect(html).toContain('<title>About DCAT | Data Cloud Architect Toolkit</title>');
    expect(html).toContain('<link rel="canonical" href="https://sfdcat.pages.dev/about" />');
    expect(html).toContain('property="og:url" content="https://sfdcat.pages.dev/about"');
    expect(html).toContain('name="twitter:url" content="https://sfdcat.pages.dev/about"');
    expect(html).toContain('Read the product story');
    expect(html).not.toContain('Dashboard description');
    expect(response.headers.get('content-length')).toBeNull();
  });

  it('keeps the dashboard shell metadata for the root path', async () => {
    const response = await pages.fetch(new Request('https://dcat.example/'), env, undefined as never);
    const html = await response.text();

    expect(html).toContain('<title>DCAT | Data Cloud Architect Toolkit</title>');
    expect(html).toContain('href="https://sfdcat.pages.dev/"');
  });

  it('does not rewrite HTML for asset responses', async () => {
    assetFetch.mockResolvedValueOnce(new Response('body{}', { headers: { 'content-type': 'text/css' } }));

    const response = await pages.fetch(
      new Request('https://dcat.example/about'),
      env,
      undefined as never,
    );

    expect(await response.text()).toBe('body{}');
  });
});
