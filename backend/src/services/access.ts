import { Request } from 'express';
import { Transaction } from 'sequelize';
import { Employee } from '../models';
import { forbidden, notFound } from '../utils/http';
import { isUuid } from '../utils/validation';

/** Branch the user is confined to, or null when they see every branch. */
export function branchScope(req: Request): string | null {
  if (req.user?.role === 'branch_manager') {
    // A branch manager without a branch sees nothing rather than everything.
    return req.user.branchId ?? '00000000-0000-0000-0000-000000000000';
  }
  return null;
}

/** SQL fragment restricting an employees alias to the user's branch scope. */
export function employeeScopeSql(req: Request, alias = 'e'): { sql: string; params: Record<string, unknown> } {
  const branch = branchScope(req);
  return branch
    ? { sql: ` AND ${alias}.branch_id = :scopeBranchId`, params: { scopeBranchId: branch } }
    : { sql: '', params: {} };
}

/**
 * Loads an employee the user may act on. Out-of-scope employees are reported
 * as not found so their existence is not disclosed.
 */
export async function employeeInScope(req: Request, id: unknown, transaction?: Transaction): Promise<Employee> {
  if (!isUuid(id)) throw notFound('الموظف غير موجود.');
  const employee = await Employee.findByPk(id, transaction ? { transaction } : {});
  if (!employee) throw notFound('الموظف غير موجود.');
  const branch = branchScope(req);
  if (branch && employee.branchId !== branch) throw notFound('الموظف غير موجود.');
  return employee;
}

export function assertBranchInScope(req: Request, branchId: string): void {
  const branch = branchScope(req);
  if (branch && branchId !== branch) throw forbidden('لا يمكنك العمل على فرع آخر.');
}
