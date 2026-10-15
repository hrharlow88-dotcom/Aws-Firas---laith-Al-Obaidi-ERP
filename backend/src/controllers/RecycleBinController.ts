import { Request, Response } from 'express';
import { execute, select, selectOne, transaction } from '../db/query';
import { RESTORERS } from '../services/recycleBin';
import { recordAudit } from '../utils/audit';
import { conflict, notFound } from '../utils/http';

/** The recycle bin (owner): see what was deleted, by whom and when, and bring it back. */
export class RecycleBinController {
  static async list(req: Request, res: Response): Promise<void> {
    const state = ['open', 'restored', 'purged', 'all'].includes(String(req.query.state)) ? String(req.query.state) : 'open';
    const rows = await select(
      `SELECT b.id, b.entity_type AS "entityType", b.entity_id AS "entityId", b.title, b.module, b.reason,
              b.deleted_at AS "deletedAt", d.name AS "deletedByName", b.restored_at AS "restoredAt", r.name AS "restoredByName",
              b.purged_at AS "purgedAt"
       FROM recycle_bin b JOIN users d ON d.id = b.deleted_by LEFT JOIN users r ON r.id = b.restored_by
       WHERE CASE :state WHEN 'open' THEN b.restored_at IS NULL AND b.purged_at IS NULL
                         WHEN 'restored' THEN b.restored_at IS NOT NULL
                         WHEN 'purged' THEN b.purged_at IS NOT NULL ELSE true END
       ORDER BY b.deleted_at DESC LIMIT 500`,
      { state },
    );
    res.json({ data: rows });
  }

  static async restore(req: Request, res: Response): Promise<void> {
    await transaction(async (tx) => {
      const entry = await selectOne<{ id: string; entityType: string; entityId: string; payload: Record<string, unknown> }>(
        `SELECT id, entity_type AS "entityType", entity_id AS "entityId", payload FROM recycle_bin
         WHERE id = :id AND restored_at IS NULL AND purged_at IS NULL FOR UPDATE`,
        { id: req.params.id }, tx,
      );
      if (!entry) throw notFound('العنصر غير موجود في السلة.');
      const restorer = RESTORERS[entry.entityType];
      if (!restorer) throw conflict('لا يمكن استرجاع هذا النوع تلقائياً.');
      await restorer(tx, entry.entityId, entry.payload);
      await execute('UPDATE recycle_bin SET restored_at = now(), restored_by = :userId WHERE id = :id', { id: entry.id, userId: req.user!.id }, tx);
      await recordAudit(req, tx, 'recycle_bin.restored', entry.entityType, entry.entityId, { binId: entry.id });
    });
    res.json({ data: { ok: true } });
  }

  /** Removes the entry from the bin for good. The audit trail keeps the record of the deletion. */
  static async purge(req: Request, res: Response): Promise<void> {
    await transaction(async (tx) => {
      const rows = await execute<{ entityType: string; entityId: string }>(
        `UPDATE recycle_bin SET purged_at = now(), purged_by = :userId, payload = '{}'::jsonb
         WHERE id = :id AND restored_at IS NULL AND purged_at IS NULL RETURNING entity_type AS "entityType", entity_id AS "entityId"`,
        { id: req.params.id, userId: req.user!.id }, tx,
      );
      if (!rows.length) throw notFound('العنصر غير موجود في السلة.');
      await recordAudit(req, tx, 'recycle_bin.purged', rows[0].entityType, rows[0].entityId, { binId: req.params.id });
    });
    res.json({ data: { ok: true } });
  }
}

export default RecycleBinController;
