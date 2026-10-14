import type { EmploymentType } from '../models';
import {
  AttendanceRulesSetting, PayrollComponentSetting, PayrollRulesSetting, basicComponentId,
} from '../config/systemSettings';
import { eachDate } from './attendanceRules';

/**
 * Pure payslip arithmetic. Everything the calculation depends on is passed in,
 * so a payslip can be reproduced and tested without a database.
 *
 * Conventions (configurable through payroll settings):
 * - Daily rate = monthly gross / monthlyDivisor (30 by default).
 * - Full period employed → full gross. Partial period (joiner/leaver) →
 *   gross × employed days / monthlyDivisor, capped at the full gross.
 * - Salary changes inside the period are weighted by the days each applied.
 * - Daily-wage employees are paid wage × days present.
 */

export interface CompensationSegment {
  effectiveFrom: string;
  grossSalary: number;
  componentOverrides: Record<string, number>;
}

export interface AttendanceTotals {
  tracked: boolean;
  scheduledDays: number;
  presentDays: number;
  absentDays: number;
  unpaidLeaveDays: number;
  incompleteDays: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  /** Paid minutes in a standard working day, from the employee's shift. */
  standardDailyMinutes: number;
}

export interface PayslipInput {
  periodStart: string;
  periodEnd: string;
  employmentType: EmploymentType;
  hireDate: string;
  terminationDate: string | null;
  compensation: CompensationSegment[];
  rules: PayrollRulesSetting;
  attendanceRules: AttendanceRulesSetting;
  attendance: AttendanceTotals;
  inputs: Array<{ componentId: string; amount: number }>;
}

export interface PayslipItem {
  componentId: string;
  name: string;
  amount: number;
  basis: string;
}

export type WarningCode =
  | 'no_salary' | 'partial_salary' | 'incomplete_days' | 'net_negative' | 'daily_without_attendance'
  | 'earnings_below_gross' | 'component_needs_attendance';

export interface PayslipWarning {
  code: WarningCode;
  blocking: boolean;
  detail?: string;
}

export interface Payslip {
  grossSalary: number;
  periodDays: number;
  employedDays: number;
  earnings: PayslipItem[];
  deductions: PayslipItem[];
  totalEarnings: number;
  totalDeductions: number;
  netPay: number;
  warnings: PayslipWarning[];
}

