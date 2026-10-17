import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import type { LeaveTypeSetting } from '../config/systemSettings';
import { execute, select, selectOne, transaction } from '../db/query';
import { isScoped } from '../services/access';
import { monthlyAccrual, periodBounds } from '../services/leaveAccrual';
import { getSettings } from '../services/settings';
import { recordAudit } from '../utils/audit';
import { isUuid } from '../utils/validation';

interface EmployeeRow {
  id: string;
  employeeNo: string;
  fullName: string;
  branch: string;
  hireDate: string;
  terminationDate: string | null;
  employmentStatus: string;
  employmentType: string;
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

function previousPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

async function accrualType(leaveTypeId: unknown): Promise<LeaveTypeSetting | null> {
  const settings = await getSettings();
  return settings.leaveTypes.find((type) => type.id === leaveTypeId && type.active && type.monthlyAccrual === true) ?? null;
}

/**
 * Builds the month's accrual lines and the checks that decide whether it may
 * be posted. Used both by the preview and, inside the transaction, by apply,
 * so what is posted is exactly what was shown.
 */
async function buildAccrual(period: string, leaveType: LeaveTypeSetting, tx?: Parameters<typeof select>[2]) {
  const settings = await getSettings();
  const bounds = periodBounds(period);
  const employees = await select<EmployeeRow>(
    `SELECT e.id, e.employee_no AS "employeeNo", e.full_name AS "fullName", b.name AS branch,
            to_char(e.hire_date, 'YYYY-MM-DD') AS "hireDate", to_char(e.termination_date, 'YYYY-MM-DD') AS "terminationDate",
            e.employment_status::text AS "employmentStatus", e.employment_type AS "employmentType"
       FROM employees e JOIN branches b ON b.id = e.branch_id
      WHERE e.hire_date <= :end AND (e.termination_date IS NULL OR e.termination_date >= :start)
      ORDER BY b.name, e.employee_no`,
    { start: bounds.start, end: bounds.end }, tx,
  );
  const posted = new Set((await select<{ employeeId: string }>(
    `SELECT employee_id AS "employeeId" FROM leave_ledger_entries WHERE leave_type_id = :type AND accrual_period = :period`,
    { type: leaveType.id, period }, tx,
  )).map((row) => row.employeeId));
  const lines = employees.map((employee) => ({
    employeeId: employee.id,
    employeeNo: employee.employeeNo,
    fullName: employee.fullName,
    branch: employee.branch,
    hireDate: employee.hireDate,
    employmentType: employee.employmentType,
    ...monthlyAccrual(period, employee, leaveType),
  }));

  const errors: string[] = [];
  const warnings: string[] = [];
  const startPeriod = settings.leaveRules.accrualStartPeriod;
  const today = new Date().toISOString().slice(0, 10);
  if (!startPeriod) errors.push('حدد أول شهر للاستحقاق في إعدادات الإجازات (الأشهر قبله داخلة في الأرصدة الافتتاحية).');
  else if (period < startPeriod) errors.push(`الأشهر قبل ${startPeriod} داخلة في الرصيد الافتتاحي.`);
  if (bounds.start > today) errors.push('لا يمكن احتساب استحقاق شهر لم يبدأ بعد.');
  const run = await selectOne<{ id: string }>(
    'SELECT id FROM leave_accrual_runs WHERE leave_type_id = :type AND period = :period', { type: leaveType.id, period }, tx);
  if (run) errors.push('استحقاق هذا الشهر مُرحّل مسبقاً.');
  if (startPeriod && period > startPeriod) {
    const previous = previousPeriod(period);
    const before = await selectOne<{ id: string }>(
      'SELECT id FROM leave_accrual_runs WHERE leave_type_id = :type AND period = :period', { type: leaveType.id, period: previous }, tx);
    if (!before) warnings.push(`استحقاق شهر ${previous} لم يُرحّل بعد.`);
  }
  if (bounds.end > today) warnings.push('الشهر لم ينتهِ بعد؛ الاحتساب يفترض استمرار الموظفين حتى نهايته.');

  const credited = lines.filter((line) => line.days > 0 && !posted.has(line.employeeId));
  const summary = {
    employees: lines.length,
    credited: credited.length,
    skipped: lines.filter((line) => line.skipReason).length,
    totalDays: Math.round(credited.reduce((sum, line) => sum + line.days, 0) * 100) / 100,
  };
  return { lines: lines.map((line) => ({ ...line, alreadyPosted: posted.has(line.employeeId) })), credited, errors, warnings, summary };
}

function readRequest(source: Record<string, unknown>): { period: string; leaveTypeId: string } | null {
  const { period, leaveTypeId } = source;
  if (typeof period !== 'string' || !PERIOD.test(period) || !isUuid(leaveTypeId)) return null;
  return { period, leaveTypeId: String(leaveTypeId) };
}

export class LeaveAccrualController {
  static async list(req: Request, res: Response): Promise<void> {
    const runs = await select(
      `SELECT r.id, r.leave_type_id AS "leaveTypeId", r.period, r.employee_count AS "employeeCount",
              r.total_days::float AS "totalDays", r.created_at AS "createdAt", u.name AS "createdBy"
         FROM leave_accrual_runs r LEFT JOIN users u ON u.id = r.created_by
        ORDER BY r.period DESC, r.created_at DESC LIMIT 120`,
    );
    res.json({ data: runs });
  }

