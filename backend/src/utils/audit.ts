import { Request } from 'express';
import { Transaction } from 'sequelize';
import { sequelize, AuditLog } from '../models';

export async function audited<T extends { id: string }>(
  userId: string,
  action: string,
  entityType: string,
  operation: (transaction: Transaction) => Promise<T>,
  details?: Record<string, unknown>,
): Promise<T> {
  return sequelize.transaction(async (transaction) => {
    const entity = await operation(transaction);
    await AuditLog.create({
      userId,
      action,
      entityType,
      entityId: entity.id,
      details: details ?? null,
    }, { transaction });
    return entity;
  });
}

/** Records one audit entry inside the caller's transaction. */
export async function recordAudit(
  req: Request,
  transaction: Transaction | null,
  action: string,
  entityType: string,
  entityId: string | null,
  details?: Record<string, unknown>,
): Promise<void> {
  await AuditLog.create({
    userId: req.user!.id,
    action,
    entityType,
    entityId,
    details: details ?? null,
    ip: (req.ip || '').slice(0, 64) || null,
  }, transaction ? { transaction } : {});
}

/**
 * Returns only the fields whose values changed, as { field: [before, after] },
 * so the audit trail shows what was edited without copying whole records.
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  redacted: string[] = [],
): Record<string, [unknown, unknown]> {
  const changes: Record<string, [unknown, unknown]> = {};
  for (const key of Object.keys(after)) {
    const left = before[key];
    const right = after[key];
    if (JSON.stringify(left ?? null) !== JSON.stringify(right ?? null)) {
      changes[key] = redacted.includes(key) ? ['•••', '•••'] : [left ?? null, right ?? null];
    }
  }
  return changes;
}
