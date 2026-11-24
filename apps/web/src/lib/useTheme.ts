import { useEffect, useState } from 'react';
import {
  applyAppearance,
  applyTheme,
  clearDensityPreference,
  clearFontSizePreference,
  clearThemePalette,
  clearThemePreference,
  getDensityPreference,
  getFontSizePreference,
  getThemePalette,
  getThemePreference,
  resolveTheme,
  setDensityPreference,
  setFontSizePreference,
  setThemePalette,
  setThemePreference,
} from './preferences.ts';
import type {
  DensityPreference,
  FontSizePreference,
  ResolvedTheme,
  ThemePalette,
  ThemePreference,
} from './preferences.ts';

export interface ThemeController {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  palette: ThemePalette;
  fontSize: FontSizePreference;
  density: DensityPreference;
  choose: (theme: ThemePreference) => void;
  choosePalette: (palette: ThemePalette) => void;
  chooseFontSize: (fontSize: FontSizePreference) => void;
  chooseDensity: (density: DensityPreference) => void;
  toggle: () => void;
  reset: () => void;
}

/** Owns appearance preferences, applies them to the document, and follows system theme changes. */
export function useTheme(): ThemeController {
  const [preference, setPreference] = useState<ThemePreference>(() => getThemePreference());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(getThemePreference()));
  const [palette, setPalette] = useState<ThemePalette>(() => getThemePalette());
  const [fontSize, setFontSize] = useState<FontSizePreference>(() => getFontSizePreference());
  const [density, setDensity] = useState<DensityPreference>(() => getDensityPreference());

  useEffect(() => applyTheme(preference, setResolved), [preference]);
  useEffect(() => applyAppearance({ palette, fontSize, density }), [palette, fontSize, density]);

  const choose = (theme: ThemePreference) => {
    setThemePreference(theme);
    setPreference(theme);
  };

  const choosePalette = (nextPalette: ThemePalette) => {
    setThemePalette(nextPalette);
    setPalette(nextPalette);
  };

  const chooseFontSize = (nextFontSize: FontSizePreference) => {
    setFontSizePreference(nextFontSize);
    setFontSize(nextFontSize);
  };

  const chooseDensity = (nextDensity: DensityPreference) => {
    setDensityPreference(nextDensity);
    setDensity(nextDensity);
  };

  const reset = () => {
    clearThemePreference();
    clearThemePalette();
    clearFontSizePreference();
    clearDensityPreference();
    setPreference('system');
    setResolved(resolveTheme('system'));
    setPalette('forest');
    setFontSize('medium');
    setDensity('comfortable');
  };

  return {
    preference,
    resolved,
    palette,
    fontSize,
    density,
    choose,
    choosePalette,
    chooseFontSize,
    chooseDensity,
    toggle: () => choose(resolved === 'dark' ? 'light' : 'dark'),
    reset,
  };
}
