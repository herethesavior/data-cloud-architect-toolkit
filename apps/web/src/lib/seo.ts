import { useEffect } from 'react';
import { pagePath } from '../navigation.ts';
import type { Page } from '../navigation.ts';

export const SITE_URL = 'https://sfdcat.pages.dev';

const TAGLINE = 'See the architecture. Understand the connections. Make better decisions.';
const BASE_DESCRIPTION = `${TAGLINE} DCAT is a local-first, read-only workbench for Salesforce Data Cloud (Data 360) metadata.`;

interface PageSeo {
  title: string;
  description: string;
}

export const PAGE_SEO: Record<Page, PageSeo> = {
  dashboard: {
    title: 'DCAT | Data Cloud Architect Toolkit',
    description: `${BASE_DESCRIPTION} Start with an overview of the available Data Cloud metadata.`,
  },
  orgs: {
    title: 'Org Connections | DCAT',
    description: 'Use the Salesforce CLI authentication already on your machine to explore Data Cloud metadata. DCAT does not ask for passwords, tokens, or client secrets.',
  },
  'data-spaces': {
    title: 'Data Spaces | DCAT',
    description: 'Inspect the Data Spaces available in the current Data Cloud metadata snapshot.',
  },
  dlos: {
    title: 'DLO Explorer | DCAT',
    description: 'Explore Data Landing Objects and the metadata that describes how data lands in Data Cloud.',
  },
  dmos: {
    title: 'DMO Explorer | DCAT',
    description: 'Explore Data Model Objects and the relationships that make up the Data Cloud data model.',
  },
  mappings: {
    title: 'Mapping Explorer | DCAT',
    description: 'Inspect field mappings between source objects and Data Cloud objects.',
  },
  'data-streams': {
    title: 'Data Stream Explorer | DCAT',
    description: 'Review Data Stream configuration, source objects, and ingestion metadata.',
  },
  'data-transforms': {
    title: 'Data Transform Explorer | DCAT',
    description: 'Inspect transformation metadata and how it fits into the data path.',
  },
  erd: {
    title: 'ERD Explorer | DCAT',
    description: 'Explore an entity relationship view of Data Cloud objects and their connections.',
  },
  lineage: {
    title: 'Data Lineage Explorer | DCAT',
    description: 'Trace source-to-target data lineage and see which relationships are confirmed, derived, or unresolved.',
  },
  dictionary: {
    title: 'Data Dictionary | DCAT',
    description: 'Search field-level metadata across Data Cloud objects in one local reference.',
  },
  settings: {
    title: 'Settings & Diagnostics | DCAT',
    description: 'Review DCAT diagnostics and control themes, cached metadata, saved layouts, and local data.',
  },
  help: {
    title: 'Help & documentation | DCAT',
    description: 'Find setup guidance, privacy and status details, terminology, and contact information for DCAT.',
  },
  about: {
    title: 'About DCAT | Data Cloud Architect Toolkit',
    description: `${BASE_DESCRIPTION} Read the product story, from discovery and evidence to boundaries and next steps.`,
  },
};

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
  const canonical = `${SITE_URL}${pagePath(page)}`;

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
