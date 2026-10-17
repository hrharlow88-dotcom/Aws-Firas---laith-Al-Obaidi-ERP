import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { Transaction } from 'sequelize';
import { ApprovalStepRule } from '../config/systemSettings';
import { execute, select, selectOne, transaction } from '../db/query';
import { notifyUsers } from '../services/notify';
import { can, getSettings } from '../services/settings';
import { contentDisposition, openStoredFile, sniffFile, storedFileExists, storeFile, uploadedName } from '../services/storage';
import { ROLES, UserRole } from '../types';
import { recordAudit } from '../utils/audit';
import { badRequest, body, conflict, forbidden, notFound, optionalNumber, optionalText, requiredText } from '../utils/http';
import { isDateOnly, isUuid } from '../utils/validation';

type Kind = 'approval' | 'expense';
interface ResolvedStep { type: string; role?: string; userId?: string; label: string; approvers: string[] }
interface RequestRow {
  id: string; number: string; entityType: Kind; requesterId: string; employeeId: string | null; title: string; status: string;
  steps: ResolvedStep[]; currentStep: number; amount: number | null; currency: string | null;
}

const ROLE_LABEL: Partial<Record<UserRole, string>> = {
  finance: 'المالية', hr_manager: 'مدير الموارد البشرية', executive: 'الإدارة العليا', super_admin: 'مالك النظام',
  payroll_officer: 'مسؤول الرواتب', auditor: 'التدقيق', branch_manager: 'مدير الفرع', it_admin: 'تقنية المعلومات',
};
const MONEY = /^[A-Z]{3}$/;

function validSteps(value: unknown): ApprovalStepRule[] {
  if (!Array.isArray(value) || !value.length || value.length > 6) throw badRequest('حدد خطوات الموافقة (1 إلى 6).');
  return value.map((raw) => {
    const step = raw as Record<string, unknown>;
    if (step.type === 'manager') return { type: 'manager' };
    if (step.type === 'role' && typeof step.role === 'string' && (ROLES as readonly string[]).includes(step.role)) return { type: 'role', role: step.role as UserRole };
    if (step.type === 'user' && isUuid(step.userId)) return { type: 'user', userId: String(step.userId) };
    throw badRequest('خطوة موافقة غير صالحة.');
  });
}

/** Turns the rule (manager / a role / a person) into the accounts that may decide that step. */
async function resolveSteps(rules: ApprovalStepRule[], requesterId: string, employeeId: string | null, tx?: Transaction): Promise<ResolvedStep[]> {
  const out: ResolvedStep[] = [];
  for (const rule of rules) {
    let approvers: string[] = [];
    let label = '';
    if (rule.type === 'manager') {
      label = 'المدير المباشر';
      if (employeeId) {
        approvers = (await select<{ id: string }>(
          `SELECT u.id FROM employees e JOIN users u ON u.employee_id = e.manager_id AND u.is_active WHERE e.id = :employeeId`, { employeeId }, tx,
        )).map((row) => row.id);
      }
    } else if (rule.type === 'role') {
      label = ROLE_LABEL[rule.role!] ?? rule.role!;
      approvers = (await select<{ id: string }>('SELECT id FROM users WHERE role = :role AND is_active AND NOT is_demo', { role: rule.role }, tx)).map((row) => row.id);
    } else {
      const user = await selectOne<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = :id AND is_active', { id: rule.userId }, tx);
      label = user?.name ?? 'مستخدم';
      approvers = user ? [user.id] : [];
    }
    approvers = approvers.filter((id) => id !== requesterId);
    // A step nobody can decide (no manager account, nobody in that role) is skipped rather than blocking the request.
    if (approvers.length) out.push({ ...rule, label, approvers });
  }
  if (!out.length) {
    const owners = (await select<{ id: string }>("SELECT id FROM users WHERE role = 'super_admin' AND is_active AND NOT is_demo AND id <> :requesterId", { requesterId }, tx)).map((row) => row.id);
    if (!owners.length) throw badRequest('لا يوجد من يعتمد هذا الطلب.');
    out.push({ type: 'role', role: 'super_admin', label: 'مالك النظام', approvers: owners });
  }
  return out;
}

