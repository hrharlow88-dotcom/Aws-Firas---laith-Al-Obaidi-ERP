/**
 * Colour theme and light/dark mode, chosen per person and kept in this
 * browser. The palettes only swap CSS variables (see styles.css), so every
 * screen follows without its own code.
 */
export type ThemeId = 'laith' | 'navy' | 'emerald' | 'royal' | 'graphite' | 'gold';
export type Mode = 'light' | 'dark' | 'auto';
export type Language = 'both' | 'ar' | 'en';

export const THEMES: Array<{ id: ThemeId; ar: string; en: string; swatch: [string, string] }> = [
  { id: 'laith', ar: 'الليث (برتقالي)', en: 'Laith orange', swatch: ['#e15532', '#1d1b1f'] },
  { id: 'navy', ar: 'كحلي', en: 'Navy', swatch: ['#2f6fdf', '#14213d'] },
  { id: 'emerald', ar: 'زمردي', en: 'Emerald', swatch: ['#13956f', '#0f2a24'] },
  { id: 'royal', ar: 'بنفسجي', en: 'Royal', swatch: ['#7a4fd6', '#221a33'] },
  { id: 'graphite', ar: 'رمادي', en: 'Graphite', swatch: ['#5b6675', '#1f2328'] },
  { id: 'gold', ar: 'ذهبي', en: 'Gold', swatch: ['#b8862b', '#231d12'] },
];

const read = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const write = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { /* private window: the choice lasts this visit only */ }
};

export function savedTheme(): ThemeId {
  const value = read('erp.theme');
  return THEMES.some((theme) => theme.id === value) ? value as ThemeId : 'laith';
}
export function savedMode(): Mode {
  const value = read('erp.mode');
  return value === 'dark' || value === 'light' || value === 'auto' ? value : 'light';
}
export function savedLanguage(): Language {
  const value = read('erp.lang');
  return value === 'ar' || value === 'en' || value === 'both' ? value : 'both';
}

export function applyTheme(theme: ThemeId, mode: Mode): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  const dark = mode === 'dark' || (mode === 'auto' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  root.dataset.mode = dark ? 'dark' : 'light';
  write('erp.theme', theme);
  write('erp.mode', mode);
}

export function saveLanguage(language: Language): void {
  write('erp.lang', language);
  document.documentElement.dataset.lang = language;
}

/** Applied before the first paint so a dark-mode user never sees a white flash. */
export function bootTheme(): void {
  applyTheme(savedTheme(), savedMode());
  document.documentElement.dataset.lang = savedLanguage();
}
