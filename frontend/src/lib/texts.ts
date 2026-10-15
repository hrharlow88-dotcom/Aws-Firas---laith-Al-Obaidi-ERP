/**
 * Texts the system owner rewrote (system name, login page lines, app and
 * menu names). Keys are either a fixed id ("system.name", "login.tagline"…)
 * or the original Arabic label of an app or menu.
 */
export interface TextOverride { ar: string; en?: string }

let overrides: Record<string, TextOverride> = {};

export function setTextOverrides(next: Record<string, TextOverride> | undefined | null): void {
  overrides = next ?? {};
}

export function textOverride(key: string): TextOverride | undefined {
  const value = overrides[key];
  return value && value.ar ? value : undefined;
}

/** Arabic text with the owner's override. */
export function tAr(key: string, fallback: string): string {
  return textOverride(key)?.ar ?? fallback;
}

/** English text with the owner's override. */
export function tEn(key: string, fallback: string): string {
  const value = overrides[key];
  return value && value.en !== undefined && value.en !== '' ? value.en : fallback;
}

/** Fixed texts the owner can rewrite from the owner console, with their defaults. */
export const EDITABLE_TEXTS: Array<{ key: string; label: string; ar: string; en: string; long?: boolean }> = [
  { key: 'system.name', label: 'اسم النظام', ar: 'نظام ERP مجموعة الليث العبيدي للسيارات في العراق', en: 'Al-Laith Al-Obaidi Automotive Group — Iraq ERP' },
  { key: 'login.tagline', label: 'وصف النظام في شاشة الدخول', ar: 'الموظفون والحضور والرواتب والتوظيف والمالية في منصة واحدة، مرتبطة بـ SAP Business One.', en: 'People, attendance, payroll, recruitment and finance on one platform, linked to SAP Business One.', long: true },
  { key: 'login.heading', label: 'عنوان نموذج الدخول', ar: 'تسجيل الدخول', en: 'Sign in' },
  { key: 'login.subtitle', label: 'السطر تحت عنوان الدخول', ar: 'أدخل بيانات حسابك للوصول إلى مساحة العمل.', en: 'Enter your account details to reach your workspace.' },
  { key: 'login.button', label: 'زر الدخول', ar: 'دخول آمن', en: 'Secure sign-in' },
  { key: 'login.security', label: 'ملاحظة الأمان أسفل الدخول', ar: 'الجلسة تنتهي تلقائياً عند عدم النشاط، ويُسجَّل وقت الدخول ومكانه لحمايتك.', en: 'Sessions close when idle; sign-in time and place are recorded to protect you.', long: true },
  { key: 'home.greeting', label: 'تحية الشاشة الرئيسية', ar: 'أهلاً بك', en: 'Welcome' },
];
