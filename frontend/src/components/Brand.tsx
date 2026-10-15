import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { Language, Mode, THEMES, ThemeId, applyTheme, saveLanguage, savedLanguage, savedMode, savedTheme } from '../lib/theme';

export const SYSTEM_NAME = {
  ar: 'نظام ERP مجموعة الليث العبيدي للسيارات في العراق',
  en: 'Al-Laith Al-Obaidi Automotive Group — Iraq ERP',
};

export const DEVELOPER = {
  ar: 'تطوير وإعداد: السيد أوس فراس الشلال — مدير الموارد البشرية للعراق',
  en: 'Developed & prepared by Mr. Aws Firas Al-Shalal — HR Manager, Iraq',
};

/** The group's brands, written as names (no third-party logos are reproduced). */
export const GROUP_BRANDS = ['ROX', 'DONGFENG', 'FORTHING', 'GENERAL MOTORS', 'MULTI-BRAND'];

export function BrandStrip({ tone = 'default' }: { tone?: 'default' | 'light' }) {
  return (
    <ul className={`brand-strip brand-strip-${tone}`} aria-label="علامات المجموعة · Group brands">
      {GROUP_BRANDS.map((brand) => <li key={brand}>{brand}</li>)}
    </ul>
  );
}

export function DeveloperCredit() {
  return (
    <p className="developer-credit">
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
