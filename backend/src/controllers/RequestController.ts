import { randomUUID } from 'node:crypto';
import { notifyEmployees, notifyPermission } from '../services/notify';
import bcrypt from 'bcryptjs';
import { Request, Response } from 'express';
import { execute, select, selectOne, transaction } from '../db/query';
import { employeeInScope, employeeScopeSql } from '../services/access';
import { createSetupToken } from '../services/passwordSetup';
import { periodBounds } from '../services/payroll';
import { can, getSettings } from '../services/settings';
import { userSignature } from '../services/signatures';
import { contentDisposition, openStoredFile, sniffFile, storedFileExists, storeFile, uploadedName } from '../services/storage';
import { recordAudit } from '../utils/audit';
import { randomToken } from '../utils/crypto';
import {
  assertOnlyKeys, badRequest, body, conflict, forbidden, notFound, optionalNumber, optionalText, requiredText,
} from '../utils/http';
import { isDateOnly } from '../utils/validation';

/** Invitation links stay valid for a week so HR can send them by WhatsApp or SMS. */
const INVITE_MINUTES = 7 * 24 * 60;

function ownEmployeeId(req: Request): string {
  if (!req.user?.employeeId) throw notFound('حسابك غير مرتبط بملف موظف. راجع الموارد البشرية.');
  return req.user.employeeId;
}

const REQUEST_COLUMNS = `
  r.id, r.employee_id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "employeeName", b.name AS "branchName",
  r.kind, r.amount::float AS amount, r.currency, r.months, r.start_period AS "startPeriod",
  to_char(r.expense_date, 'YYYY-MM-DD') AS "expenseDate", r.description, r.receipt_name AS "receiptName",
  r.receipt_key IS NOT NULL AS "hasReceipt", r.status, r.decision_note AS "decisionNote", r.decided_at AS "decidedAt",
  du.name AS "decidedByName", r.decision_signature AS "decisionSignature", r.loan_id AS "loanId",
  r.paid_at AS "paidAt", pu.name AS "paidByName", r.created_at AS "createdAt"`;
const REQUEST_FROM = `
  FROM employee_requests r
  JOIN employees e ON e.id = r.employee_id
  JOIN branches b ON b.id = e.branch_id
  LEFT JOIN users du ON du.id = r.decided_by
  LEFT JOIN users pu ON pu.id = r.paid_by`;

async function loadRequest(id: string) {
  const row = await selectOne<{ id: string; employeeId: string; kind: string; status: string; amount: number; currency: string; months: number | null; startPeriod: string | null; receiptKey: string | null; receiptName: string | null; createdBy: string }>(
    `SELECT id, employee_id AS "employeeId", kind, status, amount::float AS amount, currency, months, start_period AS "startPeriod",
            receipt_key AS "receiptKey", receipt_name AS "receiptName", created_by AS "createdBy"
     FROM employee_requests WHERE id = :id`, { id },
  );
  if (!row) throw notFound('الطلب غير موجود.');
  return row;
}

export class RequestController {
  // ---------------------------------------------------------------- the employee's own side
  static async mine(req: Request, res: Response): Promise<void> {
    const rows = await select(`SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM} WHERE r.employee_id = :employeeId ORDER BY r.created_at DESC LIMIT 100`,
      { employeeId: ownEmployeeId(req) });
    res.json({ data: rows });
  }

