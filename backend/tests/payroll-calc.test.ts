import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTENDANCE_RULES, DEFAULT_PAYROLL_RULES, PayrollRulesSetting } from '../src/config/systemSettings';
import { AttendanceTotals, calculatePayslip, PayslipInput } from '../src/services/payrollCalc';

const BASIC = '30000000-0000-4000-8000-000000000001';
const COMMISSION = '30000000-0000-4000-8000-000000000004';
const ABSENCE = '30000000-0000-4000-8000-000000000007';
const ADVANCE = '30000000-0000-4000-8000-000000000010';
const OVERTIME = '30000000-0000-4000-8000-000000000012';
const LATE = '30000000-0000-4000-8000-000000000013';

const untracked: AttendanceTotals = {
  tracked: false, scheduledDays: 0, presentDays: 0, absentDays: 0, unpaidLeaveDays: 0, incompleteDays: 0,
  lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, standardDailyMinutes: 450,
};

function withComponents(active: string[]): PayrollRulesSetting {
  return {
    ...DEFAULT_PAYROLL_RULES,
    components: DEFAULT_PAYROLL_RULES.components.map((component) =>
      (active.includes(component.id) ? { ...component, active: true } : component)),
  };
}

function slip(overrides: Partial<PayslipInput>) {
  return calculatePayslip({
    periodStart: '2026-10-01', periodEnd: '2026-10-31', employmentType: 'permanent',
    hireDate: '2020-01-01', terminationDate: null,
    compensation: [{ effectiveFrom: '2020-01-01', grossSalary: 1200000, componentOverrides: {} }],
    rules: DEFAULT_PAYROLL_RULES, attendanceRules: DEFAULT_ATTENDANCE_RULES, attendance: untracked, inputs: [],
    ...overrides,
  });
}

const amount = (items: Array<{ componentId: string; amount: number }>, id: string) =>
  items.find((item) => item.componentId === id)?.amount;

describe('payroll calculation', () => {
  it('splits a full month into the configured components', () => {
    const result = slip({});
    expect(result.earnings.map((item) => item.amount)).toEqual([600000, 300000, 300000]);
    expect(result).toMatchObject({ totalEarnings: 1200000, totalDeductions: 0, netPay: 1200000, warnings: [] });
  });

  it('deducts absence and unpaid leave at gross / 30 per day', () => {
    const result = slip({ attendance: { ...untracked, tracked: true, presentDays: 24, absentDays: 2, unpaidLeaveDays: 1 } });
    expect(amount(result.deductions, ABSENCE)).toBe(120000);
    expect(result.netPay).toBe(1080000);
  });

  it('deducts approved unpaid leave even when attendance is not tracked', () => {
    const result = slip({ attendance: { ...untracked, unpaidLeaveDays: 3, absentDays: 5 } });
    // Absences are ignored without tracking; the three unpaid leave days are not.
    expect(amount(result.deductions, ABSENCE)).toBe(120000);
  });

  it('pays a joiner for the days employed over 30', () => {
    const result = slip({ hireDate: '2026-10-21' });
    expect(result.employedDays).toBe(11);
    expect(result.totalEarnings).toBe(440000);
  });

  it('weights a raise inside the month by the days each salary applied', () => {
    const result = slip({
      compensation: [
        { effectiveFrom: '2020-01-01', grossSalary: 1000000, componentOverrides: {} },
        { effectiveFrom: '2026-10-16', grossSalary: 1310000, componentOverrides: {} },
      ],
    });
    expect(result.grossSalary).toBe(1160000);
    expect(result.totalEarnings).toBe(1160000);
  });

  it('pays overtime and deducts late minutes beyond the monthly allowance', () => {
    const result = slip({
      rules: withComponents([OVERTIME, LATE]),
      attendanceRules: { ...DEFAULT_ATTENDANCE_RULES, lateMonthlyAllowanceMinutes: 60 },
      attendance: { ...untracked, tracked: true, presentDays: 26, overtimeMinutes: 600, lateMinutes: 90, earlyLeaveMinutes: 30 },
    });
    // Hourly rate = (1,200,000 / 30) / 7.5h = 5,333.33…; 10 h × 1.5 = 80,000.
    expect(amount(result.earnings, OVERTIME)).toBe(80000);
    // 60 chargeable minutes × 88.888… = 5,333.33.
    expect(amount(result.deductions, LATE)).toBe(5333.33);
  });

  it('adds variable inputs such as commission and advances', () => {
    const result = slip({ inputs: [{ componentId: COMMISSION, amount: 150000 }, { componentId: ADVANCE, amount: 200000 }] });
    expect(amount(result.earnings, COMMISSION)).toBe(150000);
    expect(amount(result.deductions, ADVANCE)).toBe(200000);
    expect(result.netPay).toBe(1150000);
  });

  it('applies fixed component amounts from the salary record', () => {
    const result = slip({
      compensation: [{ effectiveFrom: '2020-01-01', grossSalary: 1200000, componentOverrides: { [BASIC]: 700000 } }],
    });
    expect(amount(result.earnings, BASIC)).toBe(700000);
  });

  it('pays daily-wage staff for days present and blocks them when attendance is missing', () => {
    const daily = slip({
      employmentType: 'daily',
      compensation: [{ effectiveFrom: '2020-01-01', grossSalary: 25000, componentOverrides: {} }],
      attendance: { ...untracked, tracked: true, presentDays: 20, absentDays: 6 },
      rules: withComponents([ABSENCE]),
    });
    expect(daily.totalEarnings).toBe(500000);
    expect(daily.totalDeductions).toBe(0);
    const blocked = slip({ employmentType: 'daily', compensation: [{ effectiveFrom: '2020-01-01', grossSalary: 25000, componentOverrides: {} }] });
    expect(blocked.warnings).toContainEqual({ code: 'daily_without_attendance', blocking: true });
  });

  it('flags a negative net pay as blocking and a missing salary as a warning', () => {
    const negative = slip({
      compensation: [{ effectiveFrom: '2020-01-01', grossSalary: 100000, componentOverrides: {} }],
      inputs: [{ componentId: ADVANCE, amount: 500000 }],
    });
    expect(negative.warnings).toContainEqual({ code: 'net_negative', blocking: true });
    expect(slip({ compensation: [] }).warnings[0].code).toBe('no_salary');
  });

  it('pays nothing for days before the first salary record and says so', () => {
    const result = slip({ compensation: [{ effectiveFrom: '2026-10-11', grossSalary: 1200000, componentOverrides: {} }] });
    expect(result.warnings).toContainEqual({ code: 'partial_salary', blocking: false, detail: '10' });
  });
});
