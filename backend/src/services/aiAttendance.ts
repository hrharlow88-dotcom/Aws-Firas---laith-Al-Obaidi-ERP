import { AttendanceRulesSetting, SystemSettings } from '../config/systemSettings';
import { askJson } from './ai';

/** What the assistant may change: attendance rules, the three attendance pay components, shift grace and hourly leave. */
export interface AttendanceProposal {
  attendanceRules?: Partial<AttendanceRulesSetting>;
  components?: {
    absence?: { active?: boolean; rate?: number };
    lateMinute?: { active?: boolean; rate?: number };
    overtime?: { active?: boolean; rate?: number };
  };
  shifts?: { graceMinutes?: number; earlyLeaveGraceMinutes?: number };
  hourly?: { hourlyMonthlyQuota?: number; maxHoursPerRequest?: number };
  summaryAr: string[];
  unsupported: string[];
}

export const COMPONENT_IDS = {
  absence: '30000000-0000-4000-8000-000000000007',
  overtime: '30000000-0000-4000-8000-000000000012',
  lateMinute: '30000000-0000-4000-8000-000000000013',
} as const;

const toLatin = (text: string) => text.replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/٫/g, '.');
const FRACTIONS: Array<[RegExp, number]> = [[/ربع/, 0.25], [/ثلث/, 1 / 3], [/نصف|نص/, 0.5], [/ثلاثة أرباع/, 0.75]];

function dayAmount(text: string): number | null {
  for (const [pattern, value] of FRACTIONS) if (pattern.test(text)) return value;
  const number = text.match(/(\d+(?:\.\d+)?)\s*(?:يوم|أيام|ايام)/);
  if (number) return Number(number[1]);
  if (/يوم/.test(text)) return 1;
  return null;
}

/**
 * Reads plain Arabic instructions sentence by sentence without any AI:
 * lateness tiers ("التأخير أكثر من 30 دقيقة يخصم نصف يوم"), monthly
 * allowance, overtime minimum and rate, grace minutes, absence and hourly leave.
 */
