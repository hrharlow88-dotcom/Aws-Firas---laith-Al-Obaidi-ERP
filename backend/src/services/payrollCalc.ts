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
  /** Salary declared on the social security platform; null when not registered. */
  socialSecurityBase?: number | null;
}

/** Days HR set by hand for the month (staff without fingerprint tracking). */
export interface DayAdjustment {
  /** Days the salary is paid for, out of the monthly divisor. Null keeps the calendar rule. */
  payableDays: number | null;
  /** Absence, lateness or missing punches charged at the daily rate. */
  absenceDays: number;
}

export interface OpenLoan {
  loanId: string;
  installment: number;
  /** Still owed before this month's deduction. */
  remaining: number;
  /**
   * True when this is the last agreed instalment. It then clears the balance
   * (the rounding left by equal instalments), but only when what is left is
   * less than two instalments; a larger balance means the plan was changed and
   * the normal instalment applies.
   */
  final?: boolean;
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
  /** Days of pay charged by the company's per-day lateness tiers. */
  lateTierDays?: number;
}

/** Highest tier each late day reaches, summed over the month. */
export function lateTierDays(lateMinutesPerDay: number[], tiers: Array<{ minutes: number; days: number }> | undefined): number {
  if (!tiers?.length) return 0;
  const sorted = [...tiers].sort((a, b) => b.minutes - a.minutes);
  return Math.round(lateMinutesPerDay.reduce((total, minutes) => total + (sorted.find((tier) => minutes >= tier.minutes)?.days ?? 0), 0) * 1000) / 1000;
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
  adjustment?: DayAdjustment | null;
  loans?: OpenLoan[];
}

export interface PayslipItem {
  componentId: string;
  name: string;
  amount: number;
  basis: string;
}

