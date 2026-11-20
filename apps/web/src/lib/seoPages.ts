/**
 * Framework-free page metadata shared by the browser hook and the Pages Worker.
 * The Worker needs these values to serve correct tags to clients that never run
 * JavaScript, so this module must not import React or browser-only helpers.
 */
export const SITE_URL = 'https://sfdcat.pages.dev';

export type SeoPage =
  | 'dashboard'
  | 'orgs'
  | 'data-spaces'
  | 'dlos'
  | 'dmos'
  | 'mappings'
  | 'data-streams'
  | 'data-transforms'
  | 'erd'
  | 'lineage'
  | 'change-impact'
  | 'dictionary'
  | 'settings'
  | 'help'
  | 'about';

export interface PageSeo {
  title: string;
  description: string;
}

const TAGLINE = 'See the architecture. Understand the connections. Make better decisions.';
const BASE_DESCRIPTION = `${TAGLINE} DCAT is a local-first, read-only workbench for Salesforce Data Cloud (Data 360) metadata.`;

export const PAGE_SEO: Record<SeoPage, PageSeo> = {
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
  'change-impact': {
    title: 'Change Impact Analyzer | DCAT',
    description: 'Review upstream and downstream dependencies for a DLO, DMO, field, or relationship before changing Data Cloud metadata.',
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

/** Mirrors the app's real paths without importing the browser navigation module. */
export function seoPath(page: SeoPage): string {
  return page === 'dashboard' ? '/' : `/${page}`;
}

/** Only exact, known page paths receive page-specific tags. */
export function seoPageFromPath(pathname: string): SeoPage | null {
  const segment = pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!segment) return 'dashboard';
  return Object.prototype.hasOwnProperty.call(PAGE_SEO, segment) ? segment as SeoPage : null;
}
