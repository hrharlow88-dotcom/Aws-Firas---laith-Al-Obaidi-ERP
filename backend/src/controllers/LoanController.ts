import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { execute, select, selectOne, transaction } from '../db/query';
import { employeeInScope, employeeScopeSql } from '../services/access';
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
  COALESCE(rp.pending, 0)::float AS "pendingDeduction",
  (l.principal - l.paid_before - COALESCE(rp.repaid, 0))::float AS remaining,
  rp.last_period AS "lastPeriod"`;

const LOAN_FROM = `
  FROM employee_loans l
  JOIN employees e ON e.id = l.employee_id
  LEFT JOIN LATERAL (
    -- Repaid = runs that were approved; a calculated run's deduction is still pending.
    SELECT SUM(x.amount) FILTER (WHERE r.status IN ('approved','posted')) AS repaid,
           SUM(x.amount) FILTER (WHERE r.status IN ('draft','calculated')) AS pending,
           MAX(x.period) FILTER (WHERE r.status IN ('approved','posted')) AS last_period,
           (COUNT(*) FILTER (WHERE r.status IN ('approved','posted')))::int AS count
    FROM loan_repayments x JOIN payroll_runs r ON r.id = x.run_id
    WHERE x.loan_id = l.id AND r.status <> 'cancelled'
  ) rp ON true`;

function nextPeriod(period: string, months = 1): string {
  const [y, m] = period.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, 1));
  return date.toISOString().slice(0, 7);
}

/** Instalment loans and salary advances, repaid through payroll. */
export class LoanController {
  /**
   * The loan month by month: what was taken before the system, what each
   * approved payroll deducted, what a calculated run is about to deduct, and
   * the plan for the remaining months (the last instalment takes the rest).
   */
  static async schedule(req: Request, res: Response): Promise<void> {
    const scope = employeeScopeSql(req);
    const loan = await selectOne<{
      id: string; employeeName: string; employeeNo: string; currency: string; principal: number; installment: number;
      paidBefore: number; installmentsPaidBefore: number; installmentsTotal: number | null; startPeriod: string; status: string;
    }>(
      `SELECT l.id, e.full_name AS "employeeName", e.employee_no AS "employeeNo", l.currency, l.principal::float AS principal,
              l.installment::float AS installment, l.paid_before::float AS "paidBefore",
              l.installments_paid_before AS "installmentsPaidBefore", l.installments_total AS "installmentsTotal",
              l.start_period AS "startPeriod", l.status
       FROM employee_loans l JOIN employees e ON e.id = l.employee_id WHERE l.id = :id${scope.sql}`,
      { ...scope.params, id: req.params.id },
    );
    if (!loan) throw notFound('السلفة غير موجودة.');
    const taken = await select<{ period: string; amount: number; payrollAmount: number; runStatus: string; runId: string }>(
      `SELECT x.period, x.amount::float AS amount, x.payroll_amount::float AS "payrollAmount", r.status AS "runStatus", r.id AS "runId"
       FROM loan_repayments x JOIN payroll_runs r ON r.id = x.run_id
       WHERE x.loan_id = :id AND r.status <> 'cancelled' ORDER BY x.period`,
      { id: loan.id },
    );
    const rows: Array<{ period: string | null; amount: number; kind: 'before' | 'deducted' | 'pending' | 'planned'; balanceAfter: number; runId?: string }> = [];
    let balance = loan.principal;
    if (loan.paidBefore > 0) {
      balance -= loan.paidBefore;
      rows.push({ period: null, amount: loan.paidBefore, kind: 'before', balanceAfter: Math.round(balance * 100) / 100 });
    }
    for (const item of taken) {
      balance -= item.amount;
      rows.push({
        period: item.period, amount: item.amount, kind: ['approved', 'posted'].includes(item.runStatus) ? 'deducted' : 'pending',
        balanceAfter: Math.round(balance * 100) / 100, runId: item.runId,
      });
    }
    let period = taken.length ? nextPeriod(taken[taken.length - 1].period) : loan.startPeriod;
    let count = loan.installmentsPaidBefore + taken.length;
    let guard = 0;
    while (loan.status === 'active' && balance > 0.004 && guard < 240) {
      count += 1;
      // Same rule as payroll: the agreed last instalment clears a balance under two instalments.
      const last = loan.installmentsTotal !== null && count >= loan.installmentsTotal && balance < 2 * loan.installment;
      const take = Math.round((last ? balance : Math.min(loan.installment, balance)) * 100) / 100;
      balance = Math.round((balance - take) * 100) / 100;
      rows.push({ period, amount: take, kind: 'planned', balanceAfter: balance });
      period = nextPeriod(period);
      guard += 1;
    }
    res.json({ data: { loan, rows } });
  }

  /** Everything deducted for loans in one month, by employee: the monthly deduction archive. */
  static async deductions(req: Request, res: Response): Promise<void> {
    const period = typeof req.query.period === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.period) ? req.query.period : null;
    if (!period) throw badRequest('حدد الشهر.');
    const scope = employeeScopeSql(req);
    const rows = await select(
      `SELECT x.loan_id AS "loanId", e.id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "employeeName",
              l.currency AS "loanCurrency", x.amount::float AS amount, r.currency AS "payrollCurrency",
              x.payroll_amount::float AS "payrollAmount", r.status AS "runStatus", r.id AS "runId", l.reference
       FROM loan_repayments x
       JOIN payroll_runs r ON r.id = x.run_id
       JOIN employee_loans l ON l.id = x.loan_id
       JOIN employees e ON e.id = l.employee_id
       WHERE x.period = :period AND r.status <> 'cancelled'${scope.sql}
       ORDER BY e.employee_no`,
      { ...scope.params, period },
    );
    const months = await select<{ period: string }>(
      `SELECT DISTINCT x.period FROM loan_repayments x JOIN payroll_runs r ON r.id = x.run_id WHERE r.status <> 'cancelled' ORDER BY x.period DESC LIMIT 60`,
    );
    res.json({ data: { period, rows, months: months.map((item) => item.period) } });
  }

  static async list(req: Request, res: Response): Promise<void> {
    const scope = employeeScopeSql(req);
    const employeeId = typeof req.query.employeeId === 'string' && isUuid(req.query.employeeId) ? req.query.employeeId : null;
    const status = typeof req.query.status === 'string' && ['active', 'suspended', 'closed'].includes(req.query.status)
      ? req.query.status : null;
    const rows = await select(
      `SELECT ${LOAN_COLUMNS} ${LOAN_FROM}
       WHERE true${scope.sql} ${employeeId ? 'AND l.employee_id = :employeeId' : ''}
         ${status ? 'AND l.status = :status' : ''}
       ORDER BY l.status, e.employee_no, l.start_period`,
      { ...scope.params, employeeId, status },
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
    assertOnlyKeys(input, ['status', 'reason', 'installment', 'principal', 'paidBefore']);
    const loan = await selectOne<{ id: string; employeeId: string; status: string; principal: number; paid: number }>(
      `SELECT l.id, l.employee_id AS "employeeId", l.status, l.principal::float AS principal,
              (l.paid_before + COALESCE((SELECT SUM(x.amount) FROM loan_repayments x JOIN payroll_runs r ON r.id = x.run_id
                                         WHERE x.loan_id = l.id AND r.status IN ('approved','posted')), 0))::float AS paid
       FROM employee_loans l WHERE l.id = :id`,
      { id: req.params.id },
    );
    if (!loan) throw notFound('السلفة غير موجودة.');
    await employeeInScope(req, loan.employeeId);
    const status = String(input.status ?? loan.status);
    if (!['active', 'suspended', 'closed'].includes(status)) throw badRequest('حالة السلفة غير صالحة.');
    const installment = optionalNumber(input, 'installment', { min: 0.01, max: 1e12 });
    // Correcting the amount lent (a typing error, a top-up) never below what was already repaid.
    const principal = optionalNumber(input, 'principal', { min: 0.01, max: 1e12 });
    if (principal && principal < loan.paid) throw badRequest('مبلغ السلفة أقل مما سُدد منها.');
    // What was repaid before the system (outside payroll runs) can be corrected too.
    const paidBefore = optionalNumber(input, 'paidBefore', { min: 0, max: 1e12 });
    if (paidBefore !== undefined && paidBefore !== null && paidBefore > (principal ?? loan.principal)) throw badRequest('المسدد سابقاً أكبر من مبلغ السلفة.');
    if (installment && installment > (principal ?? loan.principal)) throw badRequest('القسط الشهري أكبر من مبلغ السلفة.');
    const reason = requiredText(input, 'reason', 500, 'السبب');
    if (status === loan.status && !installment && !principal && (paidBefore === undefined || paidBefore === null)) throw conflict('لا يوجد تغيير.');
    await transaction(async (tx) => {
      await execute(
        `UPDATE employee_loans SET status = :status, installment = COALESCE(:installment, installment),
           principal = COALESCE(:principal, principal), paid_before = COALESCE(:paidBefore, paid_before), updated_at = now()
         WHERE id = :id`,
        { id: loan.id, status, installment: installment ?? null, principal: principal ?? null, paidBefore: paidBefore ?? null },
        tx,
      );
      await recordAudit(req, tx, 'payroll.loan_updated', 'employee', loan.employeeId, {
        loanId: loan.id, from: loan.status, to: status, installment: installment ?? undefined,
        principal: principal ? [loan.principal, principal] : undefined, paidBefore: paidBefore ?? undefined, reason,
      });
    });
    res.json({ data: { id: loan.id } });
  }
}

export default LoanController;