export function parseInstructions(raw: string): AttendanceProposal {
  const proposal: AttendanceProposal = { summaryAr: [], unsupported: [] };
  const tiers: Array<{ minutes: number; days: number }> = [];
  for (const sentence of toLatin(raw).split(/(?<!\d)\.|\.(?!\d)|[\n،؛;]+/).map((item) => item.trim()).filter(Boolean)) {
    const minutes = sentence.match(/(\d+)\s*(?:دقيقة|دقائق|د\b)/);
    const hours = sentence.match(/(\d+(?:\.\d+)?)\s*(?:ساعة|ساعات)/);
    let used = false;
    if (/تأخ|تاخ/.test(sentence) && minutes && /(يخصم|خصم|يحسب|يستقطع|استقطاع)/.test(sentence) && dayAmount(sentence) !== null) {
      tiers.push({ minutes: Number(minutes[1]), days: dayAmount(sentence)! });
      used = true;
    } else if (/(سماح|مسموح)/.test(sentence) && /شهر/.test(sentence) && minutes) {
      proposal.attendanceRules = { ...proposal.attendanceRules, lateMonthlyAllowanceMinutes: Number(minutes[1]) };
      proposal.summaryAr.push(`سماح شهري بالتأخير ${minutes[1]} دقيقة قبل الخصم بالدقيقة.`);
      used = true;
    } else if (/(سماح|مسموح|إمهال|امهال)/.test(sentence) && minutes && /(خروج|انصراف|مبكر)/.test(sentence)) {
      proposal.shifts = { ...proposal.shifts, earlyLeaveGraceMinutes: Number(minutes[1]) };
      proposal.summaryAr.push(`سماح بالخروج المبكر ${minutes[1]} دقيقة يومياً في كل الدوامات.`);
      used = true;
    } else if (/(سماح|مسموح|إمهال|امهال)/.test(sentence) && minutes) {
      proposal.shifts = { ...proposal.shifts, graceMinutes: Number(minutes[1]) };
      proposal.summaryAr.push(`سماح بالتأخير ${minutes[1]} دقيقة يومياً في كل الدوامات.`);
      used = true;
    }
    if (/(إضافي|اضافي|أوفر|اوفر)/.test(sentence)) {
      if (/(لا يحتسب|لا يحسب|أقل من|اقل من|حد أدنى|حد ادنى)/.test(sentence) && (minutes || hours)) {
        const value = minutes ? Number(minutes[1]) : Math.round(Number(hours![1]) * 60);
        proposal.attendanceRules = { ...proposal.attendanceRules, overtimeMinimumMinutes: value };
        proposal.summaryAr.push(`لا يُحتسب الإضافي إذا كان أقل من ${value} دقيقة في اليوم.`);
        used = true;
      }
      const rate = sentence.match(/(\d+(?:\.\d+)?)\s*(?:مرة|ضعف|×|x|بالمئة|%)/i);
      if (!used && (rate || /(يحتسب|يحسب|يصرف|يدفع)/.test(sentence))) {
        let value = rate ? Number(rate[1]) : 1;
        if (rate && /(بالمئة|%)/.test(rate[0])) value = value / 100;
        proposal.components = { ...proposal.components, overtime: { active: !/(لا يحتسب|لا يحسب|بدون|يلغى|إلغاء)/.test(sentence) || Boolean(rate), rate: value } };
        proposal.summaryAr.push(`العمل الإضافي يُدفع بأجر الساعة × ${value}.`);
        used = true;
      }
    }
    if (/(غياب|غائب)/.test(sentence) && /(يخصم|خصم|يستقطع)/.test(sentence)) {
      const amount = dayAmount(sentence.replace(/غياب/g, '')) ?? 1;
      proposal.components = { ...proposal.components, absence: { active: true, rate: amount } };
      proposal.attendanceRules = { ...proposal.attendanceRules, markAbsentWithoutPunch: true };
      proposal.summaryAr.push(`يوم الغياب بلا بصمة ولا إجازة يُخصم ${amount} يوم أجر.`);
      used = true;
    }
    if (/(دقيقة بدقيقة|بالدقيقة|كل دقيقة)/.test(sentence) && /تأخ|تاخ/.test(sentence)) {
      const rate = sentence.match(/(\d+(?:\.\d+)?)\s*(?:مرة|ضعف|×|x)/i);
      proposal.components = { ...proposal.components, lateMinute: { active: true, rate: rate ? Number(rate[1]) : 1 } };
      proposal.summaryAr.push(`دقائق التأخير تُخصم بأجر الدقيقة × ${rate ? rate[1] : 1}.`);
      used = true;
    }
    if (/(زمنية|زمني|ساعية)/.test(sentence) && hours) {
      if (/(شهر|الشهر|شهرياً|شهريا)/.test(sentence)) {
        proposal.hourly = { ...proposal.hourly, hourlyMonthlyQuota: Number(hours[1]) };
        proposal.summaryAr.push(`رصيد الإجازة الزمنية ${hours[1]} ساعة في الشهر.`);
      } else {
        proposal.hourly = { ...proposal.hourly, maxHoursPerRequest: Number(hours[1]) };
        proposal.summaryAr.push(`أقصى إجازة زمنية في الطلب الواحد ${hours[1]} ساعة.`);
      }
      used = true;
    }
    if (!used) proposal.unsupported.push(sentence);
  }
  if (tiers.length) {
    const sorted = [...new Map(tiers.map((tier) => [tier.minutes, tier])).values()].sort((a, b) => a.minutes - b.minutes);
    proposal.attendanceRules = { ...proposal.attendanceRules, lateDayTiers: sorted };
    for (const tier of sorted) proposal.summaryAr.push(`التأخير ${tier.minutes} دقيقة فأكثر في اليوم يُخصم ${tier.days} يوم.`);
  }
  return proposal;
}

const clamp = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : undefined;