  static async preview(req: Request, res: Response): Promise<void> {
    const input = readRequest(req.query as Record<string, unknown>);
    if (!input) { res.status(400).json({ message: 'حدد الشهر ونوع الإجازة.' }); return; }
    const leaveType = await accrualType(input.leaveTypeId);
    if (!leaveType) { res.status(400).json({ message: 'نوع الإجازة غير مفعّل للاستحقاق الشهري.' }); return; }
    const result = await buildAccrual(input.period, leaveType);
    res.json({ data: { period: input.period, leaveType: { id: leaveType.id, name: leaveType.name }, lines: result.lines, errors: result.errors, warnings: result.warnings, summary: result.summary } });
  }

  static async apply(req: Request, res: Response): Promise<void> {
    // A company-wide posting: someone limited to a branch or a team cannot run it.
    if (isScoped(req)) { res.status(403).json({ message: 'ترحيل الاستحقاق الشهري يتطلب صلاحية على كل الشركة.' }); return; }
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const input = readRequest(body);
    if (!input) { res.status(400).json({ message: 'حدد الشهر ونوع الإجازة.' }); return; }
    const leaveType = await accrualType(input.leaveTypeId);
    if (!leaveType) { res.status(400).json({ message: 'نوع الإجازة غير مفعّل للاستحقاق الشهري.' }); return; }

    const outcome = await transaction(async (tx) => {
      // One poster per leave type at a time.
      await execute('SELECT pg_advisory_xact_lock(hashtext(:key))', { key: `leave-accrual:${leaveType.id}` }, tx);
      const result = await buildAccrual(input.period, leaveType, tx);
      if (result.errors.length) return { status: 400 as const, message: result.errors.join(' ') };
      const runId = randomUUID();
      await execute(
        `INSERT INTO leave_accrual_runs (id, leave_type_id, period, employee_count, total_days, created_by)
         VALUES (:id, :type, :period, :count, :total, :user)`,
        { id: runId, type: leaveType.id, period: input.period, count: result.credited.length, total: result.summary.totalDays, user: req.user!.id }, tx,
      );
      for (const line of result.credited) {
        await execute(
          `INSERT INTO leave_ledger_entries (id, employee_id, leave_type_id, quantity, entry_type, request_id, reason, created_by, created_at, accrual_period)
           VALUES (:id, :employee, :type, :quantity, 'accrual', NULL, :reason, :user, now(), :period)`,
          {
            id: randomUUID(), employee: line.employeeId, type: leaveType.id, quantity: line.days.toFixed(2),
            reason: `استحقاق شهر ${input.period} (${line.entitlement} يوم سنوياً${line.employedDays < line.monthDays ? `، ${line.employedDays} من ${line.monthDays} يوم` : ''})`,
            user: req.user!.id, period: input.period,
          }, tx,
        );
      }
      await recordAudit(req, tx, 'leave.accrual_posted', 'leave_accrual_run', runId, {
        period: input.period, leaveTypeId: leaveType.id, employees: result.credited.length, totalDays: result.summary.totalDays,
      });
      return { status: 201 as const, data: { id: runId, period: input.period, ...result.summary } };
    });
    if ('message' in outcome) { res.status(outcome.status).json({ message: outcome.message }); return; }
    res.status(201).json({ data: outcome.data });
  }
}

export default LeaveAccrualController;
