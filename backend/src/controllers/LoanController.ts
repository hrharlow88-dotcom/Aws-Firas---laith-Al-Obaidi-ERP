import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { execute, select, selectOne, transaction } from '../db/query';
import { branchScope, employeeInScope } from '../services/access';
import { periodBounds } from '../services/payroll';
import { recordAudit } from '../utils/audit';
import {
  assertOnlyKeys, badRequest, body, conflict, notFound, optionalNumber, optionalText, requiredText,
} from '../utils/http';
import { isUuid } from '../utils/validation';

const LOAN_COLUMNS = `
  l.id, l.employee_id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "employeeName",
  l.currency, l.principal::float AS principal, l.installment::float AS installment, l.paid_before::float AS "paidBefore",
  l.start_period AS "startPeriod", l.status, l.installments_total AS "installmentsTotal",
  l.installments_paid_before + COALESCE(rp.count, 0) AS "installmentsPaid", l.reference, l.notes, l.created_at AS "createdAt",
  COALESCE(rp.repaid, 0)::float AS "repaidByPayroll",
  (l.principal - l.paid_before - COALESCE(rp.repaid, 0))::float AS remaining,
  rp.last_period AS "lastPeriod"`;

const LOAN_FROM = `
  FROM employee_loans l
  JOIN employees e ON e.id = l.employee_id
  LEFT JOIN LATERAL (
    SELECT SUM(x.amount) AS repaid, MAX(x.period) AS last_period, COUNT(*)::int AS count
    FROM loan_repayments x JOIN payroll_runs r ON r.id = x.run_id
    WHERE x.loan_id = l.id AND r.status <> 'cancelled'
  ) rp ON true`;

/** Instalment loans and salary advances, repaid through payroll. */
export class LoanController {
  static async list(req: Request, res: Response): Promise<void> {
    const branch = branchScope(req);
    const employeeId = typeof req.query.employeeId === 'string' && isUuid(req.query.employeeId) ? req.query.employeeId : null;
    const status = typeof req.query.status === 'string' && ['active', 'suspended', 'closed'].includes(req.query.status)
      ? req.query.status : null;
    const rows = await select(
      `SELECT ${LOAN_COLUMNS} ${LOAN_FROM}
       WHERE true ${branch ? 'AND e.branch_id = :branch' : ''} ${employeeId ? 'AND l.employee_id = :employeeId' : ''}
         ${status ? 'AND l.status = :status' : ''}
       ORDER BY l.status, e.employee_no, l.start_period`,
      { branch, employeeId, status },
    );
    res.json({ data: rows });
  }

  static async create(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, [
      'employeeId', 'currency', 'principal', 'installment', 'installmentsTotal', 'paidBefore', 'startPeriod', 'reference', 'notes',
    ]);
    const employee = await employeeInScope(req, input.employeeId);
    const principal = optionalNumber(input, 'principal', { min: 0.01, max: 1e12 });
    const installment = optionalNumber(input, 'installment', { min: 0.01, max: 1e12 });
    const paidBefore = optionalNumber(input, 'paidBefore', { min: 0, max: 1e12 }) ?? 0;
    const installmentsTotal = optionalNumber(input, 'installmentsTotal', { min: 1, max: 240 }) ?? null;
    if (installmentsTotal !== null && !Number.isInteger(installmentsTotal)) throw badRequest('عدد الأقساط يجب أن يكون رقماً صحيحاً.');
    if (!principal || !installment) throw badRequest('أدخل مبلغ السلفة والقسط الشهري.');
    if (installment > principal) throw badRequest('القسط الشهري أكبر من مبلغ السلفة.');
    if (paidBefore > principal) throw badRequest('المسدد سابقاً أكبر من مبلغ السلفة.');
    const startPeriod = requiredText(input, 'startPeriod', 7, 'شهر بدء الاستقطاع');
    periodBounds(startPeriod);
    const currency = (optionalText(input, 'currency', 3) || '').toUpperCase();
    const salary = await selectOne<{ currency: string }>(
      'SELECT currency FROM employee_compensation WHERE employee_id = :id ORDER BY effective_from DESC LIMIT 1',
      { id: employee.id },
    );
    const loanCurrency = currency || salary?.currency;
    if (!loanCurrency || !/^[A-Z]{3}$/.test(loanCurrency)) throw badRequest('حدد عملة السلفة (لا يوجد راتب مسجل للموظف).');
    const id = randomUUID();
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO employee_loans (id, employee_id, currency, principal, installment, installments_total, paid_before, start_period,
           reference, notes, created_by)
         VALUES (:id, :employeeId, :currency, :principal, :installment, :installmentsTotal, :paidBefore, :startPeriod,
           :reference, :notes, :userId)`,
        {
          id, employeeId: employee.id, currency: loanCurrency, principal, installment, installmentsTotal, paidBefore, startPeriod,
          reference: optionalText(input, 'reference', 60) ?? null, notes: optionalText(input, 'notes', 1000) ?? null,
          userId: req.user!.id,
        },
        tx,
      );
      await recordAudit(req, tx, 'payroll.loan_created', 'employee', employee.id, {
        loanId: id, principal, installment, paidBefore, startPeriod, currency: loanCurrency,
      });
    });
    res.status(201).json({ data: { id } });
  }

  /** Suspends, resumes or closes a loan; amounts already deducted stay as they are. */
  static async setStatus(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['status', 'reason', 'installment']);
    const loan = await selectOne<{ id: string; employeeId: string; status: string; principal: number }>(
      'SELECT id, employee_id AS "employeeId", status, principal::float AS principal FROM employee_loans WHERE id = :id',
      { id: req.params.id },
    );
    if (!loan) throw notFound('السلفة غير موجودة.');
    await employeeInScope(req, loan.employeeId);
    const status = String(input.status ?? loan.status);
    if (!['active', 'suspended', 'closed'].includes(status)) throw badRequest('حالة السلفة غير صالحة.');
    const installment = optionalNumber(input, 'installment', { min: 0.01, max: 1e12 });
    if (installment && installment > loan.principal) throw badRequest('القسط الشهري أكبر من مبلغ السلفة.');
    const reason = requiredText(input, 'reason', 500, 'السبب');
    if (status === loan.status && !installment) throw conflict('لا يوجد تغيير.');
    await transaction(async (tx) => {
      await execute(
        `UPDATE employee_loans SET status = :status, installment = COALESCE(:installment, installment), updated_at = now() WHERE id = :id`,
        { id: loan.id, status, installment: installment ?? null },
        tx,
      );
      await recordAudit(req, tx, 'payroll.loan_updated', 'employee', loan.employeeId, {
        loanId: loan.id, from: loan.status, to: status, installment: installment ?? undefined, reason,
      });
    });
    res.json({ data: { id: loan.id } });
  }
}

export default LoanController;
