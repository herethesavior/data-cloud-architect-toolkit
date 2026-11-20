export type Page =
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

export interface NavItem {
  id: Page;
  label: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { id: 'dashboard', label: 'Dashboard' },
      { id: 'orgs', label: 'Org Connections' },
    ],
  },
  {
    label: 'Explore',
    items: [
      { id: 'data-spaces', label: 'Data Spaces' },
      { id: 'dlos', label: 'DLO Explorer' },
      { id: 'dmos', label: 'DMO Explorer' },
      { id: 'mappings', label: 'Mapping Explorer' },
      { id: 'data-streams', label: 'Data Stream Explorer' },
      { id: 'data-transforms', label: 'Data Transform Explorer' },
      { id: 'erd', label: 'ERD Explorer' },
      { id: 'lineage', label: 'Data Lineage Explorer' },
      { id: 'change-impact', label: 'Change Impact Analyzer' },
    ],
  },
  {
    label: 'Outputs',
    items: [
      { id: 'dictionary', label: 'Data Dictionary' },
      { id: 'settings', label: 'Settings & Diagnostics' },
    ],
  },
  {
    label: 'Support',
    items: [
      { id: 'help', label: 'Help' },
      { id: 'about', label: 'About DCAT' },
    ],
  },
];

export const PAGE_TITLES: Record<Page, string> = {
  dashboard: 'Dashboard',
  orgs: 'Org Connections',
  'data-spaces': 'Data Spaces',
  dlos: 'DLO Explorer',
  dmos: 'DMO Explorer',
  mappings: 'Mapping Explorer',
  'data-streams': 'Data Stream Explorer',
  'data-transforms': 'Data Transform Explorer',
  erd: 'ERD Explorer',
  lineage: 'Data Lineage Explorer',
  'change-impact': 'Change Impact Analyzer',
  dictionary: 'Data Dictionary',
  settings: 'Settings & Diagnostics',
  help: 'Help',
  about: 'About DCAT',
};

const PAGE_IDS = Object.keys(PAGE_TITLES) as Page[];
const PAGE_ID_SET = new Set<string>(PAGE_IDS);

export function isPage(value: string): value is Page {
  return PAGE_ID_SET.has(value);
}

/** Every view has a real, crawlable path. The landing view stays at the root. */
export function pagePath(page: Page): string {
  return page === 'dashboard' ? '/' : `/${page}`;
}

export function pageHref(page: Page): string {
  return pagePath(page);
}

function normalizeSegment(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '').trim().toLowerCase();
}

export function pageFromPath(pathname: string): Page {
  const candidate = normalizeSegment(pathname.split('?')[0]);
  return isPage(candidate) ? candidate : 'dashboard';
}

/** Accept old `#page` bookmarks once, then normalize them to real paths. */
function legacyPageFromHash(hash: string): Page | null {
  const candidate = hash.replace(/^#\/?/, '').trim().toLowerCase();
  return isPage(candidate) ? candidate : null;
}

export function pageFromLocation(location: Pick<Location, 'pathname' | 'hash'>): Page {
  const fromPath = pageFromPath(location.pathname);
  if (fromPath !== 'dashboard' || !location.hash) return fromPath;
  return legacyPageFromHash(location.hash) ?? 'dashboard';
}

export function isLegacyPageHash(hash: string): boolean {
  return legacyPageFromHash(hash) !== null;
}

export function pageUrl(page: Page, currentUrl: string): string {
  const url = new URL(currentUrl);
  url.pathname = pagePath(page);
  url.hash = '';
  return `${url.pathname}${url.search}`;
}

export function writePagePath(page: Page, mode: 'push' | 'replace' = 'push'): void {
  const nextUrl = pageUrl(page, window.location.href);
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl === currentUrl) return;
  if (mode === 'replace') window.history.replaceState(null, '', nextUrl);
  else window.history.pushState(null, '', nextUrl);
}
