import { randomUUID } from 'node:crypto';
import { Request } from 'express';
import { Transaction } from 'sequelize';
import { execute, selectOne } from '../db/query';
import { conflict } from '../utils/http';

export interface BinEntry {
  entityType: string;
  entityId: string;
  title: string;
  module: string;
  payload: Record<string, unknown>;
  reason?: string | null;
}

/** Puts a deleted record in the recycle bin with a full copy, in the caller's transaction. */
export async function moveToBin(req: Request, tx: Transaction, entry: BinEntry): Promise<string> {
  const id = randomUUID();
  await execute(
    `INSERT INTO recycle_bin (id, entity_type, entity_id, title, module, payload, reason, deleted_by)
     VALUES (:id, :type, :entityId, :title, :module, :payload, :reason, :userId)`,
    {
      id, type: entry.entityType, entityId: entry.entityId, title: entry.title.slice(0, 300), module: entry.module,
      payload: JSON.stringify(entry.payload), reason: entry.reason?.slice(0, 300) ?? null, userId: req.user!.id,
    },
    tx,
  );
  return id;
}

type Restorer = (tx: Transaction, entityId: string, payload: Record<string, unknown>) => Promise<void>;

async function clear(tx: Transaction, sql: string, entityId: string): Promise<void> {
  const rows = await execute<{ id: string }>(sql, { id: entityId }, tx);
  if (!rows.length) throw conflict('لا يمكن استرجاع السجل: لم يعد محذوفاً أو تغيّر.');
}

/** How each kind of record comes back. Soft-deleted rows are un-flagged; removed rows are re-inserted. */
export const RESTORERS: Record<string, Restorer> = {
  archive_document: (tx, id) => clear(tx,
    'UPDATE archive_documents SET withdrawn_at = NULL, withdrawn_by = NULL, withdraw_reason = NULL WHERE id = :id AND withdrawn_at IS NOT NULL RETURNING id', id),
  employee_document: (tx, id) => clear(tx,
    'UPDATE employee_documents SET deleted_at = NULL, deleted_by = NULL WHERE id = :id AND deleted_at IS NOT NULL RETURNING id', id),
  calendar_event: (tx, id) => clear(tx,
    'UPDATE calendar_events SET cancelled_at = NULL, updated_at = now() WHERE id = :id AND cancelled_at IS NOT NULL RETURNING id', id),
  announcement: (tx, id) => clear(tx,
    'UPDATE announcements SET withdrawn_at = NULL WHERE id = :id AND withdrawn_at IS NOT NULL RETURNING id', id),
  payroll_archive_month: (tx, id) => clear(tx,
    'UPDATE payroll_archive_months SET withdrawn_at = NULL, withdrawn_by = NULL WHERE id = :id AND withdrawn_at IS NOT NULL RETURNING id', id),
  payroll_input: async (tx, id, payload) => {
    const open = await selectOne(
      `SELECT 1 FROM payroll_runs r JOIN payroll_lines l ON l.run_id = r.id
       WHERE r.period = :period AND l.employee_id = :employeeId AND r.status IN ('approved','posted') LIMIT 1`,
      { period: payload.period, employeeId: payload.employee_id }, tx,
    );
    if (open) throw conflict('مسير هذا الشهر معتمد؛ لا يمكن إرجاع المبلغ إليه.');
    await execute(
      `INSERT INTO payroll_inputs SELECT * FROM jsonb_populate_record(NULL::payroll_inputs, :row::jsonb)`,
      { row: JSON.stringify(payload) }, tx,
    );
  },
};

/** Full copy of a row for the bin. */
export async function snapshot(table: string, id: string, tx?: Transaction | null): Promise<Record<string, unknown> | null> {
  if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid table');
  return selectOne<Record<string, unknown>>(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE t.id = :id`, { id }, tx)
    .then((result) => (result ? (result.row as Record<string, unknown>) : null));
}