export type WarningCode =
  | 'no_salary' | 'partial_salary' | 'incomplete_days' | 'net_negative' | 'daily_without_attendance'
  | 'earnings_below_gross' | 'component_needs_attendance' | 'loan_capped';

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
  payableDays: number | null;
  socialSecurityBase: number | null;
  loanRepayments: Array<{ loanId: string; amount: number }>;
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
  const adjustment = input.adjustment ?? null;

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
  const empty = (code: WarningCode): Payslip => ({
    grossSalary: 0, periodDays: periodDates.length, employedDays, earnings: [], deductions: [],
    totalEarnings: 0, totalDeductions: 0, netPay: 0, payableDays: null, socialSecurityBase: null, loanRepayments: [],
    warnings: [{ code, blocking: false }],
  });
  if (!segments.length || unpaidDays === employedDays) return empty('no_salary');
  if (unpaidDays) warnings.push({ code: 'partial_salary', blocking: false, detail: `${unpaidDays}` });

  const averageGross = employedDays ? weighted / employedDays : 0;
  const isDaily = input.employmentType === 'daily';
  const payableDays = !isDaily && adjustment?.payableDays !== null && adjustment?.payableDays !== undefined
    ? adjustment.payableDays
    : null;
  const factor = payableDays !== null
    ? payableDays / divisor
    : employedDays === periodDates.length ? 1 : Math.min(1, employedDays / divisor);
  // The daily rate is rounded before use, as on the payroll sheet (ROUND(gross / 30, 2)).
  const dailyRate = round(isDaily ? averageGross : averageGross / divisor);
  const minuteRate = dailyRate / Math.max(1, attendance.standardDailyMinutes);
  const socialSecurityBase = latest?.socialSecurityBase ?? null;

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
  const scaled = (component: PayrollComponentSetting, amount: number) =>
    (isDaily || component.prorate === false ? amount : amount * factor);

  const amountFor = (component: PayrollComponentSetting, basicAmount: number): { amount: number; basis: string } | null => {
    const override = overrides[component.id];
    switch (component.calculation) {
      case 'percentage_of_gross':
        if (override !== undefined) return { amount: scaled(component, override), basis: 'مبلغ ثابت' };
        return { amount: periodGross * component.rate / 100, basis: `${formatNumber(component.rate)}% من الإجمالي` };
      case 'percentage_of_basic':
        if (override !== undefined) return { amount: scaled(component, override), basis: 'مبلغ ثابت' };
        return { amount: basicAmount * component.rate / 100, basis: `${formatNumber(component.rate)}% من الأساسي` };
      case 'percentage_of_ss_base': {
        // Not prorated: the platform charges the declared salary for any month worked.
        if (!socialSecurityBase) return null;
        const base = Math.min(component.maxBase ?? Infinity, Math.max(component.minBase ?? 0, socialSecurityBase));
        return { amount: rounder(component.roundingDigits ?? rules.roundingDigits)(base * component.rate / 100), basis: `${formatNumber(component.rate)}% من ${formatNumber(base)}` };
      }
      case 'manual': {
        const amount = inputsFor(component.id) + scaled(component, override ?? 0);
        return amount ? { amount, basis: 'إدخال' } : null;
      }
      case 'per_day': {
        if (component.category === 'deduction') {
          if (isDaily) return null;
          // Unpaid leave comes from approved requests, so it applies with or without attendance tracking.
          const days = (attendance.tracked ? attendance.absentDays + (attendance.lateTierDays ?? 0) : 0) +
            attendance.unpaidLeaveDays + (adjustment?.absenceDays ?? 0);
          return days ? { amount: days * dailyRate * component.rate, basis: `${formatNumber(days)} يوم` } : null;
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
        // Loans are settled last, once everything else is known.
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

  // When the gross is split 100% across components, rounding each share can drift
  // a fils from the rounded period gross; the last share absorbs the difference.
  const grossShares = earnings.filter((item) => {
    const component = active.find((entry) => entry.id === item.componentId);
    return component?.calculation === 'percentage_of_gross' && overrides[item.componentId] === undefined;
  });
  const shareRate = active
    .filter((component) => component.category === 'earning' && component.calculation === 'percentage_of_gross')
    .reduce((sum, component) => sum + component.rate, 0);
  if (grossShares.length > 1 && Math.abs(shareRate - 100) < 1e-9) {
    const drift = round(round(periodGross) - grossShares.reduce((sum, item) => sum + item.amount, 0));
    if (drift) grossShares[grossShares.length - 1].amount = round(grossShares[grossShares.length - 1].amount + drift);
  }

  if (!attendance.tracked) {
    const needsAttendance = active.filter((component) =>
      ['per_late_minute', 'per_overtime_hour'].includes(component.calculation));
    if (needsAttendance.length && !isDaily) {
      warnings.push({ code: 'component_needs_attendance', blocking: false, detail: needsAttendance.map((item) => item.name).join('، ') });
    }
  }

  // Loan instalments: never more than what is left after every other deduction.
  const loanRepayments: Array<{ loanId: string; amount: number }> = [];
  const loanComponent = active.find((component) => component.calculation === 'loan_installments');
  if (loanComponent && input.loans?.length) {
    const due = input.loans.map((loan) => ({ loan, amount: round(loan.final && loan.remaining < 2 * loan.installment
      ? loan.remaining
      : Math.min(loan.installment, loan.remaining)) }))
      .filter((item) => item.amount > 0);
    const totalDue = due.reduce((sum, item) => sum + item.amount, 0);
    const available = Math.max(0, round(
      earnings.reduce((sum, item) => sum + item.amount, 0) - deductions.reduce((sum, item) => sum + item.amount, 0),
    ));
    let left = Math.min(totalDue, available);
    for (const item of due) {
      const amount = round(Math.min(item.amount, left));
      if (amount <= 0) break;
      loanRepayments.push({ loanId: item.loan.loanId, amount });
      left = round(left - amount);
    }
    const taken = round(loanRepayments.reduce((sum, item) => sum + item.amount, 0));
    if (taken < round(totalDue)) {
      warnings.push({ code: 'loan_capped', blocking: false, detail: formatNumber(round(totalDue - taken)) });
    }
    if (taken > 0) {
      deductions.push({ componentId: loanComponent.id, name: loanComponent.name, amount: taken, basis: `${loanRepayments.length} سلفة` });
    }
  }

  const totalEarnings = round(earnings.reduce((sum, item) => sum + item.amount, 0));
  const totalDeductions = round(deductions.reduce((sum, item) => sum + item.amount, 0));
  const netPay = round(totalEarnings - totalDeductions);
  const grossShare = grossShares.reduce((sum, item) => sum + item.amount, 0);
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
    payableDays,
    socialSecurityBase,
    loanRepayments,
    warnings,
  };
}
