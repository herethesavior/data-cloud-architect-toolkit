// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyAppearance,
  applyTheme,
  clearDensityPreference,
  clearFontSizePreference,
  clearThemePalette,
  clearThemePreference,
  getDensityPreference,
  getDrawerFullWidth,
  getFontSizePreference,
  getHiddenOrgs,
  getThemePalette,
  getThemePreference,
  resolveTheme,
  setDensityPreference,
  setDrawerFullWidth,
  setFontSizePreference,
  setHiddenOrgs,
  setThemePalette,
  setThemePreference,
} from './preferences.ts';

interface SystemTheme {
  setDark: (dark: boolean) => void;
  listenerCount: () => number;
}

function mockSystemTheme(initialDark = false): SystemTheme {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let dark = initialDark;
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
  })));
  return {
    setDark: (next) => {
      dark = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
    listenerCount: () => listeners.size,
  };
}

describe('theme preferences', () => {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => { store.delete(key); },
    setItem: (key, value) => { store.set(key, value); },
  };

  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
    store.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.palette;
    delete document.documentElement.dataset.fontSize;
    delete document.documentElement.dataset.density;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to the system preference when nothing is stored', () => {
    expect(getThemePreference()).toBe('system');
    setThemePreference('dark');
    expect(getThemePreference()).toBe('dark');
    setThemePreference('light');
    expect(getThemePreference()).toBe('light');
  });

  it('can clear a stored theme preference', () => {
    setThemePreference('dark');
    clearThemePreference();

    expect(window.localStorage.getItem('dcat.theme')).toBeNull();
    expect(getThemePreference()).toBe('system');
  });

  it('ignores unknown stored values', () => {
    window.localStorage.setItem('dcat.theme', 'neon');
    expect(getThemePreference()).toBe('system');
  });

  it('stores only valid hidden org aliases and can clear them', () => {
    setHiddenOrgs(['prod-org', 'prod-org', 'bad alias', 'uat.example']);
    expect(getHiddenOrgs()).toEqual(['prod-org', 'uat.example']);
    expect(JSON.parse(window.localStorage.getItem('dcat.hiddenOrgs') ?? 'null')).toEqual(['prod-org', 'uat.example']);

    setHiddenOrgs([]);
    expect(getHiddenOrgs()).toEqual([]);
    expect(window.localStorage.getItem('dcat.hiddenOrgs')).toBeNull();
  });

  it('ignores malformed hidden org storage', () => {
    window.localStorage.setItem('dcat.hiddenOrgs', '{"alias":"prod-org"}');
    expect(getHiddenOrgs()).toEqual([]);
  });

  it('remembers the detail drawer width preference', () => {
    expect(getDrawerFullWidth()).toBe(false);
    setDrawerFullWidth(true);
    expect(getDrawerFullWidth()).toBe(true);
    expect(window.localStorage.getItem('dcat.drawerFullWidth')).toBe('true');

    setDrawerFullWidth(false);
    expect(getDrawerFullWidth()).toBe(false);
    expect(window.localStorage.getItem('dcat.drawerFullWidth')).toBeNull();
  });

  it('stores appearance preferences and falls back to safe defaults', () => {
    expect(getThemePalette()).toBe('forest');
    expect(getFontSizePreference()).toBe('medium');
    expect(getDensityPreference()).toBe('comfortable');

    setThemePalette('midnight');
    setFontSizePreference('large');
    setDensityPreference('compact');
    expect(getThemePalette()).toBe('midnight');
    expect(getFontSizePreference()).toBe('large');
    expect(getDensityPreference()).toBe('compact');

    window.localStorage.setItem('dcat.themePalette', 'neon');
    window.localStorage.setItem('dcat.fontSize', 'huge');
    window.localStorage.setItem('dcat.density', 'loose');
    expect(getThemePalette()).toBe('forest');
    expect(getFontSizePreference()).toBe('medium');
    expect(getDensityPreference()).toBe('comfortable');

    clearThemePalette();
    clearFontSizePreference();
    clearDensityPreference();
    expect(window.localStorage.getItem('dcat.themePalette')).toBeNull();
    expect(window.localStorage.getItem('dcat.fontSize')).toBeNull();
    expect(window.localStorage.getItem('dcat.density')).toBeNull();
  });

  it('applies appearance preferences to the document root', () => {
    applyAppearance({ palette: 'midnight', fontSize: 'large', density: 'compact' });

    expect(document.documentElement.dataset.palette).toBe('midnight');
    expect(document.documentElement.dataset.fontSize).toBe('large');
    expect(document.documentElement.dataset.density).toBe('compact');
  });

  it('resolves explicit themes without consulting the system', () => {
    const system = mockSystemTheme(true);
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('system')).toBe('dark');
    expect(system.listenerCount()).toBe(0);
  });

  it('applies an explicit theme to the document', () => {
    const onResolve = vi.fn();
    applyTheme('dark', onResolve);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(onResolve).toHaveBeenCalledWith('dark');
  });

  it('follows system changes while set to system and stops on cleanup', () => {
    const system = mockSystemTheme(false);
    const onResolve = vi.fn();
    const cleanup = applyTheme('system', onResolve);
    expect(document.documentElement.dataset.theme).toBe('light');

    system.setDark(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(onResolve).toHaveBeenLastCalledWith('dark');
    expect(system.listenerCount()).toBe(1);

    cleanup();
    system.setDark(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(system.listenerCount()).toBe(0);
  });
});
