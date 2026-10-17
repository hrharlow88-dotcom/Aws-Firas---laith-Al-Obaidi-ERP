import { Monitor, Moon, Sun } from 'lucide-react';
import { ReactNode, useEffect, useState } from 'react';
import { setTextOverrides, tAr, tEn, TextOverride } from '../lib/texts';
import { Language, Mode, THEMES, ThemeId, applyTheme, saveLanguage, savedLanguage, savedMode, savedTheme } from '../lib/theme';

const DEFAULT_SYSTEM_NAME = {
  ar: 'نظام ERP مجموعة الليث العبيدي للسيارات في العراق',
  en: 'Al-Laith Al-Obaidi Automotive Group — Iraq ERP',
};

/** The system name, as the owner set it (or the default). */
export const SYSTEM_NAME = {
  get ar() { return tAr('system.name', DEFAULT_SYSTEM_NAME.ar); },
  get en() { return tEn('system.name', DEFAULT_SYSTEM_NAME.en); },
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

export interface CompanyItem { id: string; nameAr: string; nameEn: string | null; logo: string | null }
export interface PublicBranding { brands: BrandItem[]; companies: CompanyItem[]; texts: Record<string, TextOverride>; demo: boolean }
const FALLBACK: PublicBranding = { brands: GROUP_BRANDS, companies: [], texts: {}, demo: false };

let brandCache: Promise<PublicBranding> | null = null;
const listeners = new Set<(value: PublicBranding) => void>();

/** Loads the public branding once (no sign-in needed); the owner pages refresh it after a change. */
export function refreshBrands(): void {
  brandCache = fetch('/api/public/branding').then((response) => response.json())
    .then((result) => ({ ...FALLBACK, ...(result?.data ?? {}) }) as PublicBranding)
    .catch(() => FALLBACK);
  void brandCache.then((value) => {
    setTextOverrides(value.texts);
    listeners.forEach((listener) => listener(value));
  });
}

export function usePublicBranding(): PublicBranding {
  const [value, setValue] = useState<PublicBranding>(FALLBACK);
  useEffect(() => {
    if (!brandCache) refreshBrands();
    let live = true;
    void brandCache!.then((loaded) => { if (live) { setTextOverrides(loaded.texts); setValue(loaded); } });
    listeners.add(setValue);
    return () => { live = false; listeners.delete(setValue); };
  }, []);
  return value;
}

export function useBrands(): BrandItem[] {
  return usePublicBranding().brands;
}

/** Logos of the group's companies (login page and home). */
export function CompanyStrip({ tone = 'default' }: { tone?: 'default' | 'light' }) {
  const companies = usePublicBranding().companies;
  if (!companies.length) return null;
  return (
    <ul className={`company-strip company-strip-${tone}`} aria-label="شركات المجموعة · Group companies">
      {companies.map((company) => <li key={company.id}>{company.logo && <img src={company.logo} alt="" loading="lazy" />}<span>{company.nameAr}{company.nameEn && <small dir="ltr">{company.nameEn}</small>}</span></li>)}
    </ul>
  );
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

const BILINGUAL = /^([^\u0600-\u06FF]*[\u0600-\u06FF][\s\S]*?)\s·\s([A-Za-z][^\u0600-\u06FF]*)$/;

/**
 * Splits a label written as "عربي · English" into its two languages, or
 * returns null when the part after the dot is not English (for instance
 * "أيلول 2026 · كل الفروع", where both parts are Arabic and both matter).
 */
export function splitBilingual(text: string): { ar: string; en: string } | null {
  const match = BILINGUAL.exec(text.trim());
  return match ? { ar: match[1].trim(), en: match[2].trim() } : null;
}

/** A label that may be bilingual: shown in the person's language like <Bi>. */
export function BiText({ text, block = false }: { text: ReactNode; block?: boolean }) {
  if (typeof text !== 'string') return <>{text}</>;
  const parts = splitBilingual(text);
  return parts ? <Bi ar={parts.ar} en={parts.en} block={block} /> : <>{text}</>;
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
      <span className="appearance-label"><Bi ar={"الألوان"} en={"Colours"} /></span>
      <div className="swatches">
        {THEMES.map((item) => <button key={item.id} type="button" className={`swatch ${theme === item.id ? 'is-on' : ''}`} title={`${item.ar} · ${item.en}`}
          aria-label={`${item.ar} · ${item.en}`} aria-pressed={theme === item.id} onClick={() => pickTheme(item.id)}>
          <span style={{ background: item.swatch[0] }} /><span style={{ background: item.swatch[1] }} />
        </button>)}
      </div>
      <span className="appearance-label"><Bi ar={"الوضع"} en={"Mode"} /></span>
      <div className="segmented">
        <button type="button" aria-pressed={mode === 'light'} onClick={() => pickMode('light')}><Sun size={14} />فاتح</button>
        <button type="button" aria-pressed={mode === 'dark'} onClick={() => pickMode('dark')}><Moon size={14} />داكن</button>
        <button type="button" aria-pressed={mode === 'auto'} onClick={() => pickMode('auto')}><Monitor size={14} />تلقائي</button>
      </div>
      <span className="appearance-label"><Bi ar={"اللغة"} en={"Language"} /></span>
      <div className="segmented">
        <button type="button" aria-pressed={language === 'both'} onClick={() => pickLanguage('both')}>عربي + EN</button>
        <button type="button" aria-pressed={language === 'ar'} onClick={() => pickLanguage('ar')}>عربي</button>
        <button type="button" aria-pressed={language === 'en'} onClick={() => pickLanguage('en')}>English</button>
      </div>
    </div>
  );
}
