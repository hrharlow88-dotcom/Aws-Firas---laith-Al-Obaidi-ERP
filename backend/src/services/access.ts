import { Request } from 'express';
import { Op, Transaction, WhereOptions } from 'sequelize';
import { selectOne } from '../db/query';
import { Employee, sequelize } from '../models';
import { forbidden, notFound } from '../utils/http';
import { isUuid } from '../utils/validation';

/**
 * Which employees a user may see. Permissions say what a user may do; the
 * scope says to whom:
 *  - all     HR, payroll, finance, audit, executives, administrators
 *  - branch  a branch manager: everyone in their branch
 *  - team    a line manager: themselves and everyone reporting to them, directly or not
 *  - self    an employee: only their own record
 *  - none    an account that should be scoped but is not linked to a branch or employee
 */
export type AccessScope =
  | { kind: 'all' }
  | { kind: 'branch'; branchId: string }
  | { kind: 'team'; employeeId: string }
  | { kind: 'self'; employeeId: string }
  | { kind: 'none' };

export function accessScope(req: Request): AccessScope {
  const user = req.user;
  if (!user) return { kind: 'none' };
  switch (user.role) {
    case 'branch_manager':
      return user.branchId ? { kind: 'branch', branchId: user.branchId } : { kind: 'none' };
    case 'line_manager':
      return user.employeeId ? { kind: 'team', employeeId: user.employeeId } : { kind: 'none' };
    case 'employee':
      return user.employeeId ? { kind: 'self', employeeId: user.employeeId } : { kind: 'none' };
    default:
      return { kind: 'all' };
  }
}

/** Branch the user is confined to, or null when they are not confined to one branch. */
export function branchScope(req: Request): string | null {
  const scope = accessScope(req);
  return scope.kind === 'branch' ? scope.branchId : null;
}

const TEAM_SQL = (param: string) => `(
  WITH RECURSIVE team AS (
    SELECT id FROM employees WHERE id = ${param}
    UNION
    SELECT child.id FROM employees child JOIN team parent ON child.manager_id = parent.id
  ) SELECT id FROM team)`;

/** SQL fragment restricting an employees alias to the user's scope. */
export function employeeScopeSql(req: Request, alias = 'e'): { sql: string; params: Record<string, unknown> } {
  const scope = accessScope(req);
  switch (scope.kind) {
    case 'all':
      return { sql: '', params: {} };
    case 'branch':
      return { sql: ` AND ${alias}.branch_id = :scopeBranchId`, params: { scopeBranchId: scope.branchId } };
    case 'team':
      return { sql: ` AND ${alias}.id IN ${TEAM_SQL(':scopeEmployeeId')}`, params: { scopeEmployeeId: scope.employeeId } };
    case 'self':
      return { sql: ` AND ${alias}.id = :scopeEmployeeId`, params: { scopeEmployeeId: scope.employeeId } };
    default:
      return { sql: ' AND false', params: {} };
  }
}

/** The same restriction as a Sequelize condition on the Employee model. */
export function employeeScopeWhere(req: Request): WhereOptions {
  const scope = accessScope(req);
  switch (scope.kind) {
    case 'all':
      return {};
    case 'branch':
      return { branchId: scope.branchId };
    case 'team':
      return { id: { [Op.in]: sequelize.literal(TEAM_SQL(sequelize.escape(scope.employeeId))) } };
    case 'self':
      return { id: scope.employeeId };
    default:
      return { id: null };
  }
}

/** True when the employee is inside the user's scope. */
export async function inScope(req: Request, employeeId: string, transaction?: Transaction): Promise<boolean> {
  const scope = accessScope(req);
  if (scope.kind === 'all') return true;
  const { sql, params } = employeeScopeSql(req, 'e');
  return Boolean(await selectOne(`SELECT 1 FROM employees e WHERE e.id = :employeeId${sql}`, { employeeId, ...params }, transaction));
}

/**
 * Loads an employee the user may act on. Out-of-scope employees are reported
 * as not found so their existence is not disclosed.
 */
export async function employeeInScope(req: Request, id: unknown, transaction?: Transaction): Promise<Employee> {
  if (!isUuid(id)) throw notFound('الموظف غير موجود.');
  const employee = await Employee.findByPk(id, transaction ? { transaction } : {});
  if (!employee || !(await inScope(req, employee.id, transaction))) throw notFound('الموظف غير موجود.');
  return employee;
}

export function assertBranchInScope(req: Request, branchId: string): void {
  const scope = accessScope(req);
  if (scope.kind === 'all') return;
  if (scope.kind !== 'branch' || branchId !== scope.branchId) throw forbidden('لا يمكنك العمل على هذا الفرع.');
}

/** True for users who only see part of the company (branch, team or themselves). */
export function isScoped(req: Request): boolean {
  return accessScope(req).kind !== 'all';
}
