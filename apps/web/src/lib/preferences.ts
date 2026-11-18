export type ModePreference = 'demo' | 'live';

const MODE_KEY = 'dcat.mode';
const ORG_KEY = 'dcat.selectedOrg';
const HIDDEN_ORGS_KEY = 'dcat.hiddenOrgs';
const THEME_KEY = 'dcat.theme';
const SIDEBAR_KEY = 'dcat.sidebarCollapsed';
const DARK_QUERY = '(prefers-color-scheme: dark)';
const ORG_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const MAX_HIDDEN_ORGS = 200;

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

function getStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function getModePreference(): ModePreference | null {
  const value = getStorage()?.getItem(MODE_KEY);
  return value === 'demo' || value === 'live' ? value : null;
}

export function setModePreference(mode: ModePreference): void {
  getStorage()?.setItem(MODE_KEY, mode);
}

export function getSelectedOrg(): string | null {
  return getStorage()?.getItem(ORG_KEY) ?? null;
}

export function setSelectedOrg(alias: string | null): void {
  const storage = getStorage();
  if (!storage) return;
  if (alias) storage.setItem(ORG_KEY, alias);
  else storage.removeItem(ORG_KEY);
}

/** Orgs hidden from DCAT are browser-local; Salesforce CLI auth is untouched. */
export function getHiddenOrgs(): string[] {
  const raw = getStorage()?.getItem(HIDDEN_ORGS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(
      (alias): alias is string => typeof alias === 'string' && ORG_ALIAS_PATTERN.test(alias),
    ))].slice(0, MAX_HIDDEN_ORGS);
  } catch {
    return [];
  }
}

export function setHiddenOrgs(aliases: readonly string[]): void {
  const storage = getStorage();
  if (!storage) return;
  const valid = [...new Set(aliases.filter((alias) => ORG_ALIAS_PATTERN.test(alias)))].slice(0, MAX_HIDDEN_ORGS);
  if (valid.length === 0) storage.removeItem(HIDDEN_ORGS_KEY);
  else storage.setItem(HIDDEN_ORGS_KEY, JSON.stringify(valid));
}

export function getSidebarCollapsed(): boolean {
  return getStorage()?.getItem(SIDEBAR_KEY) === 'true';
}

export function setSidebarCollapsed(collapsed: boolean): void {
  if (collapsed) getStorage()?.setItem(SIDEBAR_KEY, 'true');
  else getStorage()?.removeItem(SIDEBAR_KEY);
}

export function getThemePreference(): ThemePreference {
  const value = getStorage()?.getItem(THEME_KEY);
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export function setThemePreference(theme: ThemePreference): void {
  getStorage()?.setItem(THEME_KEY, theme);
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== 'system') return preference;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/**
 * Apply the resolved theme to the document and follow system changes while the
 * preference is 'system'. Returns a cleanup function for the active listener.
 */
export function applyTheme(
  preference: ThemePreference,
  onResolve?: (theme: ResolvedTheme) => void,
): () => void {
  const apply = (theme: ResolvedTheme) => {
    document.documentElement.dataset.theme = theme;
    onResolve?.(theme);
  };

  apply(resolveTheme(preference));

  if (preference !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }

  const query = window.matchMedia(DARK_QUERY);
  const listener = (event: MediaQueryListEvent) => apply(event.matches ? 'dark' : 'light');
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
