import { randomUUID } from 'node:crypto';
import { Transaction } from 'sequelize';
import { execute, select, selectOne } from '../db/query';
import { EmploymentType } from '../models';
import { badRequest } from '../utils/http';
import { computeAttendance, EFFECTIVE_DAY_COLUMNS, loadShifts } from './attendance';
import { eachDate, scheduledMinutes, weekday } from './attendanceRules';
import { AttendanceTotals, calculatePayslip, DayAdjustment, OpenLoan, Payslip } from './payrollCalc';
import { getSettings } from './settings';

export function periodBounds(period: string): { start: string; end: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw badRequest('الفترة يجب أن تكون بصيغة سنة-شهر.');
  const [year, month] = period.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${period}-01`, end: `${period}-${String(last).padStart(2, '0')}` };
}

export interface RunRow {
  id: string;
  period: string;
  startsOn: string;
  endsOn: string;
  branchId: string | null;
  status: 'draft' | 'calculated' | 'approved' | 'posted' | 'cancelled';
  currency: string;
  createdBy: string;
  calculatedBy: string | null;
  approvedBy: string | null;
}

export async function loadRun(id: string, transaction?: Transaction, lock = false): Promise<RunRow | null> {
  return selectOne<RunRow>(
    `SELECT id, period, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn",
            branch_id AS "branchId", status, currency, created_by AS "createdBy",
            calculated_by AS "calculatedBy", approved_by AS "approvedBy"
     FROM payroll_runs WHERE id = :id${lock ? ' FOR UPDATE' : ''}`,
    { id },
    transaction,
  );
}

interface EmployeeForPayroll {
  id: string;
  branchId: string;
  departmentId: string | null;
  costCenterCode: string | null;
  employmentType: EmploymentType;
  hireDate: string;
  terminationDate: string | null;
  shiftId: string | null;
  paymentMethod: string | null;
}

export interface LoanRepaymentDraft {
  loanId: string;
  /** In the loan's currency. */
  amount: number;
  /** In the run's currency. */
  payrollAmount: number;
}

export interface LineDraft extends Omit<Payslip, 'loanRepayments'> {
  loanRepayments: LoanRepaymentDraft[];
  employeeId: string;
  branchId: string;
  departmentId: string | null;
  costCenterCode: string | null;
  currency: string;
  attendance: AttendanceTotals;
  paymentMethod: string;
}

/**
 * Builds every payslip of a run from current data. Employees in another
 * active run of the same period and currency are left to that run, so a
 * company-wide run and a branch run can never pay someone twice.
 */
export async function buildRunLines(run: RunRow, transaction?: Transaction): Promise<LineDraft[]> {
  const settings = await getSettings();
  const employees = await select<EmployeeForPayroll>(
    `SELECT e.id, e.branch_id AS "branchId", e.department_id AS "departmentId", d.cost_center_code AS "costCenterCode",
            e.employment_type AS "employmentType", to_char(e.hire_date, 'YYYY-MM-DD') AS "hireDate",
            to_char(e.termination_date, 'YYYY-MM-DD') AS "terminationDate", e.shift_id AS "shiftId",
            p.payment_method AS "paymentMethod"
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN employee_profiles p ON p.employee_id = e.id
     WHERE e.hire_date <= :end
       AND (e.termination_date IS NULL OR e.termination_date >= :start)
       AND (e.employment_status <> 'inactive' OR e.termination_date IS NOT NULL)
       AND e.employment_status <> 'suspended'
       ${settings.payrollRules.terminatedPaidBySettlement ? 'AND (e.termination_date IS NULL OR e.termination_date > :end)' : ''}
       ${run.branchId ? 'AND e.branch_id = :branchId' : ''}
       AND NOT EXISTS (
         SELECT 1 FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
         WHERE l.employee_id = e.id AND r.period = :period AND r.currency = :currency
           AND r.status <> 'cancelled' AND r.id <> :runId
       )
       AND EXISTS (
         SELECT 1 FROM employee_compensation c WHERE c.employee_id = e.id AND c.currency = :currency AND c.effective_from <= :end
       )
     ORDER BY e.employee_no`,
    { start: run.startsOn, end: run.endsOn, branchId: run.branchId, period: run.period, currency: run.currency, runId: run.id },
    transaction,
  );
  if (!employees.length) return [];
  const ids = employees.map((item) => item.id);

  const compensation = await select<{
    employeeId: string; effectiveFrom: string; grossSalary: number; componentOverrides: Record<string, number>;
    socialSecurityBase: number | null;
  }>(
    `SELECT employee_id AS "employeeId", to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
            gross_salary::float AS "grossSalary", component_overrides AS "componentOverrides",
            social_security_base::float AS "socialSecurityBase"
     FROM employee_compensation
     WHERE employee_id IN (:ids) AND currency = :currency AND effective_from <= :end
     ORDER BY effective_from`,
    { ids, currency: run.currency, end: run.endsOn },
    transaction,
  );

  const days = await select<{
    employeeId: string; status: string; lateMinutes: number; earlyLeaveMinutes: number; overtimeMinutes: number;
  }>(
    `SELECT d.employee_id AS "employeeId", ${EFFECTIVE_DAY_COLUMNS}
     FROM attendance_days d WHERE d.employee_id IN (:ids) AND d.work_date BETWEEN :start AND :end`,
    { ids, start: run.startsOn, end: run.endsOn },
    transaction,
  );

  const inputs = await select<{ employeeId: string; componentId: string; amount: number }>(
    `SELECT employee_id AS "employeeId", component_id AS "componentId", amount::float AS amount
     FROM payroll_inputs WHERE period = :period AND employee_id IN (:ids)`,
    { period: run.period, ids },
    transaction,
  );

  const adjustments = new Map((await select<DayAdjustment & { employeeId: string }>(
    `SELECT employee_id AS "employeeId", payable_days::float AS "payableDays", absence_days::float AS "absenceDays"
     FROM payroll_day_adjustments WHERE period = :period AND employee_id IN (:ids)`,
    { period: run.period, ids },
    transaction,
  )).map((row) => [row.employeeId, row]));

  // What each open loan still owes before this run, counting deductions of
  // earlier runs that were not cancelled.
  const loans = await select<OpenLoan & { employeeId: string; currency: string }>(
    `SELECT l.id AS "loanId", l.employee_id AS "employeeId", l.currency, l.installment::float AS installment,
            (l.principal - l.paid_before - COALESCE(p.amount, 0))::float AS remaining,
            (l.installments_total IS NOT NULL
              AND l.installments_paid_before + COALESCE(p.count, 0) + 1 >= l.installments_total) AS final
     FROM employee_loans l
     LEFT JOIN LATERAL (
       SELECT SUM(rp.amount) AS amount, COUNT(*)::int AS count
       FROM loan_repayments rp JOIN payroll_runs r ON r.id = rp.run_id
       WHERE rp.loan_id = l.id AND rp.run_id <> :runId AND r.status <> 'cancelled' AND r.period <= :period
     ) p ON true
     WHERE l.employee_id IN (:ids) AND l.status = 'active' AND l.start_period <= :period
     ORDER BY l.start_period, l.created_at`,
    { ids, runId: run.id, period: run.period },
    transaction,
  );

  // Untracked employees still lose pay for approved unpaid leave.
  const unpaidTypes = settings.leaveTypes.filter((type) => !type.paid).map((type) => type.id);
  const unpaidLeaves = unpaidTypes.length ? await select<{ employeeId: string; startsOn: string; endsOn: string }>(
    `SELECT employee_id AS "employeeId", to_char(GREATEST(starts_on, :start::date), 'YYYY-MM-DD') AS "startsOn",
            to_char(LEAST(ends_on, :end::date), 'YYYY-MM-DD') AS "endsOn"
     FROM leave_requests
     WHERE employee_id IN (:ids) AND status = 'approved' AND leave_type_id IN (:types)
       AND start_time IS NULL AND starts_on <= :end AND ends_on >= :start`,
    { ids, types: unpaidTypes, start: run.startsOn, end: run.endsOn },
    transaction,
  ) : [];
  const workingDays = new Set(settings.leaveRules.workingDays);
  const holidays = new Set(settings.leaveRules.officialHolidays);
  const shifts = await loadShifts(transaction);

  const rules = settings.payrollRules;
  const cents = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  /** Multiplier from a loan's currency to the run's currency, or null when there is no rate for the pair. */
  const conversion = (from: string, branchId: string): number | null => {
    if (from === run.currency) return 1;
    const rate = rules.branchUsdRates?.[branchId] ?? rules.usdRate;
    if (!rate) return null;
    if (from === 'IQD' && run.currency === 'USD') return 1 / rate;
    if (from === 'USD' && run.currency === 'IQD') return rate;
    return null;
  };

  return employees.map((employee) => {
    const ownLoans = loans
      .filter((loan) => loan.employeeId === employee.id && loan.remaining > 0.004)
      .map((loan) => ({ loan, factor: conversion(loan.currency, employee.branchId) }))
      .filter((item): item is { loan: typeof item.loan; factor: number } => item.factor !== null);
    const own = days.filter((day) => day.employeeId === employee.id);
    const tracked = Boolean(employee.shiftId) && own.length > 0;
    const shift = employee.shiftId ? shifts.get(employee.shiftId) : undefined;
    const count = (status: string) => own.filter((day) => day.status === status).length;
    const sum = (key: 'lateMinutes' | 'earlyLeaveMinutes' | 'overtimeMinutes') => own.reduce((total, day) => total + day[key], 0);
    let unpaidLeaveDays = 0;
    if (!tracked) {
      const dates = new Set<string>();
      for (const leave of unpaidLeaves.filter((item) => item.employeeId === employee.id)) {
        for (const date of eachDate(leave.startsOn, leave.endsOn)) {
          if (workingDays.has(weekday(date)) && !holidays.has(date)) dates.add(date);
        }
      }
      unpaidLeaveDays = dates.size;
    }
    const attendance: AttendanceTotals = {
      tracked,
      scheduledDays: own.filter((day) => ['present', 'absent', 'leave', 'unpaid_leave', 'incomplete'].includes(day.status)).length,
      presentDays: count('present'),
      absentDays: count('absent'),
      unpaidLeaveDays: tracked ? count('unpaid_leave') : unpaidLeaveDays,
      incompleteDays: count('incomplete'),
      lateMinutes: sum('lateMinutes'),
      earlyLeaveMinutes: sum('earlyLeaveMinutes'),
      overtimeMinutes: sum('overtimeMinutes'),
      standardDailyMinutes: shift ? scheduledMinutes(shift) : 480,
    };
    const payslip = calculatePayslip({
      periodStart: run.startsOn,
      periodEnd: run.endsOn,
      employmentType: employee.employmentType,
      hireDate: employee.hireDate,
      terminationDate: employee.terminationDate,
      compensation: compensation.filter((item) => item.employeeId === employee.id),
      rules: settings.payrollRules,
      attendanceRules: settings.attendanceRules,
      attendance,
      inputs: inputs.filter((item) => item.employeeId === employee.id),
      adjustment: adjustments.get(employee.id) ?? null,
      loans: ownLoans.map(({ loan, factor }) => ({
        loanId: loan.loanId,
        installment: cents(loan.installment * factor),
        remaining: cents(loan.remaining * factor),
        final: loan.final,
      })),
    });
    // Back to the loan's currency: a full instalment stays exact, a capped one is converted.
    const loanRepayments: LoanRepaymentDraft[] = payslip.loanRepayments.map((item) => {
      const { loan, factor } = ownLoans.find((entry) => entry.loan.loanId === item.loanId)!;
      const fullDue = loan.final && loan.remaining < 2 * loan.installment ? loan.remaining : Math.min(loan.installment, loan.remaining);
      const amount = Math.abs(item.amount - cents(fullDue * factor)) < 0.005
        ? fullDue
        : Math.min(loan.remaining, cents(item.amount / factor));
      return { loanId: item.loanId, amount, payrollAmount: item.amount };
    });
    return {
      ...payslip,
      loanRepayments,
      employeeId: employee.id,
      branchId: employee.branchId,
      departmentId: employee.departmentId,
      costCenterCode: employee.costCenterCode,
      currency: run.currency,
      attendance,
      paymentMethod: employee.paymentMethod ?? 'bank',
    };
  });
}

type FingerprintItem = { componentId: string; amount: number };

/**
 * Comparable fingerprint of a run's payslips, used to detect stale approvals.
 * Built from canonical [component, amount] pairs because jsonb does not keep
 * object key order, so raw JSON of stored and fresh lines would differ.
 */
export function linesFingerprint(lines: Array<{ employeeId: string; netPay: number; earnings: unknown; deductions: unknown }>): string {
  const items = (value: unknown) => (value as FingerprintItem[])
    .map((item) => [item.componentId, Number(item.amount)] as const)
    .sort((left, right) => left[0].localeCompare(right[0]));
  return JSON.stringify(
    [...lines]
      .sort((left, right) => left.employeeId.localeCompare(right.employeeId))
      .map((line) => [line.employeeId, Number(line.netPay), items(line.earnings), items(line.deductions)]),
  );
}

export async function storedLines(runId: string, transaction?: Transaction) {
  return select<{ employeeId: string; netPay: number; earnings: unknown; deductions: unknown }>(
    `SELECT employee_id AS "employeeId", net_pay::float AS "netPay", earnings, deductions
     FROM payroll_lines WHERE run_id = :runId`,
    { runId },
    transaction,
  );
}

export async function replaceRunLines(run: RunRow, lines: LineDraft[], userId: string, transaction: Transaction): Promise<void> {
  await execute('DELETE FROM payroll_lines WHERE run_id = :runId', { runId: run.id }, transaction);
  const rows = lines.map((line) => ({
    id: randomUUID(),
    employeeId: line.employeeId,
    branchId: line.branchId,
    departmentId: line.departmentId,
    costCenterCode: line.costCenterCode,
    grossSalary: line.grossSalary,
    currency: line.currency,
    periodDays: line.periodDays,
    employedDays: line.employedDays,
    scheduledDays: line.attendance.scheduledDays,
    presentDays: line.attendance.presentDays,
    absentDays: line.attendance.absentDays,
    unpaidLeaveDays: line.attendance.unpaidLeaveDays,
    lateMinutes: line.attendance.lateMinutes + line.attendance.earlyLeaveMinutes,
    overtimeMinutes: line.attendance.overtimeMinutes,
    attendanceTracked: line.attendance.tracked,
    earnings: line.earnings,
    deductions: line.deductions,
    totalEarnings: line.totalEarnings,
    totalDeductions: line.totalDeductions,
    netPay: line.netPay,
    paymentMethod: line.paymentMethod,
    warnings: line.warnings,
    payableDays: line.payableDays,
    socialSecurityBase: line.socialSecurityBase,
  }));
  for (let index = 0; index < rows.length; index += 500) {
    await execute(
      `INSERT INTO payroll_lines (id, run_id, employee_id, branch_id, department_id, cost_center_code, gross_salary, currency,
         period_days, employed_days, scheduled_days, present_days, absent_days, unpaid_leave_days, late_minutes,
         overtime_minutes, attendance_tracked, earnings, deductions, total_earnings, total_deductions, net_pay,
         payment_method, warnings, payable_days, social_security_base)
       SELECT x.id, :runId, x."employeeId", x."branchId", x."departmentId", x."costCenterCode", x."grossSalary", x.currency,
              x."periodDays", x."employedDays", x."scheduledDays", x."presentDays", x."absentDays", x."unpaidLeaveDays",
              x."lateMinutes", x."overtimeMinutes", x."attendanceTracked", x.earnings, x.deductions, x."totalEarnings",
              x."totalDeductions", x."netPay", x."paymentMethod", x.warnings, x."payableDays", x."socialSecurityBase"
       FROM jsonb_to_recordset(:rows::jsonb) AS x(
         id uuid, "employeeId" uuid, "branchId" uuid, "departmentId" uuid, "costCenterCode" varchar, "grossSalary" numeric,
         currency char(3), "periodDays" int, "employedDays" int, "scheduledDays" int, "presentDays" int, "absentDays" int,
         "unpaidLeaveDays" int, "lateMinutes" int, "overtimeMinutes" int, "attendanceTracked" boolean, earnings jsonb,
         deductions jsonb, "totalEarnings" numeric, "totalDeductions" numeric, "netPay" numeric, "paymentMethod" varchar,
         warnings jsonb, "payableDays" numeric, "socialSecurityBase" numeric)`,
      { runId: run.id, rows: JSON.stringify(rows.slice(index, index + 500)) },
      transaction,
    );
  }
  await execute('DELETE FROM loan_repayments WHERE run_id = :runId', { runId: run.id }, transaction);
  const repayments = lines.flatMap((line) => line.loanRepayments.map((item) => ({ ...item, period: run.period })));
  if (repayments.length) {
    await execute(
      `INSERT INTO loan_repayments (loan_id, run_id, period, amount, payroll_amount)
       SELECT x."loanId", :runId, x.period, x.amount, x."payrollAmount"
       FROM jsonb_to_recordset(:rows::jsonb) AS x("loanId" uuid, period char(7), amount numeric, "payrollAmount" numeric)`,
      { runId: run.id, rows: JSON.stringify(repayments) },
      transaction,
    );
  }
  const totals = lines.reduce((sum, line) => ({
    earnings: sum.earnings + line.totalEarnings,
    deductions: sum.deductions + line.totalDeductions,
    net: sum.net + line.netPay,
    warnings: sum.warnings + line.warnings.length,
  }), { earnings: 0, deductions: 0, net: 0, warnings: 0 });
  await execute(
    `UPDATE payroll_runs SET status = 'calculated', employee_count = :count, total_earnings = :earnings,
       total_deductions = :deductions, total_net = :net, warning_count = :warnings, calculated_by = :userId,
       calculated_at = now(), updated_at = now()
     WHERE id = :runId`,
    { runId: run.id, count: lines.length, ...totals, userId },
    transaction,
  );
}

export async function recomputeRunAttendance(run: RunRow): Promise<void> {
  await computeAttendance({ from: run.startsOn, to: run.endsOn, branchId: run.branchId });
}
