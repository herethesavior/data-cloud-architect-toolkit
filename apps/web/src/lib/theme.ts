export interface ThemePalette {
  surface: string;
  surfaceAlt: string;
  ink: string;
  inkSoft: string;
  inkFaint: string;
  line: string;
  brand: string;
  brandSoft: string;
  warning: string;
  success: string;
  danger: string;
}

export function getThemePalette(): ThemePalette {
  const style = getComputedStyle(document.documentElement);
  const read = (variable: string) => style.getPropertyValue(variable).trim();
  return {
    surface: read('--color-surface'),
    surfaceAlt: read('--color-surface-alt'),
    ink: read('--color-ink'),
    inkSoft: read('--color-ink-soft'),
    inkFaint: read('--color-ink-faint'),
    line: read('--color-line'),
    brand: read('--color-brand'),
    brandSoft: read('--color-brand-soft'),
    warning: read('--color-warning'),
    success: read('--color-success'),
    danger: read('--color-danger'),
  };
}
