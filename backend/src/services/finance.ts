import { randomUUID } from 'node:crypto';
import { Transaction } from 'sequelize';
import { execute, select, selectOne, transaction } from '../db/query';
import { badRequest, conflict } from '../utils/http';
import { getSettings } from './settings';
import {
  createJournalEntry, findJournalByReference, SapError, sapLocalCurrency, SapJournalLine,
} from './sapB1';

export const NET_PAY_KEY = 'net_pay';
const MAX_ATTEMPTS = 6;
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];

export interface MappingRow {
  mappingKey: string;
  label: string;
  debitAccount: string | null;
  creditAccount: string | null;
  useCostCenter: boolean;
}

export async function loadMappings(transaction?: Transaction): Promise<Map<string, MappingRow>> {
  const rows = await select<MappingRow>(
    `SELECT mapping_key AS "mappingKey", label, debit_account AS "debitAccount", credit_account AS "creditAccount",
            use_cost_center AS "useCostCenter"
     FROM finance_account_mappings`,
    {},
    transaction,
  );
  return new Map(rows.map((row) => [row.mappingKey, row]));
}

interface JournalLineDraft {
  accountCode: string;
  debit: number;
  credit: number;
  costCenter: string | null;
  memo: string;
}

/** Amounts are summed in integer minor units so the entry balances exactly. */
const toMinor = (value: number) => Math.round(Number(value) * 100);
const fromMinor = (value: number) => value / 100;

/**
 * Turns an approved payroll run into one balanced journal entry:
 *   Dr  each earning component's expense account (per cost center)
 *   Cr  each deduction component's account (advances, fines, social security…)
 *   Cr  salaries payable for the total net pay
 * Earnings = deductions + net for every payslip, so the entry always balances.
 */
export async function buildPayrollJournal(runId: string, transaction: Transaction) {
  const run = await selectOne<{ id: string; period: string; status: string; currency: string; endsOn: string; branchName: string | null }>(
    `SELECT r.id, r.period, r.status, r.currency, to_char(r.ends_on, 'YYYY-MM-DD') AS "endsOn", b.name AS "branchName"
     FROM payroll_runs r LEFT JOIN branches b ON b.id = r.branch_id WHERE r.id = :id FOR UPDATE OF r`,
    { id: runId },
    transaction,
  );
  if (!run) throw badRequest('مسير الرواتب غير موجود.');
  if (run.status !== 'approved') throw conflict('يُنشأ القيد من مسير معتمد فقط.');

  const lines = await select<{ costCenter: string | null; earnings: Array<{ componentId: string; amount: number }>; deductions: Array<{ componentId: string; amount: number }>; netPay: number }>(
    `SELECT cost_center_code AS "costCenter", earnings, deductions, net_pay::float AS "netPay"
     FROM payroll_lines WHERE run_id = :id`,
    { id: runId },
    transaction,
  );
  if (!lines.length) throw conflict('المسير لا يحتوي على رواتب.');

  const settings = await getSettings();
  const components = new Map(settings.payrollRules.components.map((component) => [component.id, component]));
  const mappings = await loadMappings(transaction);
  const missing = new Set<string>();

  const debits = new Map<string, { account: string; costCenter: string | null; minor: number; memo: string }>();
  const credits = new Map<string, { account: string; costCenter: string | null; minor: number; memo: string }>();
  const add = (
    target: typeof debits,
    account: string,
    costCenter: string | null,
    minor: number,
    memo: string,
  ) => {
    const key = `${account}|${costCenter ?? ''}|${memo}`;
    const existing = target.get(key);
    if (existing) existing.minor += minor;
    else target.set(key, { account, costCenter, minor, memo });
  };

  for (const line of lines) {
    for (const item of line.earnings) {
      const mapping = mappings.get(item.componentId);
      const name = components.get(item.componentId)?.name ?? item.componentId;
      if (!mapping?.debitAccount) {
        missing.add(name);
        continue;
      }
      add(debits, mapping.debitAccount, mapping.useCostCenter ? line.costCenter : null, toMinor(item.amount), name);
    }
    for (const item of line.deductions) {
      const mapping = mappings.get(item.componentId);
      const name = components.get(item.componentId)?.name ?? item.componentId;
      if (!mapping?.creditAccount) {
        missing.add(name);
        continue;
      }
      add(credits, mapping.creditAccount, mapping.useCostCenter ? line.costCenter : null, toMinor(item.amount), name);
    }
    const net = mappings.get(NET_PAY_KEY);
    if (!net?.creditAccount) missing.add('صافي الرواتب المستحقة');
    else add(credits, net.creditAccount, net.useCostCenter ? line.costCenter : null, toMinor(line.netPay), 'صافي الرواتب المستحقة');
  }
  if (missing.size) {
    throw conflict(`اربط الحسابات التالية في إعدادات المالية أولاً: ${[...missing].join('، ')}`, { missing: [...missing] });
  }

  const drafts: JournalLineDraft[] = [
    ...[...debits.values()].filter((item) => item.minor !== 0)
      .map((item) => ({ accountCode: item.account, debit: fromMinor(item.minor), credit: 0, costCenter: item.costCenter, memo: item.memo })),
    ...[...credits.values()].filter((item) => item.minor !== 0)
      .map((item) => ({ accountCode: item.account, debit: 0, credit: fromMinor(item.minor), costCenter: item.costCenter, memo: item.memo })),
  ];
  const totalDebit = [...debits.values()].reduce((sum, item) => sum + item.minor, 0);
  const totalCredit = [...credits.values()].reduce((sum, item) => sum + item.minor, 0);
  if (totalDebit !== totalCredit) {
    throw conflict(`القيد غير متوازن (مدين ${fromMinor(totalDebit)} / دائن ${fromMinor(totalCredit)}). راجع المسير.`);
  }
  return {
    run,
    lines: drafts,
    total: fromMinor(totalDebit),
    memo: `رواتب ${run.period}${run.branchName ? ` - ${run.branchName}` : ''}`,
    reference: `PAY-${run.period}-${run.currency}-${run.id.slice(0, 8)}`.toUpperCase(),
  };
}

