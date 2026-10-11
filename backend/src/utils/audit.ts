import { Transaction } from 'sequelize';
import { sequelize, AuditLog } from '../models';

export async function audited<T extends { id: string }>(
  userId: string,
  action: string,
  entityType: string,
  operation: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  return sequelize.transaction(async (transaction) => {
    const entity = await operation(transaction);
    await AuditLog.create({
      userId,
      action,
      entityType,
      entityId: entity.id,
    }, { transaction });
    return entity;
  });
}
