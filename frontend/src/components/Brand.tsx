import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Language, Mode, THEMES, ThemeId, applyTheme, saveLanguage, savedLanguage, savedMode, savedTheme } from '../lib/theme';

export const SYSTEM_NAME = {
  ar: 'نظام ERP مجموعة الليث العبيدي للسيارات في العراق',
  en: 'Al-Laith Al-Obaidi Automotive Group — Iraq ERP',
};

export const DEVELOPER = {
  ar: 'بناء وإعداد وتطوير: السيد أوس فراس الشلال — مدير الموارد البشرية للعراق',
  en: 'Built, prepared & developed by Mr. Aws Firas Al-Shalal — HR Manager, Iraq',
  short: 'بناء وإعداد وتطوير: أوس فراس الشلال',
};

export interface BrandItem { id: string; name: string; logo: string | null }

/** The group's brands in order (ROX first, MULTI-BRAND last); logos are the files the owner uploaded. */
export const GROUP_BRANDS: BrandItem[] = [
  { id: 'rox', name: 'ROX', logo: null }, { id: 'dongfeng', name: 'DONGFENG', logo: null },
  { id: 'forthing', name: 'FORTHING', logo: null }, { id: 'gm', name: 'GENERAL MOTORS', logo: null },
  { id: 'multibrand', name: 'MULTI-BRAND', logo: null },
];

let brandCache: Promise<BrandItem[]> | null = null;
const listeners = new Set<(brands: BrandItem[]) => void>();

/** Loads the brand list once (no sign-in needed); the owner page refreshes it after an upload. */
export function refreshBrands(): void {
  brandCache = fetch('/api/public/branding').then((response) => response.json())
    .then((result) => (Array.isArray(result?.data?.brands) ? result.data.brands as BrandItem[] : GROUP_BRANDS))
    .catch(() => GROUP_BRANDS);
  void brandCache.then((brands) => listeners.forEach((listener) => listener(brands)));
}

export function useBrands(): BrandItem[] {
  const [brands, setBrands] = useState<BrandItem[]>(GROUP_BRANDS);
  useEffect(() => {
    if (!brandCache) refreshBrands();
    let live = true;
    void brandCache!.then((value) => { if (live) setBrands(value); });
    listeners.add(setBrands);
    return () => { live = false; listeners.delete(setBrands); };
  }, []);
  return brands;
}

export function BrandStrip({ tone = 'default' }: { tone?: 'default' | 'light' }) {
  const brands = useBrands();
  return (
    <ul className={`brand-strip brand-strip-${tone}`} aria-label="علامات المجموعة · Group brands">
      {brands.map((brand) => <li key={brand.id} className={brand.logo ? 'has-logo' : ''}>
        {brand.logo && <img src={brand.logo} alt="" loading="lazy" />}<span>{brand.name}</span>
      </li>)}
    </ul>
  );
}

export function DeveloperCredit({ compact = false }: { compact?: boolean }) {
  return (
    <p className={`developer-credit ${compact ? 'developer-credit-compact' : ''}`}>
      <span>{DEVELOPER.ar}</span>
      <span dir="ltr">{DEVELOPER.en}</span>
    </p>
  );
}

/** Label in Arabic with its English beside it, following the person's language choice. */
export function Bi({ ar, en, block = false }: { ar: string; en?: string; block?: boolean }) {
  if (!en) return <>{ar}</>;
  return (
    <span className={`bi ${block ? 'bi-block' : ''}`}>
      <span className="bi-ar">{ar}</span>
      <span className="bi-en" dir="ltr">{en}</span>
    </span>
  );
}

/** Colour, light/dark and language controls for the user menu. */
export function AppearanceControls() {
  const [theme, setTheme] = useState<ThemeId>(savedTheme);
  const [mode, setMode] = useState<Mode>(savedMode);
  const [language, setLanguage] = useState<Language>(savedLanguage);
  const pickTheme = (next: ThemeId) => { setTheme(next); applyTheme(next, mode); };
  const pickMode = (next: Mode) => { setMode(next); applyTheme(theme, next); };
  const pickLanguage = (next: Language) => { setLanguage(next); saveLanguage(next); };
  return (
    <div className="appearance">
      <span className="appearance-label">الألوان · Colours</span>
      <div className="swatches">
        {THEMES.map((item) => <button key={item.id} type="button" className={`swatch ${theme === item.id ? 'is-on' : ''}`} title={`${item.ar} · ${item.en}`}
          aria-label={`${item.ar} · ${item.en}`} aria-pressed={theme === item.id} onClick={() => pickTheme(item.id)}>
          <span style={{ background: item.swatch[0] }} /><span style={{ background: item.swatch[1] }} />
        </button>)}
      </div>
      <span className="appearance-label">الوضع · Mode</span>
      <div className="segmented">
        <button type="button" aria-pressed={mode === 'light'} onClick={() => pickMode('light')}><Sun size={14} />فاتح</button>
        <button type="button" aria-pressed={mode === 'dark'} onClick={() => pickMode('dark')}><Moon size={14} />داكن</button>
        <button type="button" aria-pressed={mode === 'auto'} onClick={() => pickMode('auto')}><Monitor size={14} />تلقائي</button>
      </div>
      <span className="appearance-label">اللغة · Language</span>
      <div className="segmented">
        <button type="button" aria-pressed={language === 'both'} onClick={() => pickLanguage('both')}>عربي + EN</button>
        <button type="button" aria-pressed={language === 'ar'} onClick={() => pickLanguage('ar')}>عربي</button>
        <button type="button" aria-pressed={language === 'en'} onClick={() => pickLanguage('en')}>English</button>
      </div>
    </div>
  );
}
