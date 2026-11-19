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
  | 'dictionary'
  | 'settings'
  | 'help';

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
    items: [{ id: 'help', label: 'Help' }],
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
  dictionary: 'Data Dictionary',
  settings: 'Settings & Diagnostics',
  help: 'Help',
};

const PAGE_IDS = Object.keys(PAGE_TITLES) as Page[];
const PAGE_ID_SET = new Set<string>(PAGE_IDS);

export function isPage(value: string): value is Page {
  return PAGE_ID_SET.has(value);
}

/** The landing view keeps a clean URL; every other view is addressable by fragment. */
export function pageHash(page: Page): string {
  return page === 'dashboard' ? '' : `#${page}`;
}

export function pageHref(page: Page): string {
  return page === 'dashboard' ? './' : pageHash(page);
}

function hashValue(hash: string): string {
  return hash.replace(/^#\/?/, '').trim().toLowerCase();
}

export function pageFromHash(hash: string): Page {
  const candidate = hashValue(hash);
  return isPage(candidate) ? candidate : 'dashboard';
}

export function pageUrl(page: Page, currentUrl: string): string {
  const url = new URL(currentUrl);
  url.hash = pageHash(page);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function writePageHash(page: Page, mode: 'push' | 'replace' = 'push'): void {
  const nextUrl = pageUrl(page, window.location.href);
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl === currentUrl) return;
  if (mode === 'replace') window.history.replaceState(null, '', nextUrl);
  else window.history.pushState(null, '', nextUrl);
}