async function nextNumber(kind: Kind, tx: Transaction): Promise<string> {
  const prefix = kind === 'expense' ? 'EXP' : 'APR';
  const last = await selectOne<{ n: number }>(
    `SELECT COALESCE(MAX(substring(number FROM '[0-9]+$')::int), 0) AS n FROM approval_requests WHERE number LIKE :like`, { like: `${prefix}-%` }, tx,
  );
  return `${prefix}-${String((last?.n ?? 0) + 1).padStart(5, '0')}`;
}

async function loadRequest(id: string, tx?: Transaction, lock = false): Promise<RequestRow> {
  if (!isUuid(id)) throw notFound('الطلب غير موجود.');
  const row = await selectOne<RequestRow>(
    `SELECT id, number, entity_type AS "entityType", requester_id AS "requesterId", employee_id AS "employeeId", title, status, steps,
            current_step AS "currentStep", amount::float AS amount, currency
     FROM approval_requests WHERE id = :id${lock ? ' FOR UPDATE' : ''}`, { id }, tx,
  );
  if (!row) throw notFound('الطلب غير موجود.');
  return row;
}

async function mayView(req: Request, row: RequestRow): Promise<boolean> {
  if (req.user!.role === 'super_admin' || row.requesterId === req.user!.id) return true;
  if (row.steps.some((step) => step.approvers.includes(req.user!.id))) return true;
  return row.entityType === 'expense' ? can(req, 'payroll.disburse') : false;
}

const LIST_COLUMNS = `
  r.id, r.number, r.entity_type AS "entityType", r.title, r.status, r.amount::float AS amount, r.currency,
  to_char(r.date_from, 'YYYY-MM-DD') AS "dateFrom", to_char(r.date_to, 'YYYY-MM-DD') AS "dateTo",
  r.current_step AS "currentStep", r.steps, r.created_at AS "createdAt", r.updated_at AS "updatedAt",
  c.name_ar AS "categoryName", c.code AS "categoryCode", u.name AS "requesterName", e.full_name AS "employeeName", e.employee_no AS "employeeNo",
  r.attachment_name AS "attachmentName", r.payment_mode AS "paymentMode", r.paid_at AS "paidAt"`;

/**
 * Approvals (purchase, business trip, borrowed items, anything) and expense
 * reports: each goes through its approvers in order (direct manager, a role,
 * or a named person); every decision is recorded, the next approver is told,
 * and the requester follows it to the end. Expenses are then paid out.
 */
