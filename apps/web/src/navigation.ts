export type Page =
  | 'dashboard'
  | 'orgs'
  | 'data-spaces'
  | 'dlos'
  | 'dmos'
  | 'mappings'
  | 'data-transforms'
  | 'erd'
  | 'dictionary'
  | 'settings';

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
      { id: 'data-transforms', label: 'Data Transform Explorer' },
      { id: 'erd', label: 'ERD Explorer' },
    ],
  },
  {
    label: 'Outputs',
    items: [
      { id: 'dictionary', label: 'Data Dictionary' },
      { id: 'settings', label: 'Settings & Diagnostics' },
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
  'data-transforms': 'Data Transform Explorer',
  erd: 'ERD Explorer',
  dictionary: 'Data Dictionary',
  settings: 'Settings & Diagnostics',
};