export async function createPayrollJournal(runId: string, userId: string, transaction: Transaction): Promise<string> {
  const existing = await selectOne<{ id: string; status: string }>(
    `SELECT id, status FROM journal_entries WHERE source_type = 'payroll' AND source_id = :runId AND status <> 'cancelled'`,
    { runId },
    transaction,
  );
  if (existing && !['draft', 'failed'].includes(existing.status)) {
    throw conflict('قيد هذا المسير في طابور الترحيل أو مرحّل مسبقاً.');
  }
  if (existing) {
    await execute(`UPDATE journal_entries SET status = 'cancelled', updated_at = now() WHERE id = :id`, { id: existing.id }, transaction);
  }
  const built = await buildPayrollJournal(runId, transaction);
  const id = randomUUID();
  // A regenerated entry gets a new reference so SAP never sees two documents with one reference.
  const reference = existing ? `${built.reference}-${id.slice(0, 4).toUpperCase()}` : built.reference;
  await execute(
    `INSERT INTO journal_entries (id, reference, source_type, source_id, entry_date, memo, currency, total_debit, total_credit, created_by)
     VALUES (:id, :reference, 'payroll', :runId, :date, :memo, :currency, :total, :total, :userId)`,
    { id, reference, runId, date: built.run.endsOn, memo: built.memo, currency: built.run.currency, total: built.total, userId },
    transaction,
  );
  await execute(
    `INSERT INTO journal_lines (id, entry_id, line_no, account_code, debit, credit, cost_center, memo)
     SELECT gen_random_uuid(), :id, x.line_no, x."accountCode", x.debit, x.credit, x."costCenter", left(x.memo, 100)
     FROM jsonb_to_recordset(:lines::jsonb) AS x(line_no int, "accountCode" varchar, debit numeric, credit numeric, "costCenter" varchar, memo varchar)`,
    { id, lines: JSON.stringify(built.lines.map((line, index) => ({ ...line, line_no: index + 1 }))) },
    transaction,
  );
  return id;
}

