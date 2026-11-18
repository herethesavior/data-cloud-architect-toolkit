export type ModePreference = 'demo' | 'live';

const MODE_KEY = 'dcat.mode';
const ORG_KEY = 'dcat.selectedOrg';
const THEME_KEY = 'dcat.theme';
const SIDEBAR_KEY = 'dcat.sidebarCollapsed';
const DARK_QUERY = '(prefers-color-scheme: dark)';

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
