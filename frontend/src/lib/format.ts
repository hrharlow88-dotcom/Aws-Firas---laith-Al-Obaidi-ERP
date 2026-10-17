export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('ar-IQ-u-nu-latn', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
}

export function formatMoney(value: number | null | undefined, currency = 'IQD'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const digits = currency === 'IQD' ? 0 : 2;
  return `${new Intl.NumberFormat('ar-IQ-u-nu-latn', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)} ${currencyLabel(currency)}`;
}

export function currencyLabel(currency: string): string {
  return ({ IQD: 'د.ع', USD: '$' } as Record<string, string>)[currency] ?? currency;
}

export function formatMinutes(minutes: number | null | undefined): string {
  if (!minutes) return '—';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${formatNumber(rest)} د`;
  return rest ? `${formatNumber(hours)} س ${formatNumber(rest)} د` : `${formatNumber(hours)} س`;
}

export function monthLabel(period: string): string {
  const [year, month] = period.split('-').map(Number);
  return new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
}

/** Today's date in Baghdad as YYYY-MM-DD. */
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date());
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function currentPeriod(): string {
  return today().slice(0, 7);
}

export function previousPeriod(): string {
  const [year, month] = currentPeriod().split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return date.toISOString().slice(0, 7);
}

export function periodRange(period: string): { from: string; to: string } {
  const [year, month] = period.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}

export const WEEKDAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export const EMPLOYMENT_TYPES: Record<string, string> = {
  permanent: 'دائم',
  fixed_term: 'عقد محدد المدة',
  probation: 'فترة تجربة',
  daily: 'أجر يومي',
  part_time: 'دوام جزئي',
  contractor: 'متعاقد / استشاري',
};

export const DOCUMENT_TYPES: Record<string, string> = {
  national_id: 'البطاقة الوطنية',
  residence_card: 'بطاقة السكن',
  passport: 'جواز السفر',
  residency_permit: 'الإقامة',
  visa: 'الفيزا / سمة الدخول',
  driving_license: 'إجازة السوق',
  contract: 'عقد العمل',
  cv: 'السيرة الذاتية',
  certificate: 'شهادة دراسية / خبرة',
  medical: 'تقرير طبي',
  photo: 'الصورة الشخصية',
  other: 'مستند آخر',
};

export const DAY_STATUS: Record<string, { label: string; tone: string }> = {
  present: { label: 'حاضر', tone: 'good' },
  absent: { label: 'غائب', tone: 'bad' },
  leave: { label: 'إجازة', tone: 'info' },
  unpaid_leave: { label: 'إجازة بدون راتب', tone: 'warn' },
  holiday: { label: 'عطلة رسمية', tone: 'muted' },
  weekend: { label: 'عطلة أسبوعية', tone: 'muted' },
  incomplete: { label: 'بصمة ناقصة', tone: 'warn' },
  not_employed: { label: 'خارج الخدمة', tone: 'muted' },
};

export const RUN_STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: 'مسودة', tone: 'muted' },
  calculated: { label: 'محتسب - بانتظار الاعتماد', tone: 'warn' },
  approved: { label: 'معتمد', tone: 'good' },
  posted: { label: 'مرحّل إلى المالية', tone: 'info' },
  cancelled: { label: 'ملغى', tone: 'bad' },
};

export const JOURNAL_STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: 'مسودة', tone: 'muted' },
  queued: { label: 'في طابور الترحيل', tone: 'warn' },
  posting: { label: 'جارٍ الترحيل', tone: 'warn' },
  posted: { label: 'مرحّل إلى SAP', tone: 'good' },
  failed: { label: 'فشل الترحيل', tone: 'bad' },
  cancelled: { label: 'ملغى', tone: 'muted' },
};

export const WARNING_LABELS: Record<string, string> = {
  no_salary: 'لا يوجد راتب مسجل',
  partial_salary: 'لا يوجد راتب لبعض أيام الشهر',
  incomplete_days: 'أيام ببصمة ناقصة',
  net_negative: 'الصافي بالسالب',
  daily_without_attendance: 'أجر يومي بلا حضور',
  earnings_below_gross: 'المكونات أقل من الراتب الكلي',
  component_needs_attendance: 'مكونات تتطلب الحضور',
};
