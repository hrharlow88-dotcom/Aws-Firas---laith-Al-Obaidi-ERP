import { getSettings } from '../services/settings';
import { Request, Response } from 'express';
import { select, selectOne } from '../db/query';
import { loadRun } from '../services/payroll';
import { notFound } from '../utils/http';
import { isUuid } from '../utils/validation';
import { payslipData } from './PayrollController';

/**
 * Employee self-service. Everything here is about the signed-in person's own
 * record, found through the employee linked to their account; nobody can ask
 * for someone else's data through these routes.
 */
function ownEmployeeId(req: Request): string {
  if (!req.user?.employeeId) throw notFound('حسابك غير مرتبط بملف موظف. راجع الموارد البشرية.');
  return req.user.employeeId;
}

export class SelfController {
  static async profile(req: Request, res: Response): Promise<void> {
    const employeeId = ownEmployeeId(req);
    const row = await selectOne<Record<string, unknown>>(
      `SELECT e.id, e.employee_no AS "employeeNo", e.full_name AS "fullName", p.name_en AS "nameEn",
              b.name AS "branchName", COALESCE(d.name, e.department) AS department, COALESCE(j.name, e."position") AS position,
              m.full_name AS "managerName", to_char(e.hire_date, 'YYYY-MM-DD') AS "hireDate",
              e.employment_status AS "employmentStatus", e.employment_type AS "employmentType",
              e.photo_document_id IS NOT NULL AS "hasPhoto", e.photo_document_id AS "photoVersion", s.name AS "shiftName", e.email, e.phone
       FROM employees e
       JOIN branches b ON b.id = e.branch_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN job_titles j ON j.id = e.job_title_id
       LEFT JOIN employees m ON m.id = e.manager_id
       LEFT JOIN employee_profiles p ON p.employee_id = e.id
       LEFT JOIN shifts s ON s.id = e.shift_id
       WHERE e.id = :employeeId`,
      { employeeId },
    );
    if (!row) throw notFound('ملف الموظف غير موجود.');
    const portal = (await getSettings()).portal;
    if (portal.showManager === false) row.managerName = null;
    if (portal.showShift === false) row.shiftName = null;
    res.json({ data: row });
  }

  /** Payslips of approved runs only: a run still being prepared is not the employee's business yet. */
  static async payslips(req: Request, res: Response): Promise<void> {
    const employeeId = ownEmployeeId(req);
    const rows = await select(
      `SELECT r.id AS "runId", r.period, r.currency, l.total_earnings::float AS "totalEarnings",
              l.total_deductions::float AS "totalDeductions", l.net_pay::float AS "netPay"
       FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
       WHERE l.employee_id = :employeeId AND r.status IN ('approved','posted')
       ORDER BY r.period DESC, r.currency LIMIT 36`,
      { employeeId },
    );
    res.json({ data: rows });
  }

  static async payslip(req: Request, res: Response): Promise<void> {
    const employeeId = ownEmployeeId(req);
    const run = isUuid(req.params.runId) ? await loadRun(req.params.runId) : null;
    if (!run || !['approved', 'posted'].includes(run.status)) throw notFound('القسيمة غير متاحة.');
    res.json({ data: await payslipData(run, employeeId) });
  }
}

export default SelfController;