export class ApprovalRequestController {
  static async categories(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT id, code, name_ar AS "nameAr", name_en AS "nameEn", description, steps, needs_amount AS "needsAmount", needs_dates AS "needsDates",
              needs_attachment AS "needsAttachment", is_active AS "isActive", sort_order AS "sortOrder"
       FROM approval_categories ORDER BY sort_order, name_ar`,
    );
    res.json({ data: rows });
  }

  static async saveCategory(req: Request, res: Response): Promise<void> {
    const input = body(req);
    const code = requiredText(input, 'code', 20, 'الرمز').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (!code) throw badRequest('الرمز غير صالح.');
    const values = {
      code, nameAr: requiredText(input, 'nameAr', 120, 'الاسم'), nameEn: optionalText(input, 'nameEn', 120) ?? null,
      description: optionalText(input, 'description', 500) ?? null, steps: JSON.stringify(validSteps(input.steps)),
      needsAmount: input.needsAmount === true, needsDates: input.needsDates === true, needsAttachment: input.needsAttachment === true,
      isActive: input.isActive !== false, sortOrder: Number(input.sortOrder) || 0,
    };
    const id = req.params.id ?? randomUUID();
    if (req.params.id) {
      const rows = await execute(
        `UPDATE approval_categories SET code = :code, name_ar = :nameAr, name_en = :nameEn, description = :description, steps = :steps::jsonb,
           needs_amount = :needsAmount, needs_dates = :needsDates, needs_attachment = :needsAttachment, is_active = :isActive, sort_order = :sortOrder
         WHERE id = :id RETURNING id`, { ...values, id },
      );
      if (!rows.length) throw notFound('النوع غير موجود.');
    } else {
      if (await selectOne('SELECT 1 FROM approval_categories WHERE code = :code', { code })) throw conflict('الرمز مستخدم.');
      await execute(
        `INSERT INTO approval_categories (id, code, name_ar, name_en, description, steps, needs_amount, needs_dates, needs_attachment, is_active, sort_order)
         VALUES (:id, :code, :nameAr, :nameEn, :description, :steps::jsonb, :needsAmount, :needsDates, :needsAttachment, :isActive, :sortOrder)`, { ...values, id },
      );
    }
    await recordAudit(req, null, 'approvals.category_saved', 'approval_category', id, { code });
    res.status(req.params.id ? 200 : 201).json({ data: { id } });
  }

  /** box = mine (what I asked for), todo (waiting for me), all (owner; finance for expenses). */
  static async list(req: Request, res: Response): Promise<void> {
    const kind: Kind = req.path.startsWith('/expenses') ? 'expense' : 'approval';
    const box = typeof req.query.box === 'string' ? req.query.box : 'mine';
    const userId = req.user!.id;
    let where = 'r.requester_id = :userId';
    if (box === 'todo') {
      where = "r.status = 'pending' AND jsonb_exists(r.steps -> r.current_step -> 'approvers', :userIdText)";
    } else if (box === 'all') {
      const allowed = req.user!.role === 'super_admin' || (kind === 'expense' && (await can(req, 'payroll.disburse')));
      if (!allowed) throw forbidden();
      where = 'true';
    } else if (box === 'topay') {
      if (!(req.user!.role === 'super_admin' || (await can(req, 'payroll.disburse')))) throw forbidden();
      where = "r.status = 'approved'";
    }
    const rows = await select(
      `SELECT ${LIST_COLUMNS} FROM approval_requests r
       LEFT JOIN approval_categories c ON c.id = r.category_id JOIN users u ON u.id = r.requester_id LEFT JOIN employees e ON e.id = r.employee_id
       WHERE r.entity_type = :kind AND ${where}
       ORDER BY r.created_at DESC LIMIT 300`,
      { kind, userId, userIdText: userId },
    );
    const counts = await selectOne<{ todo: number; mine: number }>(
      `SELECT count(*) FILTER (WHERE status = 'pending' AND jsonb_exists(steps -> current_step -> 'approvers', :userId))::int AS todo,
              count(*) FILTER (WHERE requester_id = :userId::uuid AND status IN ('pending','draft'))::int AS mine
       FROM approval_requests WHERE entity_type = :kind`, { kind, userId },
    );
    res.json({ data: { rows, counts } });
  }

  static async get(req: Request, res: Response): Promise<void> {
    const row = await loadRequest(req.params.id);
    if (!(await mayView(req, row))) throw notFound('الطلب غير موجود.');
    const detail = await selectOne<Record<string, unknown>>(
      `SELECT ${LIST_COLUMNS}, r.details, r.requester_id AS "requesterId" FROM approval_requests r
       LEFT JOIN approval_categories c ON c.id = r.category_id JOIN users u ON u.id = r.requester_id LEFT JOIN employees e ON e.id = r.employee_id
       WHERE r.id = :id`, { id: row.id },
    );
    const actions = await select(
      `SELECT a.step, a.decision, a.note, a.at, u.name AS "userName" FROM approval_actions a JOIN users u ON u.id = a.user_id
       WHERE a.request_id = :id ORDER BY a.at`, { id: row.id },
    );
    const lines = row.entityType === 'expense' ? await select(
      `SELECT id, to_char(expense_date, 'YYYY-MM-DD') AS "expenseDate", category, description, amount::float AS amount, receipt_name AS "receiptName"
       FROM expense_lines WHERE request_id = :id ORDER BY expense_date, description`, { id: row.id },
    ) : [];
    const current = row.steps[row.currentStep];
    res.json({
      data: {
        ...detail, actions, lines,
        canDecide: row.status === 'pending' && Boolean(current?.approvers.includes(req.user!.id)),
        canPay: row.entityType === 'expense' && row.status === 'approved' && (req.user!.role === 'super_admin' || (await can(req, 'payroll.disburse'))),
        isMine: row.requesterId === req.user!.id,
      },
    });
  }

  /** A new approval request (multipart: the attachment is optional unless the type requires it). */
  static async create(req: Request, res: Response): Promise<void> {
    const input = body(req);
    if (!isUuid(input.categoryId)) throw badRequest('اختر نوع الطلب.');
    const category = await selectOne<{ id: string; nameAr: string; steps: ApprovalStepRule[]; needsAmount: boolean; needsDates: boolean; needsAttachment: boolean; isActive: boolean }>(
      `SELECT id, name_ar AS "nameAr", steps, needs_amount AS "needsAmount", needs_dates AS "needsDates", needs_attachment AS "needsAttachment", is_active AS "isActive"
       FROM approval_categories WHERE id = :id`, { id: input.categoryId },
    );
    if (!category || !category.isActive) throw badRequest('نوع الطلب غير متاح.');
    const title = requiredText(input, 'title', 200, 'العنوان');
    const amount = input.amount === undefined || input.amount === '' ? null : optionalNumber({ amount: Number(input.amount) }, 'amount', { min: 0.01, max: 1e12 }) ?? null;
    const currency = amount !== null ? String(input.currency || 'IQD').toUpperCase() : null;
    if (currency && !MONEY.test(currency)) throw badRequest('العملة غير صالحة.');
    if (category.needsAmount && amount === null) throw badRequest('أدخل المبلغ.');
    const dateFrom = typeof input.dateFrom === 'string' && isDateOnly(input.dateFrom) ? input.dateFrom : null;
    const dateTo = typeof input.dateTo === 'string' && isDateOnly(input.dateTo) ? input.dateTo : dateFrom;
    if (category.needsDates && !dateFrom) throw badRequest('حدد التاريخ.');
    if (dateFrom && dateTo && dateTo < dateFrom) throw badRequest('تاريخ النهاية قبل البداية.');
    let attachmentKey: string | null = null;
    let attachmentName: string | null = null;
    if (req.file) {
      const type = sniffFile(req.file.buffer, ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
      attachmentKey = await storeFile('approvals', req.file.buffer, type.ext);
      attachmentName = uploadedName(req.file, `attachment.${type.ext}`);
    } else if (category.needsAttachment) {
      throw badRequest('أرفق المستند المطلوب (PDF أو صورة).');
    }
    const id = randomUUID();
    let number = '';
    let firstApprovers: string[] = [];
    await transaction(async (tx) => {
      const steps = await resolveSteps(category.steps, req.user!.id, req.user!.employeeId ?? null, tx);
      firstApprovers = steps[0].approvers;
      number = await nextNumber('approval', tx);
      await execute(
        `INSERT INTO approval_requests (id, number, category_id, entity_type, requester_id, employee_id, title, details, amount, currency, date_from, date_to,
           attachment_key, attachment_name, steps, status)
         VALUES (:id, :number, :categoryId, 'approval', :userId, :employeeId, :title, :details, :amount, :currency, :dateFrom, :dateTo,
           :attachmentKey, :attachmentName, :steps::jsonb, 'pending')`,
        {
          id, number, categoryId: category.id, userId: req.user!.id, employeeId: req.user!.employeeId ?? null, title,
          details: optionalText(input, 'details', 4000) ?? null, amount, currency, dateFrom, dateTo, attachmentKey, attachmentName, steps: JSON.stringify(steps),
        }, tx,
      );
      await execute(`INSERT INTO approval_actions (id, request_id, step, user_id, decision) VALUES (:aid, :id, 0, :userId, 'submitted')`,
        { aid: randomUUID(), id, userId: req.user!.id }, tx);
      await notifyUsers(firstApprovers, { kind: 'approval', title: `طلب ${category.nameAr} بانتظار موافقتك: ${title}`, body: `${number} — ${req.user!.name}`, link: `/approval-requests/${id}` }, tx);
      await recordAudit(req, tx, 'approvals.request_created', 'approval_request', id, { number, category: category.nameAr, amount, currency });
    });
    res.status(201).json({ data: { id, number } });
  }

  /** Expense report: a draft with lines (each may carry a receipt), submitted when ready. */
  static async createExpense(req: Request, res: Response): Promise<void> {
    const input = body(req);
    const title = requiredText(input, 'title', 200, 'عنوان التقرير');
    const currency = String(input.currency || 'IQD').toUpperCase();
    if (!MONEY.test(currency)) throw badRequest('العملة غير صالحة.');
    const id = randomUUID();
    let number = '';
    await transaction(async (tx) => {
      number = await nextNumber('expense', tx);
      await execute(
        `INSERT INTO approval_requests (id, number, entity_type, requester_id, employee_id, title, details, amount, currency, steps, status)
         VALUES (:id, :number, 'expense', :userId, :employeeId, :title, :details, 0, :currency, '[]', 'draft')`,
        { id, number, userId: req.user!.id, employeeId: req.user!.employeeId ?? null, title, details: optionalText(input, 'details', 2000) ?? null, currency }, tx,
      );
      await recordAudit(req, tx, 'expenses.created', 'approval_request', id, { number });
    });
    res.status(201).json({ data: { id, number } });
  }

  static async addExpenseLine(req: Request, res: Response): Promise<void> {
    const row = await loadRequest(req.params.id);
    if (row.entityType !== 'expense' || row.requesterId !== req.user!.id) throw notFound('التقرير غير موجود.');
    if (row.status !== 'draft') throw conflict('لا يُعدّل التقرير بعد إرساله.');
    const input = body(req);
    const settings = await getSettings();
    const expenseDate = String(input.expenseDate || '');
    if (!isDateOnly(expenseDate)) throw badRequest('تاريخ المصروف غير صالح.');
    const category = String(input.category || '');
    if (!settings.hr.expenseCategories.includes(category)) throw badRequest('اختر فئة المصروف.');
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw badRequest('المبلغ غير صالح.');
    let receiptKey: string | null = null;
    let receiptName: string | null = null;
    if (req.file) {
      const type = sniffFile(req.file.buffer, ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
      receiptKey = await storeFile('expenses', req.file.buffer, type.ext);
      receiptName = uploadedName(req.file, `receipt.${type.ext}`);
    }
    const lineId = randomUUID();
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO expense_lines (id, request_id, expense_date, category, description, amount, receipt_key, receipt_name)
         VALUES (:lineId, :id, :expenseDate, :category, :description, :amount, :receiptKey, :receiptName)`,
        { lineId, id: row.id, expenseDate, category, description: requiredText(input, 'description', 300, 'الوصف'), amount, receiptKey, receiptName }, tx,
      );
      await execute('UPDATE approval_requests SET amount = (SELECT SUM(amount) FROM expense_lines WHERE request_id = :id), updated_at = now() WHERE id = :id', { id: row.id }, tx);
    });
    res.status(201).json({ data: { id: lineId } });
  }

  static async removeExpenseLine(req: Request, res: Response): Promise<void> {
    const row = await loadRequest(req.params.id);
    if (row.entityType !== 'expense' || row.requesterId !== req.user!.id || row.status !== 'draft') throw conflict('لا يمكن الحذف.');
    await transaction(async (tx) => {
      await execute('DELETE FROM expense_lines WHERE id = :lineId AND request_id = :id', { lineId: req.params.lineId, id: row.id }, tx);
      await execute('UPDATE approval_requests SET amount = COALESCE((SELECT SUM(amount) FROM expense_lines WHERE request_id = :id), 0), updated_at = now() WHERE id = :id', { id: row.id }, tx);
    });
    res.json({ data: { ok: true } });
  }

  static async submitExpense(req: Request, res: Response): Promise<void> {
    const settings = await getSettings();
    let number = '';
    await transaction(async (tx) => {
      const row = await loadRequest(req.params.id, tx, true);
      if (row.entityType !== 'expense' || row.requesterId !== req.user!.id) throw notFound('التقرير غير موجود.');
      if (row.status !== 'draft') throw conflict('أُرسل التقرير مسبقاً.');
      const lines = await selectOne<{ n: number }>('SELECT count(*)::int AS n FROM expense_lines WHERE request_id = :id', { id: row.id }, tx);
      if (!lines?.n) throw badRequest('أضف مصروفاً واحداً على الأقل.');
      const steps = await resolveSteps(settings.hr.expenseSteps, req.user!.id, row.employeeId, tx);
      number = row.number;
      await execute(`UPDATE approval_requests SET steps = :steps::jsonb, current_step = 0, status = 'pending', updated_at = now() WHERE id = :id`,
        { id: row.id, steps: JSON.stringify(steps) }, tx);
      await execute(`INSERT INTO approval_actions (id, request_id, step, user_id, decision) VALUES (:aid, :id, 0, :userId, 'submitted')`,
        { aid: randomUUID(), id: row.id, userId: req.user!.id }, tx);
      await notifyUsers(steps[0].approvers, { kind: 'approval', title: `تقرير مصاريف بانتظار موافقتك: ${row.title}`, body: `${row.number} — ${row.amount} ${row.currency} — ${req.user!.name}`, link: `/expenses/${row.id}` }, tx);
      await recordAudit(req, tx, 'expenses.submitted', 'approval_request', row.id, { number: row.number, amount: row.amount });
    });
    res.json({ data: { number } });
  }

  /** Approve or refuse the current step; the last approval completes the request. */
  static async decide(req: Request, res: Response): Promise<void> {
    const input = body(req);
    const decision = input.decision === 'approved' ? 'approved' : input.decision === 'refused' ? 'refused' : null;
    if (!decision) throw badRequest('القرار غير صالح.');
    const note = optionalText(input, 'note', 500) ?? null;
    if (decision === 'refused' && !note) throw badRequest('اكتب سبب الرفض.');
    await transaction(async (tx) => {
      const row = await loadRequest(req.params.id, tx, true);
      if (row.status !== 'pending') throw conflict('الطلب ليس بانتظار قرار.');
      const step = row.steps[row.currentStep];
      if (!step?.approvers.includes(req.user!.id)) throw forbidden('هذه الخطوة ليست بانتظارك.');
      await execute(`INSERT INTO approval_actions (id, request_id, step, user_id, decision, note) VALUES (:aid, :id, :step, :userId, :decision, :note)`,
        { aid: randomUUID(), id: row.id, step: row.currentStep, userId: req.user!.id, decision, note }, tx);
      const link = row.entityType === 'expense' ? `/expenses/${row.id}` : `/approval-requests/${row.id}`;
      const done = decision === 'refused' || row.currentStep + 1 >= row.steps.length;
      if (done) {
        await execute(`UPDATE approval_requests SET status = :status, updated_at = now() WHERE id = :id`, { id: row.id, status: decision }, tx);
        await notifyUsers([row.requesterId], {
          kind: 'approval', title: decision === 'approved' ? `اعتُمد طلبك ${row.number}` : `رُفض طلبك ${row.number}`,
          body: decision === 'approved' ? row.title : `${row.title} — السبب: ${note}`, link,
        }, tx);
        if (decision === 'approved' && row.entityType === 'expense') {
          const payers = await select<{ id: string }>("SELECT id FROM users WHERE role IN ('finance','super_admin') AND is_active AND NOT is_demo", {}, tx);
          await notifyUsers(payers.map((user) => user.id), { kind: 'approval', title: `مصاريف معتمدة للصرف: ${row.number}`, body: `${row.amount} ${row.currency}`, link }, tx);
        }
      } else {
        await execute(`UPDATE approval_requests SET current_step = current_step + 1, updated_at = now() WHERE id = :id`, { id: row.id }, tx);
        const next = row.steps[row.currentStep + 1];
        await notifyUsers(next.approvers, { kind: 'approval', title: `${row.number} بانتظار موافقتك (${next.label})`, body: row.title, link }, tx);
        await notifyUsers([row.requesterId], { kind: 'approval', title: `${row.number}: وافق ${req.user!.name}`, body: `بانتظار ${next.label}`, link }, tx);
      }
      await recordAudit(req, tx, `approvals.${decision}`, 'approval_request', row.id, { number: row.number, step: row.currentStep, note });
    });
    res.json({ data: { ok: true } });
  }

  static async cancel(req: Request, res: Response): Promise<void> {
    await transaction(async (tx) => {
      const row = await loadRequest(req.params.id, tx, true);
      if (row.requesterId !== req.user!.id && req.user!.role !== 'super_admin') throw forbidden();
      if (!['draft', 'pending'].includes(row.status)) throw conflict('لا يُلغى طلب بعد القرار النهائي.');
      await execute(`UPDATE approval_requests SET status = 'cancelled', updated_at = now() WHERE id = :id`, { id: row.id }, tx);
      await execute(`INSERT INTO approval_actions (id, request_id, step, user_id, decision) VALUES (:aid, :id, :step, :userId, 'cancelled')`,
        { aid: randomUUID(), id: row.id, step: row.currentStep, userId: req.user!.id }, tx);
      await recordAudit(req, tx, 'approvals.cancelled', 'approval_request', row.id, { number: row.number });
    });
    res.json({ data: { ok: true } });
  }

  /** Finance records the reimbursement: in cash / transfer, or with the next salary. */
  static async pay(req: Request, res: Response): Promise<void> {
    if (!(req.user!.role === 'super_admin' || (await can(req, 'payroll.disburse')))) throw forbidden();
    const mode = body(req).mode === 'payroll' ? 'payroll' : 'cash';
    await transaction(async (tx) => {
      const row = await loadRequest(req.params.id, tx, true);
      if (row.entityType !== 'expense' || row.status !== 'approved') throw conflict('التقرير غير معتمد للصرف.');
      await execute(`UPDATE approval_requests SET status = 'paid', paid_by = :userId, paid_at = now(), payment_mode = :mode, updated_at = now() WHERE id = :id`,
        { id: row.id, userId: req.user!.id, mode }, tx);
      await execute(`INSERT INTO approval_actions (id, request_id, step, user_id, decision) VALUES (:aid, :id, :step, :userId, 'paid')`,
        { aid: randomUUID(), id: row.id, step: row.currentStep, userId: req.user!.id }, tx);
      await notifyUsers([row.requesterId], { kind: 'approval', title: `صُرفت مصاريفك ${row.number}`, body: mode === 'payroll' ? 'تُضاف مع الراتب.' : 'نقداً أو تحويلاً.', link: `/expenses/${row.id}` }, tx);
      await recordAudit(req, tx, 'expenses.paid', 'approval_request', row.id, { number: row.number, amount: row.amount, mode });
    });
    res.json({ data: { ok: true } });
  }

  static async file(req: Request, res: Response): Promise<void> {
    const row = await loadRequest(req.params.id);
    if (!(await mayView(req, row))) throw notFound('الطلب غير موجود.');
    const file = req.params.lineId
      ? await selectOne<{ key: string | null; name: string | null }>('SELECT receipt_key AS key, receipt_name AS name FROM expense_lines WHERE id = :lineId AND request_id = :id', { lineId: req.params.lineId, id: row.id })
      : await selectOne<{ key: string | null; name: string | null }>('SELECT attachment_key AS key, attachment_name AS name FROM approval_requests WHERE id = :id', { id: row.id });
    if (!file?.key || !(await storedFileExists(file.key))) throw notFound('لا يوجد مرفق.');
    const ext = file.key.split('.').pop();
    res.setHeader('Content-Type', ext === 'pdf' ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}`);
    res.setHeader('Content-Disposition', contentDisposition(file.name ?? 'file', true));
    res.setHeader('Cache-Control', 'private, no-store');
    openStoredFile(file.key).pipe(res);
  }
}

export default ApprovalRequestController;
