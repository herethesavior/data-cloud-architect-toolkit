import { useEffect } from 'react';
import type { Page } from '../navigation.ts';
import { PAGE_SEO as SEO_BY_PAGE, SITE_URL, seoPath } from './seoPages.ts';
import type { PageSeo } from './seoPages.ts';

export { SITE_URL } from './seoPages.ts';
export const PAGE_SEO: Record<Page, PageSeo> = SEO_BY_PAGE;

function setMeta(attribute: 'name' | 'property', key: string, content: string): void {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.content = content;
}

function setCanonical(url: string): void {
  let element = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!element) {
    element = document.createElement('link');
    element.rel = 'canonical';
    document.head.appendChild(element);
  }
  element.href = url;
}

/** Keeps crawlable metadata aligned with the real path used for each view. */
export function applyPageMetadata(page: Page): void {
  const { title, description } = PAGE_SEO[page];
  const canonical = `${SITE_URL}${seoPath(page)}`;

  document.title = title;
  setMeta('name', 'description', description);
  setMeta('property', 'og:title', title);
  setMeta('property', 'og:description', description);
  setMeta('property', 'og:url', canonical);
  setMeta('name', 'twitter:title', title);
  setMeta('name', 'twitter:description', description);
  setMeta('name', 'twitter:url', canonical);
  setCanonical(canonical);
}

export function usePageMetadata(page: Page): void {
  useEffect(() => {
    applyPageMetadata(page);
  }, [page]);
}
