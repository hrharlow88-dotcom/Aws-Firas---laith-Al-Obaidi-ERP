import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { execute, select, selectOne, transaction } from '../db/query';
import { employeeInScope, employeeScopeSql } from '../services/access';
import { periodBounds } from '../services/payroll';
import { getSettings } from '../services/settings';
import { userSignature } from '../services/signatures';
import { recordAudit } from '../utils/audit';
import {
  assertOnlyKeys, badRequest, body, conflict, notFound, optionalNumber, optionalText, requiredText,
} from '../utils/http';
import { isDateOnly, isUuid } from '../utils/validation';

const CATEGORIES = ['lateness', 'absence', 'conduct', 'performance', 'safety', 'policy', 'property', 'other'];
const ACTIONS = ['note', 'verbal_warning', 'written_warning', 'final_warning', 'deduction', 'suspension', 'termination'];
/** Monetary penalties go to payroll as «استقطاع آخر» for the chosen month. */
const PENALTY_COMPONENT = '30000000-0000-4000-8000-000000000009';

const COLUMNS = `
  d.id, d.ref_no AS "refNo", d.employee_id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "employeeName",
  b.name AS "branchName", COALESCE(dep.name, e.department) AS department, d.category, d.action, d.title, d.description,
  to_char(d.incident_date, 'YYYY-MM-DD') AS "incidentDate", d.deduction_amount::float AS "deductionAmount",
  d.deduction_currency AS "deductionCurrency", d.deduction_period AS "deductionPeriod", d.suspension_days AS "suspensionDays",
  d.status, d.signature, iu.name AS "issuedByName", d.issued_at AS "issuedAt", d.acknowledged_at AS "acknowledgedAt",
  d.employee_comment AS "employeeComment", d.cancel_reason AS "cancelReason", d.cancelled_at AS "cancelledAt"`;
const FROM = `
  FROM disciplinary_records d
  JOIN employees e ON e.id = d.employee_id
  JOIN branches b ON b.id = e.branch_id
  LEFT JOIN departments dep ON dep.id = e.department_id
  JOIN users iu ON iu.id = d.issued_by`;

/** HR register: warnings, penalties and violations, each with a reference number. */
export class DisciplineController {
  static async list(req: Request, res: Response): Promise<void> {
    const scope = employeeScopeSql(req);
    const employeeId = typeof req.query.employeeId === 'string' && isUuid(req.query.employeeId) ? req.query.employeeId : null;
    const rows = await select(
      `SELECT ${COLUMNS} ${FROM} WHERE true${scope.sql} ${employeeId ? 'AND d.employee_id = :employeeId' : ''}
       ORDER BY d.incident_date DESC, d.issued_at DESC LIMIT 500`,
      { ...scope.params, employeeId },
    );
    res.json({ data: rows });
  }