/** Keeps only the fields and ranges the system supports, whatever produced the proposal. */
export function cleanProposal(raw: unknown): AttendanceProposal {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const out: AttendanceProposal = {
    summaryAr: Array.isArray(input.summaryAr) ? input.summaryAr.filter((item: unknown) => typeof item === 'string').map((item: string) => item.slice(0, 300)).slice(0, 30) : [],
    unsupported: Array.isArray(input.unsupported) ? input.unsupported.filter((item: unknown) => typeof item === 'string').map((item: string) => item.slice(0, 300)).slice(0, 30) : [],
  };
  const rules = input.attendanceRules ?? {};
  const cleanRules: Partial<AttendanceRulesSetting> = {};
  const allowance = clamp(rules.lateMonthlyAllowanceMinutes, 0, 600); if (allowance !== undefined) cleanRules.lateMonthlyAllowanceMinutes = Math.round(allowance);
  const overtimeMin = clamp(rules.overtimeMinimumMinutes, 0, 480); if (overtimeMin !== undefined) cleanRules.overtimeMinimumMinutes = Math.round(overtimeMin);
  const dup = clamp(rules.duplicatePunchWindowMinutes, 0, 30); if (dup !== undefined) cleanRules.duplicatePunchWindowMinutes = Math.round(dup);
  if (typeof rules.markAbsentWithoutPunch === 'boolean') cleanRules.markAbsentWithoutPunch = rules.markAbsentWithoutPunch;
  if (Array.isArray(rules.lateDayTiers)) {
    cleanRules.lateDayTiers = rules.lateDayTiers
      .map((tier: Record<string, unknown>) => ({ minutes: clamp(tier?.minutes, 1, 600), days: clamp(tier?.days, 0.05, 3) }))
      .filter((tier: { minutes?: number; days?: number }) => tier.minutes !== undefined && tier.days !== undefined)
      .map((tier: { minutes: number; days: number }) => ({ minutes: Math.round(tier.minutes), days: Math.round(tier.days * 100) / 100 }))
      .slice(0, 10);
  }
  if (Object.keys(cleanRules).length) out.attendanceRules = cleanRules;
  const components = input.components ?? {};
  const cleanComponents: NonNullable<AttendanceProposal['components']> = {};
  for (const key of ['absence', 'lateMinute', 'overtime'] as const) {
    const item = components[key];
    if (!item || typeof item !== 'object') continue;
    const rate = clamp(item.rate, 0, key === 'overtime' ? 5 : 10);
    cleanComponents[key] = { ...(typeof item.active === 'boolean' ? { active: item.active } : {}), ...(rate !== undefined ? { rate: Math.round(rate * 100) / 100 } : {}) };
  }
  if (Object.keys(cleanComponents).length) out.components = cleanComponents;
  const shifts = input.shifts ?? {};
  const grace = clamp(shifts.graceMinutes, 0, 120);
  const early = clamp(shifts.earlyLeaveGraceMinutes, 0, 120);
  if (grace !== undefined || early !== undefined) out.shifts = { ...(grace !== undefined ? { graceMinutes: Math.round(grace) } : {}), ...(early !== undefined ? { earlyLeaveGraceMinutes: Math.round(early) } : {}) };
  const hourly = input.hourly ?? {};
  const quota = clamp(hourly.hourlyMonthlyQuota, 0, 744);
  const perRequest = clamp(hourly.maxHoursPerRequest, 0.5, 24);
  if (quota !== undefined || perRequest !== undefined) out.hourly = { ...(quota !== undefined ? { hourlyMonthlyQuota: quota } : {}), ...(perRequest !== undefined ? { maxHoursPerRequest: perRequest } : {}) };
  return out;
}

const SYSTEM = `You convert a company owner's Arabic instructions about attendance into a JSON change set for an HR system in Iraq.
Return ONLY a JSON object with these optional keys:
- attendanceRules: { lateMonthlyAllowanceMinutes (int), overtimeMinimumMinutes (int), duplicatePunchWindowMinutes (int), markAbsentWithoutPunch (bool), lateDayTiers: [{ minutes (int, lateness that day at least), days (number of days' pay deducted) }] }
- components: { absence: { active, rate = days of pay per absent day }, lateMinute: { active, rate = multiple of the minute wage per late minute }, overtime: { active, rate = multiple of the hourly wage per overtime hour } }
- shifts: { graceMinutes (daily late grace for all shifts), earlyLeaveGraceMinutes }
- hourly: { hourlyMonthlyQuota (hours per month of hourly leave), maxHoursPerRequest }
- summaryAr: array of short Arabic sentences describing exactly what will change
- unsupported: array of the instructions (Arabic) the system cannot express with these fields
Never invent rules that were not asked for. Keep the current values for anything not mentioned (omit the key).`;

/** AI when the owner switched it on; otherwise the built-in sentence reader. */
export async function proposeAttendance(instruction: string, settings: SystemSettings, useAi: boolean): Promise<{ engine: 'ai' | 'rules'; proposal: AttendanceProposal }> {
  if (useAi) {
    const current = {
      attendanceRules: settings.attendanceRules,
      components: Object.fromEntries(Object.entries(COMPONENT_IDS).map(([key, id]) => {
        const component = settings.payrollRules.components.find((item) => item.id === id);
        return [key, component ? { active: component.active, rate: component.rate } : null];
      })),
      hourly: { hourlyMonthlyQuota: settings.leaveRules.hourlyMonthlyQuota, maxHoursPerRequest: settings.leaveRules.maxHoursPerRequest },
    };
    const raw = await askJson<unknown>(SYSTEM, `Current settings:\n${JSON.stringify(current)}\n\nInstructions:\n${instruction}`);
    return { engine: 'ai', proposal: cleanProposal(raw) };
  }
  return { engine: 'rules', proposal: cleanProposal(parseInstructions(instruction)) };
}
