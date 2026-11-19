// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { PAGE_TITLES } from '../navigation.ts';
import type { Page } from '../navigation.ts';
import { applyPageMetadata, PAGE_SEO, SITE_URL } from './seo.ts';

afterEach(() => {
  document.head.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]').forEach((element) => element.remove());
  document.head.querySelector('link[rel="canonical"]')?.remove();
});

describe('page metadata', () => {
  it('defines a unique title and description for every route', () => {
    const pages = Object.keys(PAGE_TITLES) as Page[];
    const titles = pages.map((page) => PAGE_SEO[page].title);
    const descriptions = pages.map((page) => PAGE_SEO[page].description);

    expect(new Set(titles).size).toBe(pages.length);
    expect(new Set(descriptions).size).toBe(pages.length);
  });

  it('uses real paths for canonical and social URLs', () => {
    applyPageMetadata('about');

    expect(document.title).toBe('About DCAT | Data Cloud Architect Toolkit');
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toContain(
      'local-first, read-only workbench',
    );
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`${SITE_URL}/about`);
    expect(document.head.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(`${SITE_URL}/about`);
    expect(document.head.querySelector('meta[name="twitter:title"]')?.getAttribute('content')).toBe(
      'About DCAT | Data Cloud Architect Toolkit',
    );
  });
});