  static async create(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['employeeId', 'category', 'action', 'title', 'description', 'incidentDate', 'deductionAmount', 'deductionCurrency', 'deductionPeriod', 'suspensionDays']);
    const employee = await employeeInScope(req, input.employeeId);
    const category = String(input.category);
    const action = String(input.action);
    if (!CATEGORIES.includes(category)) throw badRequest('نوع المخالفة غير صالح.');
    if (!ACTIONS.includes(action)) throw badRequest('الإجراء غير صالح.');
    const title = requiredText(input, 'title', 200, 'عنوان المخالفة');
    const description = requiredText(input, 'description', 5000, 'تفاصيل المخالفة');
    const incidentDate = typeof input.incidentDate === 'string' ? input.incidentDate : '';
    if (!isDateOnly(incidentDate)) throw badRequest('حدد تاريخ المخالفة.');
    let amount: number | null = null;
    let currency: string | null = null;
    let period: string | null = null;
    if (action === 'deduction') {
      amount = optionalNumber(input, 'deductionAmount', { min: 1, max: 1e11 }) ?? null;
      if (!amount) throw badRequest('أدخل مبلغ الخصم.');
      currency = (optionalText(input, 'deductionCurrency', 3) || (await getSettings()).payrollRules.baseCurrency).toUpperCase();
      period = requiredText(input, 'deductionPeriod', 7, 'شهر الخصم');
      periodBounds(period);
      const closed = await selectOne(
        `SELECT 1 FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
         WHERE r.period = :period AND l.employee_id = :employeeId AND r.status IN ('approved','posted') LIMIT 1`,
        { period, employeeId: employee.id },
      );
      if (closed) throw conflict('مسير هذا الشهر معتمد؛ اختر شهراً لاحقاً للخصم.');
    }
    const suspensionDays = action === 'suspension' ? optionalNumber(input, 'suspensionDays', { min: 1, max: 60 }) ?? null : null;
    if (action === 'suspension' && !suspensionDays) throw badRequest('حدد عدد أيام الإيقاف.');
    const signature = await userSignature(req.user!.id);
    const id = randomUUID();
    const refNo = await transaction(async (tx) => {
      const seq = await selectOne<{ n: string }>("SELECT nextval('disciplinary_ref_seq')::text AS n", {}, tx);
      const ref = `HR-DIS-${incidentDate.slice(0, 4)}-${seq!.n.padStart(4, '0')}`;
      let inputId: string | null = null;
      if (action === 'deduction') {
        inputId = randomUUID();
        await execute(
          `INSERT INTO payroll_inputs (id, period, employee_id, component_id, amount, note, created_by)
           VALUES (:id, :period, :employeeId, :component, :amount, :note, :userId)`,
          { id: inputId, period, employeeId: employee.id, component: PENALTY_COMPONENT, amount, note: `عقوبة ${ref}: ${title}`.slice(0, 500), userId: req.user!.id }, tx,
        );
      }
      await execute(
        `INSERT INTO disciplinary_records (id, ref_no, employee_id, category, action, title, description, incident_date,
           deduction_amount, deduction_currency, deduction_period, suspension_days, payroll_input_id, signature, issued_by)
         VALUES (:id, :ref, :employeeId, :category, :action, :title, :description, :incidentDate,
           :amount, :currency, :period, :suspensionDays, :inputId, :signature, :userId)`,
        { id, ref, employeeId: employee.id, category, action, title, description, incidentDate, amount, currency, period, suspensionDays, inputId, signature, userId: req.user!.id }, tx,
      );
      await recordAudit(req, tx, 'discipline.issued', 'employee', employee.id, { recordId: id, ref, action, amount, period });
      return ref;
    });
    res.status(201).json({ data: { id, refNo } });
  }

  /** Withdrawn records stay in the register, marked cancelled; a pending deduction is removed from payroll. */
  static async cancel(req: Request, res: Response): Promise<void> {
    const reason = requiredText(body(req), 'reason', 500, 'سبب الإلغاء');
    const record = await selectOne<{ id: string; employeeId: string; status: string; payrollInputId: string | null; deductionPeriod: string | null }>(
      `SELECT id, employee_id AS "employeeId", status, payroll_input_id AS "payrollInputId", deduction_period AS "deductionPeriod"
       FROM disciplinary_records WHERE id = :id`, { id: req.params.id },
    );
    if (!record) throw notFound('السجل غير موجود.');
    await employeeInScope(req, record.employeeId);
    if (record.status === 'cancelled') throw conflict('السجل ملغى مسبقاً.');
    await transaction(async (tx) => {
      if (record.payrollInputId) {
        const closed = await selectOne(
          `SELECT 1 FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
           WHERE r.period = :period AND l.employee_id = :employeeId AND r.status IN ('approved','posted') LIMIT 1`,
          { period: record.deductionPeriod, employeeId: record.employeeId }, tx,
        );
        if (closed) throw conflict('الخصم دخل مسيراً معتمداً؛ عالجه بإضافة مبلغ في الشهر التالي ثم ألغِ السجل.');
        await execute('UPDATE disciplinary_records SET payroll_input_id = NULL WHERE id = :id', { id: record.id }, tx);
        await execute('DELETE FROM payroll_inputs WHERE id = :id', { id: record.payrollInputId }, tx);
      }
      await execute(
        `UPDATE disciplinary_records SET status = 'cancelled', cancelled_by = :userId, cancelled_at = now(), cancel_reason = :reason WHERE id = :id`,
        { userId: req.user!.id, reason, id: record.id }, tx,
      );
      await recordAudit(req, tx, 'discipline.cancelled', 'employee', record.employeeId, { recordId: record.id, reason });
    });
    res.json({ data: { id: record.id } });
  }

  // ---- the employee's own register (portal)
  static async mine(req: Request, res: Response): Promise<void> {
    if (!req.user?.employeeId) throw notFound('حسابك غير مرتبط بملف موظف.');
    const rows = await select(`SELECT ${COLUMNS} ${FROM} WHERE d.employee_id = :employeeId AND d.status <> 'cancelled' ORDER BY d.incident_date DESC`,
      { employeeId: req.user.employeeId });
    res.json({ data: rows });
  }

  /** The employee confirms they received the notice, optionally with a comment. */
  static async acknowledge(req: Request, res: Response): Promise<void> {
    if (!req.user?.employeeId) throw notFound('حسابك غير مرتبط بملف موظف.');
    const comment = optionalText(body(req), 'comment', 1000) ?? null;
    const rows = await execute<{ id: string }>(
      `UPDATE disciplinary_records SET status = 'acknowledged', acknowledged_at = now(), employee_comment = :comment
       WHERE id = :id AND employee_id = :employeeId AND status = 'issued' RETURNING id`,
      { id: req.params.id, employeeId: req.user.employeeId, comment },
    );
    if (!rows.length) throw conflict('لا يوجد إشعار بانتظار التأكيد.');
    await recordAudit(req, null, 'discipline.acknowledged', 'employee', req.user.employeeId, { recordId: req.params.id });
    res.json({ data: { id: req.params.id } });
  }
}

export default DisciplineController;
