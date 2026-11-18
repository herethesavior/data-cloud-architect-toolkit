import { useEffect, useState } from 'react';
import { applyTheme, getThemePreference, resolveTheme, setThemePreference } from './preferences.ts';
import type { ResolvedTheme, ThemePreference } from './preferences.ts';

export interface ThemeController {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  choose: (theme: ThemePreference) => void;
  toggle: () => void;
}

/** Owns the theme preference, applies it to the document, and follows system changes. */
export function useTheme(): ThemeController {
  const [preference, setPreference] = useState<ThemePreference>(() => getThemePreference());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(getThemePreference()));

  useEffect(() => applyTheme(preference, setResolved), [preference]);

  const choose = (theme: ThemePreference) => {
    setThemePreference(theme);
    setPreference(theme);
  };

  return {
    preference,
    resolved,
    choose,
    toggle: () => choose(resolved === 'dark' ? 'light' : 'dark'),
  };
}