export function toSapDocument(
  entry: { reference: string; memo: string; entryDate: string; currency: string },
  lines: Array<{ accountCode: string; debit: number; credit: number; costCenter: string | null; memo: string | null }>,
) {
  const foreign = entry.currency !== sapLocalCurrency();
  return {
    ReferenceDate: entry.entryDate,
    TaxDate: entry.entryDate,
    DueDate: entry.entryDate,
    // OJDT.Memo and JDT1.LineMemo hold 50 characters in SAP Business One.
    Memo: entry.memo.slice(0, 50),
    Reference: entry.reference,
    Reference2: 'ERP',
    JournalEntryLines: lines.map((line): SapJournalLine => ({
      AccountCode: line.accountCode,
      ...(foreign
        ? { FCCurrency: entry.currency, FCDebit: Number(line.debit), FCCredit: Number(line.credit) }
        : { Debit: Number(line.debit), Credit: Number(line.credit) }),
      ...(line.costCenter ? { CostingCode: line.costCenter } : {}),
      ...(line.memo ? { LineMemo: line.memo.slice(0, 50) } : {}),
    })),
  };
}

/**
 * Posts queued entries to SAP. Each entry is claimed with SKIP LOCKED so two
 * API processes never post the same entry, and SAP is first searched for the
 * entry's reference so an entry posted just before a crash is not duplicated.
 */
export async function processJournalQueue(limit = 5): Promise<number> {
  // Entries left in "posting" by a crashed process go back to the queue.
  await execute(
    `UPDATE journal_entries SET status = 'queued', next_attempt_at = now()
     WHERE status = 'posting' AND updated_at < now() - INTERVAL '10 minutes'`,
  );
  let processed = 0;
  for (let index = 0; index < limit; index += 1) {
    const claimed = await transaction(async (tx) => {
      const entry = await selectOne<{ id: string; reference: string; memo: string; entryDate: string; currency: string; attempts: number; sourceId: string; queuedBy: string }>(
        `SELECT id, reference, memo, to_char(entry_date, 'YYYY-MM-DD') AS "entryDate", currency, attempts,
                source_id AS "sourceId", queued_by AS "queuedBy"
         FROM journal_entries
         WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ORDER BY queued_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        {},
        tx,
      );
      if (!entry) return null;
      await execute(`UPDATE journal_entries SET status = 'posting', updated_at = now() WHERE id = :id`, { id: entry.id }, tx);
      return entry;
    });
    if (!claimed) break;
    processed += 1;
    try {
      const lines = await select<{ accountCode: string; debit: number; credit: number; costCenter: string | null; memo: string | null }>(
        `SELECT account_code AS "accountCode", debit::float AS debit, credit::float AS credit, cost_center AS "costCenter", memo
         FROM journal_lines WHERE entry_id = :id ORDER BY line_no`,
        { id: claimed.id },
      );
      const existing = await findJournalByReference(claimed.reference);
      const transId = existing ?? await createJournalEntry(toSapDocument(claimed, lines));
      await transaction(async (tx) => {
        await execute(
          `UPDATE journal_entries SET status = 'posted', sap_trans_id = :transId, posted_at = now(), last_error = NULL,
             attempts = attempts + 1, updated_at = now() WHERE id = :id`,
          { id: claimed.id, transId },
          tx,
        );
        await execute(
          `UPDATE payroll_runs SET status = 'posted', posted_at = now(), posted_by = :userId, updated_at = now()
           WHERE id = :runId AND status = 'approved'`,
          { runId: claimed.sourceId, userId: claimed.queuedBy },
          tx,
        );
        await execute(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details, created_at)
           VALUES (gen_random_uuid(), :userId, 'finance.journal_posted', 'journal_entry', :id, :details::jsonb, now())`,
          { userId: claimed.queuedBy, id: claimed.id, details: JSON.stringify({ sapTransId: transId, reference: claimed.reference }) },
          tx,
        );
      });
    } catch (error) {
      const sapError = error instanceof SapError ? error : null;
      const attempts = claimed.attempts + 1;
      const retry = (sapError ? sapError.retryable : true) && attempts < MAX_ATTEMPTS;
      const delay = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
      await execute(
        `UPDATE journal_entries SET status = :status, attempts = :attempts, last_error = :error,
           next_attempt_at = now() + (:delay * INTERVAL '1 minute'), updated_at = now() WHERE id = :id`,
        {
          id: claimed.id,
          status: retry ? 'queued' : 'failed',
          attempts,
          delay,
          error: (error instanceof Error ? error.message : 'Unknown error').slice(0, 2000),
        },
      );
    }
  }
  return processed;
}
