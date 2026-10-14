import { Request, Response } from 'express';
import { execute, select, selectOne, transaction } from '../db/query';
import { createPayrollJournal, loadMappings, NET_PAY_KEY, processJournalQueue } from '../services/finance';
import {
  listAccounts, listCostCenters, sapConfigured, sapLocalCurrency, SapError, testConnection,
} from '../services/sapB1';
import { getSettings } from '../services/settings';
import { recordAudit } from '../utils/audit';
import { assertOnlyKeys, badRequest, body, conflict, notFound, requiredText } from '../utils/http';
import { isUuid } from '../utils/validation';

const ACCOUNT_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;
let accountCache: { at: number; accounts: Array<{ code: string; name: string }> } | null = null;

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

async function entryOr404(id: string) {
  if (!isUuid(id)) throw notFound('القيد غير موجود.');
  const entry = await selectOne<{ id: string; status: string; sourceId: string; reference: string }>(
    'SELECT id, status, source_id AS "sourceId", reference FROM journal_entries WHERE id = :id',
    { id },
  );
  if (!entry) throw notFound('القيد غير موجود.');
  return entry;
}

export class FinanceController {
  /** Every payroll component plus net pay, with the accounts mapped to it. */
  static async listMappings(_req: Request, res: Response): Promise<void> {
    const settings = await getSettings();
    const mappings = await loadMappings();
    const rows = [
      ...settings.payrollRules.components.map((component) => ({
        mappingKey: component.id,
        label: component.name,
        category: component.category,
        active: component.active,
        side: component.category === 'earning' ? 'debit' : 'credit',
      })),
      { mappingKey: NET_PAY_KEY, label: 'صافي الرواتب المستحقة', category: 'net', active: true, side: 'credit' },
    ].map((row) => {
      const saved = mappings.get(row.mappingKey);
      return {
        ...row,
        debitAccount: saved?.debitAccount ?? null,
        creditAccount: saved?.creditAccount ?? null,
        useCostCenter: saved?.useCostCenter ?? row.category === 'earning',
      };
    });
    res.json({ data: rows });
  }