function rounder(digits: number) {
  const factor = 10 ** digits;
  return (value: number) => Math.round((value + Number.EPSILON) * factor) / factor;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function calculatePayslip(input: PayslipInput): Payslip {
  const { rules, attendance } = input;
  const round = rounder(rules.roundingDigits);
  const divisor = rules.monthlyDivisor;
  const warnings: PayslipWarning[] = [];

  const periodDates = eachDate(input.periodStart, input.periodEnd);
  const employedDates = periodDates.filter((date) =>
    date >= input.hireDate && (!input.terminationDate || date <= input.terminationDate));
  const employedDays = employedDates.length;

  const segments = [...input.compensation].sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));
  const salaryOn = (date: string) => [...segments].reverse().find((segment) => segment.effectiveFrom <= date);
  let weighted = 0;
  let unpaidDays = 0;
  for (const date of employedDates) {
    const segment = salaryOn(date);
    if (segment) weighted += segment.grossSalary;
    else unpaidDays += 1;
  }
  const latest = salaryOn(input.periodEnd) ?? segments[segments.length - 1];
  if (!segments.length || unpaidDays === employedDays) {
    return {
      grossSalary: 0, periodDays: periodDates.length, employedDays, earnings: [], deductions: [],
      totalEarnings: 0, totalDeductions: 0, netPay: 0,
      warnings: [{ code: 'no_salary', blocking: false }],
    };
  }
  if (unpaidDays) warnings.push({ code: 'partial_salary', blocking: false, detail: `${unpaidDays}` });

  const averageGross = employedDays ? weighted / employedDays : 0;
  const isDaily = input.employmentType === 'daily';
  const factor = employedDays === periodDates.length ? 1 : Math.min(1, employedDays / divisor);
  const dailyRate = isDaily ? averageGross : averageGross / divisor;
  const minuteRate = dailyRate / Math.max(1, attendance.standardDailyMinutes);

  let periodGross: number;
  if (isDaily) {
    if (!attendance.tracked) {
      warnings.push({ code: 'daily_without_attendance', blocking: true });
      periodGross = 0;
    } else {
      periodGross = averageGross * attendance.presentDays;
    }
  } else {
    periodGross = averageGross * factor;
  }
  if (attendance.tracked && attendance.incompleteDays) {
    warnings.push({ code: 'incomplete_days', blocking: false, detail: `${attendance.incompleteDays}` });
  }

  const overrides = latest?.componentOverrides ?? {};
  const inputsFor = (componentId: string) => input.inputs
    .filter((item) => item.componentId === componentId)
    .reduce((sum, item) => sum + item.amount, 0);
  const active = rules.components.filter((component) => component.active);
  const basicId = basicComponentId(rules);

  const amountFor = (component: PayrollComponentSetting, basicAmount: number): { amount: number; basis: string } | null => {
    const override = overrides[component.id];
    switch (component.calculation) {
      case 'percentage_of_gross':
        if (override !== undefined) return { amount: override * (isDaily ? 1 : factor), basis: 'مبلغ ثابت' };
        return { amount: periodGross * component.rate / 100, basis: `${formatNumber(component.rate)}% من الإجمالي` };
      case 'percentage_of_basic':
        if (override !== undefined) return { amount: override * (isDaily ? 1 : factor), basis: 'مبلغ ثابت' };
        return { amount: basicAmount * component.rate / 100, basis: `${formatNumber(component.rate)}% من الأساسي` };
      case 'manual': {
        const amount = inputsFor(component.id) + (override ?? 0) * (isDaily ? 1 : factor);
        return amount ? { amount, basis: 'إدخال' } : null;
      }
      case 'per_day': {
        if (component.category === 'deduction') {
          if (isDaily) return null;
          // Unpaid leave comes from approved requests, so it applies with or without attendance tracking.
          const days = (attendance.tracked ? attendance.absentDays : 0) + attendance.unpaidLeaveDays;
          return days ? { amount: days * dailyRate * component.rate, basis: `${days} يوم` } : null;
        }
        if (!attendance.tracked) return null;
        const days = attendance.presentDays;
        return days ? { amount: days * dailyRate * component.rate, basis: `${days} يوم حضور` } : null;
      }
      case 'per_late_minute': {
        if (!attendance.tracked) return null;
        const minutes = Math.max(
          0,
          attendance.lateMinutes + attendance.earlyLeaveMinutes - input.attendanceRules.lateMonthlyAllowanceMinutes,
        );
        return minutes ? { amount: minutes * minuteRate * component.rate, basis: `${minutes} دقيقة` } : null;
      }
      case 'per_overtime_hour': {
        if (!attendance.tracked) return null;
        const hours = attendance.overtimeMinutes / 60;
        return hours ? { amount: hours * minuteRate * 60 * component.rate, basis: `${formatNumber(Math.round(hours * 100) / 100)} ساعة × ${formatNumber(component.rate)}` } : null;
      }
      default:
        return null;
    }
  };

  // Basic salary first, since other components may be a percentage of it.
  const basicComponent = active.find((component) => component.id === basicId && component.category === 'earning');
  const basic = basicComponent ? amountFor(basicComponent, 0) : null;
  const basicAmount = basic ? round(basic.amount) : 0;

  const earnings: PayslipItem[] = [];
  const deductions: PayslipItem[] = [];
  for (const component of active) {
    const result = component.id === basicComponent?.id ? basic : amountFor(component, basicAmount);
    if (!result) continue;
    const amount = round(result.amount);
    if (amount === 0 && component.calculation !== 'percentage_of_gross') continue;
    const item = { componentId: component.id, name: component.name, amount, basis: result.basis };
    (component.category === 'earning' ? earnings : deductions).push(item);
  }

  if (!attendance.tracked) {
    const needsAttendance = active.filter((component) =>
      ['per_late_minute', 'per_overtime_hour'].includes(component.calculation));
    if (needsAttendance.length && !isDaily) {
      warnings.push({ code: 'component_needs_attendance', blocking: false, detail: needsAttendance.map((item) => item.name).join('، ') });
    }
  }

  const totalEarnings = round(earnings.reduce((sum, item) => sum + item.amount, 0));
  const totalDeductions = round(deductions.reduce((sum, item) => sum + item.amount, 0));
  const netPay = round(totalEarnings - totalDeductions);
  const grossShare = earnings
    .filter((item) => active.find((component) => component.id === item.componentId)?.calculation === 'percentage_of_gross')
    .reduce((sum, item) => sum + item.amount, 0);
  if (periodGross > 0 && grossShare + 0.5 < round(periodGross) && Object.keys(overrides).length === 0) {
    warnings.push({ code: 'earnings_below_gross', blocking: false, detail: formatNumber(round(periodGross - grossShare)) });
  }
  if (netPay < 0) warnings.push({ code: 'net_negative', blocking: true });

  return {
    grossSalary: round(averageGross),
    periodDays: periodDates.length,
    employedDays,
    earnings,
    deductions,
    totalEarnings,
    totalDeductions,
    netPay,
    warnings,
  };
}
