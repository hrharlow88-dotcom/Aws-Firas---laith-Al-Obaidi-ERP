import type { LeaveTypeSetting } from '../config/systemSettings';

/**
 * Monthly leave accrual — a pure function so the rule can be tested and read
 * on its own.
 *
 * - The yearly entitlement is the leave type's service tier for the completed
 *   years of service at the end of the month (or at termination), otherwise
 *   its annualEntitlement. The company policy (21 days, +2 for every five
 *   years) lives in the leave type settings, not here.
 * - A full month credits entitlement/12. The amount is spread so that twelve
 *   full months add up to exactly the yearly entitlement (23/12 → 1.92 + …
 *   rather than 12 × 1.92 = 23.04).
 * - A month the employee only partly worked (hired or terminated mid-month)
 *   is prorated by calendar days.
 * - Suspended staff and leavers without a termination date accrue nothing;
 *   so do employment types the leave type excludes.
 */

export interface AccrualEmployee {
  hireDate: string;
  terminationDate: string | null;
  employmentStatus: string;
  employmentType: string;
}

export interface AccrualLine {
  days: number;
  entitlement: number;
  serviceYears: number;
  employedDays: number;
  monthDays: number;
  skipReason: string | null;
}

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export function periodBounds(period: string): { start: string; end: string; month: number; days: number } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error(`Invalid period ${period}`);
  const [year, month] = period.split('-').map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${period}-01`, end: `${period}-${String(days).padStart(2, '0')}`, month, days };
}

export function completedYears(hireDate: string, onDate: string): number {
  const [hy, hm, hd] = hireDate.split('-').map(Number);
  const [y, m, d] = onDate.split('-').map(Number);
  let years = y - hy;
  if (m < hm || (m === hm && d < hd)) years -= 1;
  return Math.max(0, years);
}

export function yearlyEntitlement(leaveType: LeaveTypeSetting, serviceYears: number): number {
  const tier = [...(leaveType.serviceEntitlements || [])]
    .sort((a, b) => b.minimumYears - a.minimumYears)
    .find((item) => serviceYears >= item.minimumYears);
  return tier?.days ?? leaveType.annualEntitlement ?? 0;
}

function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

export function monthlyAccrual(period: string, employee: AccrualEmployee, leaveType: LeaveTypeSetting): AccrualLine {
  const bounds = periodBounds(period);
  const skip = (reason: string, entitlement = 0, serviceYears = 0): AccrualLine =>
    ({ days: 0, entitlement, serviceYears, employedDays: 0, monthDays: bounds.days, skipReason: reason });

  const types = leaveType.accrualEmploymentTypes;
  if (types && types.length && !types.includes(employee.employmentType)) return skip('نوع التعاقد غير مشمول');
  if (employee.employmentStatus === 'suspended') return skip('موقوف');
  if (employee.employmentStatus === 'inactive' && !employee.terminationDate) return skip('منتهية خدمته بلا تاريخ انتهاء');

  const start = employee.hireDate > bounds.start ? employee.hireDate : bounds.start;
  const end = employee.terminationDate && employee.terminationDate < bounds.end ? employee.terminationDate : bounds.end;
  if (start > end) return skip(employee.hireDate > bounds.end ? 'لم يباشر بعد' : 'انتهت خدمته قبل الشهر');

  const serviceYears = completedYears(employee.hireDate, end);
  const entitlement = yearlyEntitlement(leaveType, serviceYears);
  const employedDays = dayDiff(start, end);
  const days = employedDays === bounds.days
    ? round2((entitlement * bounds.month) / 12) - round2((entitlement * (bounds.month - 1)) / 12)
    : round2((entitlement / 12) * (employedDays / bounds.days));
  return { days: round2(days), entitlement, serviceYears, employedDays, monthDays: bounds.days, skipReason: null };
}