  /** A loan request or a work-expense claim from the portal. */
  static async create(req: Request, res: Response): Promise<void> {
    const employeeId = ownEmployeeId(req);
    const input = body(req);
    assertOnlyKeys(input, ['kind', 'amount', 'currency', 'months', 'startPeriod', 'expenseDate', 'description']);
    const kind = input.kind === 'loan' || input.kind === 'expense' ? input.kind : null;
    if (!kind) throw badRequest('نوع الطلب غير صالح.');
    const amount = optionalNumber(input, 'amount', { min: 1, max: 1e11 });
    if (!amount) throw badRequest('أدخل المبلغ.');
    const currency = (optionalText(input, 'currency', 3) || (await getSettings()).payrollRules.baseCurrency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw badRequest('العملة غير صالحة.');
    const description = requiredText(input, 'description', 1000, kind === 'loan' ? 'سبب السلفة' : 'وصف المصروف');
    let months: number | null = null;
    let startPeriod: string | null = null;
    let expenseDate: string | null = null;
    if (kind === 'loan') {
      months = optionalNumber(input, 'months', { min: 1, max: 60 }) ?? null;
      if (!months || !Number.isInteger(months)) throw badRequest('حدد عدد أشهر التقسيط (1 إلى 60).');
      startPeriod = requiredText(input, 'startPeriod', 7, 'أول شهر استقطاع');
      periodBounds(startPeriod);
    } else {
      expenseDate = typeof input.expenseDate === 'string' ? input.expenseDate : '';
      if (!isDateOnly(expenseDate)) throw badRequest('حدد تاريخ المصروف.');
    }
    const id = randomUUID();
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO employee_requests (id, employee_id, kind, amount, currency, months, start_period, expense_date, description, created_by)
         VALUES (:id, :employeeId, :kind, :amount, :currency, :months, :startPeriod, :expenseDate, :description, :userId)`,
        { id, employeeId, kind, amount, currency, months, startPeriod, expenseDate, description, userId: req.user!.id }, tx,
      );
      await recordAudit(req, tx, `request.${kind}_submitted`, 'employee', employeeId, { requestId: id, amount, currency, months });
      await notifyPermission('requests.manage', {
        kind: 'request', title: kind === 'loan' ? 'طلب سلفة جديد' : 'طلب تكاليف عمل جديد', body: `${amount} ${currency}`, link: '/requests',
      }, tx, req.user!.id);
    });
    res.status(201).json({ data: { id } });
  }

  /** Receipt (PDF or photo) for an expense claim, by the employee while it is pending. */
  static async uploadReceipt(req: Request, res: Response): Promise<void> {
    const request = await loadRequest(req.params.id);
    if (request.employeeId !== ownEmployeeId(req)) throw notFound('الطلب غير موجود.');
    if (request.status !== 'pending') throw conflict('لا يُعدّل طلب بعد البت فيه.');
    if (!req.file) throw badRequest('أرفق الوصل.');
    const type = sniffFile(req.file.buffer, ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
    const key = await storeFile('requests', req.file.buffer, type.ext);
    await execute('UPDATE employee_requests SET receipt_key = :key, receipt_name = :name, updated_at = now() WHERE id = :id',
      { key, name: uploadedName(req.file, `receipt.${type.ext}`), id: request.id });
    res.json({ data: { id: request.id } });
  }

  static async cancelMine(req: Request, res: Response): Promise<void> {
    const request = await loadRequest(req.params.id);
    if (request.employeeId !== ownEmployeeId(req)) throw notFound('الطلب غير موجود.');
    if (request.status !== 'pending') throw conflict('يُلغى الطلب قبل البت فيه فقط.');
    await transaction(async (tx) => {
      await execute("UPDATE employee_requests SET status = 'cancelled', updated_at = now() WHERE id = :id", { id: request.id }, tx);
      await recordAudit(req, tx, 'request.cancelled', 'employee', request.employeeId, { requestId: request.id });
    });
    res.json({ data: { id: request.id } });
  }

  static async receipt(req: Request, res: Response): Promise<void> {
    const request = await loadRequest(req.params.id);
    const own = req.user?.employeeId === request.employeeId;
    if (!own) {
      if (!(await can(req, 'requests.manage')) && !(await can(req, 'payroll.disburse'))) throw forbidden();
      await employeeInScope(req, request.employeeId);
    }
    if (!request.receiptKey || !(await storedFileExists(request.receiptKey))) throw notFound('لا يوجد وصل مرفق.');
    res.setHeader('Content-Disposition', contentDisposition(request.receiptName || 'receipt', req.query.inline === '1'));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    openStoredFile(request.receiptKey).pipe(res);
  }

  /** Days, punches and leave for one month of the signed-in employee. */
  static async myAttendance(req: Request, res: Response): Promise<void> {
    const employeeId = ownEmployeeId(req);
    const period = typeof req.query.period === 'string' ? req.query.period : new Date().toISOString().slice(0, 7);
    const { start, end } = periodBounds(period);
    const days = await select(
      `SELECT to_char(work_date, 'YYYY-MM-DD') AS date, COALESCE(override_status, status) AS status,
              to_char(first_in, 'HH24:MI') AS "firstIn", to_char(last_out, 'HH24:MI') AS "lastOut", punch_count AS "punchCount",
              worked_minutes AS "workedMinutes", COALESCE(override_late_minutes, late_minutes) AS "lateMinutes",
              COALESCE(override_overtime_minutes, overtime_minutes) AS "overtimeMinutes", leave_type_name AS "leaveTypeName"
       FROM attendance_days WHERE employee_id = :employeeId AND work_date BETWEEN :start AND :end ORDER BY work_date`,
      { employeeId, start, end },
    );
    const punches = await select(
      `SELECT to_char(punched_at, 'YYYY-MM-DD') AS date, to_char(punched_at, 'HH24:MI') AS time, source
       FROM attendance_punches WHERE employee_id = :employeeId AND voided_at IS NULL
         AND punched_at >= :start::date AND punched_at < (:end::date + 1) ORDER BY punched_at`,
      { employeeId, start, end },
    );
    res.json({ data: { period, days, punches } });
  }

  // ---------------------------------------------------------------- HR side
  static async list(req: Request, res: Response): Promise<void> {
    const scope = employeeScopeSql(req);
    const status = typeof req.query.status === 'string' && ['pending', 'approved', 'rejected', 'paid', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    const kind = req.query.kind === 'loan' || req.query.kind === 'expense' ? req.query.kind : null;
    const rows = await select(
      `SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM}
       WHERE true${scope.sql} ${status ? 'AND r.status = :status' : ''} ${kind ? 'AND r.kind = :kind' : ''}
       ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 300`,
      { ...scope.params, status, kind },
    );
    res.json({ data: rows });
  }

  /**
   * HR approves or rejects, signing with their e-signature when one is saved.
   * An approved loan request becomes a loan that payroll deducts month by month.
   */
  static async decide(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['action', 'note', 'installment', 'startPeriod']);
    const action = input.action === 'approve' || input.action === 'reject' ? input.action : null;
    if (!action) throw badRequest('اختر الموافقة أو الرفض.');
    const note = optionalText(input, 'note', 500) ?? null;
    if (action === 'reject' && !note) throw badRequest('اكتب سبب الرفض.');
    const request = await loadRequest(req.params.id);
    await employeeInScope(req, request.employeeId);
    if (request.status !== 'pending') throw conflict('تم البت في هذا الطلب مسبقاً.');
    if (req.user!.employeeId === request.employeeId) throw forbidden('لا يبت أحد في طلبه الشخصي.');
    const signature = await userSignature(req.user!.id);
    await transaction(async (tx) => {
      let loanId: string | null = null;
      if (action === 'approve' && request.kind === 'loan') {
        const months = request.months ?? 1;
        const installment = optionalNumber(input, 'installment', { min: 1, max: 1e11 }) ?? Math.floor(request.amount / months);
        const startPeriod = optionalText(input, 'startPeriod', 7) || request.startPeriod!;
        periodBounds(startPeriod);
        loanId = randomUUID();
        await execute(
          `INSERT INTO employee_loans (id, employee_id, currency, principal, installment, installments_total, paid_before, start_period, reference, notes, created_by)
           VALUES (:loanId, :employeeId, :currency, :principal, :installment, :months, 0, :startPeriod, :reference, :notes, :userId)`,
          {
            loanId, employeeId: request.employeeId, currency: request.currency, principal: request.amount, installment, months,
            startPeriod, reference: `REQ-${request.id.slice(0, 8)}`, notes: `طلب سلفة من البوابة${note ? ` · ${note}` : ''}`, userId: req.user!.id,
          }, tx,
        );
      }
      await execute(
        `UPDATE employee_requests SET status = :status, decided_by = :userId, decided_at = now(), decision_note = :note,
                decision_signature = :signature, loan_id = :loanId, updated_at = now() WHERE id = :id AND status = 'pending'`,
        { status: action === 'approve' ? 'approved' : 'rejected', userId: req.user!.id, note, signature, loanId, id: request.id }, tx,
      );
      await recordAudit(req, tx, `request.${action === 'approve' ? 'approved' : 'rejected'}`, 'employee', request.employeeId, {
        requestId: request.id, kind: request.kind, amount: request.amount, loanId,
      });
      await notifyEmployees([request.employeeId], {
        kind: 'request', title: `${action === 'approve' ? 'تمت الموافقة على' : 'رُفض'} طلب ${request.kind === 'loan' ? 'السلفة' : 'تكاليف العمل'}`,
        body: note ?? null, link: '/my',
      }, tx);
      if (action === 'approve' && request.kind === 'expense') {
        await notifyPermission('payroll.disburse', { kind: 'request', title: 'مصروف معتمد بانتظار الصرف', link: '/requests' }, tx, req.user!.id);
      }
    });
    res.json({ data: { id: request.id } });
  }

  /** Finance records that an approved expense claim was paid. */
  static async markPaid(req: Request, res: Response): Promise<void> {
    const request = await loadRequest(req.params.id);
    await employeeInScope(req, request.employeeId);
    if (request.kind !== 'expense' || request.status !== 'approved') throw conflict('يُصرف المصروف بعد الموافقة عليه.');
    await transaction(async (tx) => {
      await execute("UPDATE employee_requests SET status = 'paid', paid_by = :userId, paid_at = now(), updated_at = now() WHERE id = :id",
        { userId: req.user!.id, id: request.id }, tx);
      await recordAudit(req, tx, 'request.expense_paid', 'employee', request.employeeId, { requestId: request.id, amount: request.amount });
      await notifyEmployees([request.employeeId], { kind: 'request', title: 'صُرف مبلغ تكاليف العمل', link: '/my' }, tx);
    });
    res.json({ data: { id: request.id } });
  }

  // ---------------------------------------------------------------- portal accounts
  /** Every employee with whether they have a portal account yet. */
  static async portalAccounts(req: Request, res: Response): Promise<void> {
    const scope = employeeScopeSql(req);
    const rows = await select(
      `SELECT e.id, e.employee_no AS "employeeNo", e.full_name AS "fullName", e.phone, b.name AS "branchName",
              u.id AS "userId", u.username, u.role, u.is_active AS "isActive", u.last_login_at AS "lastLoginAt",
              EXISTS (SELECT 1 FROM password_setup_tokens t WHERE t.user_id = u.id AND t.used_at IS NULL AND t.expires_at > now()) AS "invitePending"
       FROM employees e JOIN branches b ON b.id = e.branch_id LEFT JOIN users u ON u.employee_id = e.id
       WHERE e.employment_status <> 'inactive'${scope.sql}
       ORDER BY b.name, e.employee_no`,
      scope.params,
    );
    res.json({ data: rows });
  }

  /**
   * Creates the employee's portal account if needed (signs in with the
   * employee number) and returns a one-week link to choose a password.
   * The link is shown to HR to send; nothing is sent automatically.
   */
  static async invite(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.employeeId);
    const result = await transaction(async (tx) => {
      let user = await selectOne<{ id: string; role: string }>('SELECT id, role FROM users WHERE employee_id = :id', { id: employee.id }, tx);
      if (!user) {
        const username = employee.employeeNo.trim();
        if (await selectOne('SELECT 1 FROM users WHERE lower(username) = lower(:username)', { username }, tx)) {
          throw conflict(`اسم الدخول ${username} مستخدم لحساب آخر.`);
        }
        const id = randomUUID();
        // A random password nobody knows; the employee sets their own through the link.
        const passwordHash = await bcrypt.hash(randomToken(24), 12);
        await execute(
          `INSERT INTO users (id, name, email, password_hash, role, branch_id, is_active, token_version, created_at, updated_at, employee_id, username)
           VALUES (:id, :name, :email, :passwordHash, 'employee', NULL, true, 0, now(), now(), :employeeId, :username)`,
          { id, name: employee.fullName, email: `emp-${username.toLowerCase().replace(/[^a-z0-9._-]/g, '')}@portal.local`, passwordHash, employeeId: employee.id, username },
          tx,
        );
        user = { id, role: 'employee' };
        await recordAudit(req, tx, 'user.portal_account_created', 'user', id, { employeeId: employee.id, username });
      }
      await recordAudit(req, tx, 'user.portal_invite_created', 'user', user.id, { employeeId: employee.id });
      return user;
    });
    const token = await createSetupToken(result.id, INVITE_MINUTES);
    res.json({ data: { path: `/#/set-password/${token}`, username: employee.employeeNo, validDays: 7 } });
  }
}

export default RequestController;