  static async saveMappings(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['mappings']);
    const list = input.mappings;
    if (!Array.isArray(list) || list.length > 200) throw badRequest('أرسل قائمة ربط الحسابات.');
    const settings = await getSettings();
    const labels = new Map<string, string>([
      ...settings.payrollRules.components.map((component) => [component.id, component.name] as [string, string]),
      [NET_PAY_KEY, 'صافي الرواتب المستحقة'],
    ]);
    const rows = list.map((item) => {
      if (!item || typeof item !== 'object') throw badRequest('بيانات الربط غير صالحة.');
      const entry = item as Record<string, unknown>;
      const key = String(entry.mappingKey ?? '');
      if (!labels.has(key)) throw badRequest('مكوّن غير معروف في ربط الحسابات.', { mappingKey: key });
      const account = (field: string) => {
        const value = entry[field];
        if (value === null || value === undefined || value === '') return null;
        if (typeof value !== 'string' || !ACCOUNT_PATTERN.test(value.trim())) throw badRequest('رمز الحساب غير صالح.', { mappingKey: key });
        return value.trim();
      };
      return {
        mappingKey: key,
        label: labels.get(key)!,
        debitAccount: account('debitAccount'),
        creditAccount: account('creditAccount'),
        useCostCenter: entry.useCostCenter !== false,
      };
    });
    await transaction(async (tx) => {
      for (const row of rows) {
        await execute(
          `INSERT INTO finance_account_mappings (mapping_key, label, debit_account, credit_account, use_cost_center, updated_by, updated_at)
           VALUES (:mappingKey, :label, :debitAccount, :creditAccount, :useCostCenter, :userId, now())
           ON CONFLICT (mapping_key) DO UPDATE SET label = EXCLUDED.label, debit_account = EXCLUDED.debit_account,
             credit_account = EXCLUDED.credit_account, use_cost_center = EXCLUDED.use_cost_center,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
          { ...row, userId: req.user!.id },
          tx,
        );
      }
      await recordAudit(req, tx, 'finance.mappings_updated', 'finance_account_mappings', null, { mappings: rows });
    });
    res.json({ data: { saved: rows.length } });
  }

  static async sapStatus(_req: Request, res: Response): Promise<void> {
    if (!sapConfigured()) {
      res.json({ data: { configured: false, localCurrency: sapLocalCurrency() } });
      return;
    }
    try {
      await testConnection();
      res.json({ data: { configured: true, connected: true, localCurrency: sapLocalCurrency(), companyDb: process.env.SAP_B1_COMPANY_DB } });
    } catch (error) {
      res.json({ data: { configured: true, connected: false, localCurrency: sapLocalCurrency(), error: error instanceof Error ? error.message : 'error' } });
    }
  }

  static async sapAccounts(_req: Request, res: Response): Promise<void> {
    if (!sapConfigured()) throw conflict('لم يُضبط الاتصال بـ SAP على الخادم.');
    if (!accountCache || Date.now() - accountCache.at > 10 * 60000) {
      try {
        accountCache = { at: Date.now(), accounts: await listAccounts() };
      } catch (error) {
        throw conflict(error instanceof SapError ? error.message : 'تعذر جلب دليل الحسابات من SAP.');
      }
    }
    res.json({ data: accountCache.accounts });
  }

  static async sapCostCenters(_req: Request, res: Response): Promise<void> {
    if (!sapConfigured()) throw conflict('لم يُضبط الاتصال بـ SAP على الخادم.');
    try {
      res.json({ data: await listCostCenters() });
    } catch (error) {
      throw conflict(error instanceof SapError ? error.message : 'تعذر جلب مراكز الكلفة من SAP.');
    }
  }

  static async listJournals(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT j.id, j.reference, j.source_type AS "sourceType", j.source_id AS "sourceId", r.period,
              to_char(j.entry_date, 'YYYY-MM-DD') AS "entryDate", j.memo, j.currency, j.total_debit::float AS "total",
              j.status, j.attempts, j.last_error AS "lastError", j.sap_trans_id AS "sapTransId",
              j.next_attempt_at AS "nextAttemptAt", j.posted_at AS "postedAt", j.created_at AS "createdAt",
              u.name AS "createdByName", q.name AS "queuedByName"
       FROM journal_entries j
       JOIN users u ON u.id = j.created_by
       LEFT JOIN users q ON q.id = j.queued_by
       LEFT JOIN payroll_runs r ON j.source_type = 'payroll' AND r.id = j.source_id
       ORDER BY j.created_at DESC LIMIT 100`,
    );
    res.json({ data: rows });
  }

  static async getJournal(req: Request, res: Response): Promise<void> {
    const entry = await entryOr404(req.params.id);
    const [header, lines] = await Promise.all([
      selectOne(
        `SELECT j.id, j.reference, j.memo, j.currency, to_char(j.entry_date, 'YYYY-MM-DD') AS "entryDate",
                j.total_debit::float AS "totalDebit", j.total_credit::float AS "totalCredit", j.status, j.attempts,
                j.last_error AS "lastError", j.sap_trans_id AS "sapTransId", j.source_id AS "sourceId"
         FROM journal_entries j WHERE j.id = :id`,
        { id: entry.id },
      ),
      select(
        `SELECT line_no AS "lineNo", account_code AS "accountCode", debit::float AS debit, credit::float AS credit,
                cost_center AS "costCenter", memo
         FROM journal_lines WHERE entry_id = :id ORDER BY line_no`,
        { id: entry.id },
      ),
    ]);
    res.json({ data: { ...(header as object), lines } });
  }

  static async createFromPayroll(req: Request, res: Response): Promise<void> {
    const runId = req.params.runId;
    if (!isUuid(runId)) throw notFound('مسير الرواتب غير موجود.');
    const id = await transaction(async (tx) => {
      const created = await createPayrollJournal(runId, req.user!.id, tx);
      await recordAudit(req, tx, 'finance.journal_created', 'journal_entry', created, { payrollRunId: runId });
      return created;
    });
    res.status(201).json({ data: { id } });
  }

  /** Queues an entry for SAP; the background worker posts it with retries. */
  static async post(req: Request, res: Response): Promise<void> {
    const entry = await entryOr404(req.params.id);
    if (!['draft', 'failed'].includes(entry.status)) throw conflict('القيد في طابور الترحيل أو مرحّل مسبقاً.');
    if (!sapConfigured()) throw conflict('لم يُضبط الاتصال بـ SAP على الخادم. صدّر القيد وأدخله يدوياً أو اضبط الاتصال.');
    await transaction(async (tx) => {
      await execute(
        `UPDATE journal_entries SET status = 'queued', queued_by = :userId, queued_at = now(), next_attempt_at = now(),
           attempts = CASE WHEN status = 'failed' THEN 0 ELSE attempts END, updated_at = now() WHERE id = :id`,
        { id: entry.id, userId: req.user!.id },
        tx,
      );
      await recordAudit(req, tx, 'finance.journal_queued', 'journal_entry', entry.id, { reference: entry.reference });
    });
    // Try right away; the worker keeps retrying if SAP is unreachable.
    await processJournalQueue(1).catch(() => undefined);
    const current = await selectOne('SELECT status, last_error AS "lastError", sap_trans_id AS "sapTransId" FROM journal_entries WHERE id = :id', { id: entry.id });
    res.json({ data: current });
  }

  /** Marks an entry as entered into SAP by hand (when no live connection is used). */
  static async markPostedManually(req: Request, res: Response): Promise<void> {
    const entry = await entryOr404(req.params.id);
    if (!['draft', 'failed'].includes(entry.status)) throw conflict('لا يمكن تعليم هذا القيد كمرحّل.');
    const input = body(req);
    assertOnlyKeys(input, ['sapTransId', 'note']);
    const transId = Number(input.sapTransId);
    if (!Number.isInteger(transId) || transId <= 0) throw badRequest('أدخل رقم القيد في SAP.');
    const note = requiredText(input, 'note', 500, 'ملاحظة');
    await transaction(async (tx) => {
      await execute(
        `UPDATE journal_entries SET status = 'posted', sap_trans_id = :transId, posted_at = now(), queued_by = :userId,
           last_error = NULL, updated_at = now() WHERE id = :id`,
        { id: entry.id, transId, userId: req.user!.id },
        tx,
      );
      await execute(
        `UPDATE payroll_runs SET status = 'posted', posted_at = now(), posted_by = :userId, updated_at = now()
         WHERE id = :runId AND status = 'approved'`,
        { runId: entry.sourceId, userId: req.user!.id },
        tx,
      );
      await recordAudit(req, tx, 'finance.journal_marked_posted', 'journal_entry', entry.id, { sapTransId: transId, note });
    });
    res.json({ data: { id: entry.id } });
  }

  static async cancel(req: Request, res: Response): Promise<void> {
    const entry = await entryOr404(req.params.id);
    if (!['draft', 'failed'].includes(entry.status)) throw conflict('يُلغى القيد قبل ترحيله فقط.');
    const reason = requiredText(body(req), 'reason', 500, 'سبب الإلغاء');
    await transaction(async (tx) => {
      await execute(`UPDATE journal_entries SET status = 'cancelled', updated_at = now() WHERE id = :id`, { id: entry.id }, tx);
      await recordAudit(req, tx, 'finance.journal_cancelled', 'journal_entry', entry.id, { reason });
    });
    res.json({ data: { id: entry.id } });
  }

  static async exportJournal(req: Request, res: Response): Promise<void> {
    const entry = await entryOr404(req.params.id);
    const header = await selectOne<{ reference: string; memo: string; entryDate: string; currency: string }>(
      `SELECT reference, memo, to_char(entry_date, 'YYYY-MM-DD') AS "entryDate", currency FROM journal_entries WHERE id = :id`,
      { id: entry.id },
    );
    const lines = await select<{ accountCode: string; debit: number; credit: number; costCenter: string | null; memo: string | null }>(
      `SELECT account_code AS "accountCode", debit::float AS debit, credit::float AS credit, cost_center AS "costCenter", memo
       FROM journal_lines WHERE entry_id = :id ORDER BY line_no`,
      { id: entry.id },
    );
    const rows = ['reference,date,memo,currency,account,debit,credit,cost_center,line_memo'];
    for (const line of lines) {
      rows.push([header!.reference, header!.entryDate, header!.memo, header!.currency, line.accountCode,
        line.debit.toFixed(2), line.credit.toFixed(2), line.costCenter, line.memo].map(csvCell).join(','));
    }
    await recordAudit(req, null, 'finance.journal_exported', 'journal_entry', entry.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${header!.reference}.csv"`);
    res.send(`﻿${rows.join('\r\n')}\r\n`);
  }
}

export default FinanceController;
