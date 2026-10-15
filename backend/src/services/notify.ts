import { randomUUID } from 'node:crypto';
import { Transaction } from 'sequelize';
import { execute, select } from '../db/query';
import { Permission, PERMISSIONS } from '../config/systemSettings';
import { getSettings } from './settings';
import { ROLES } from '../types';

export interface NoticeInput {
  kind: string;
  title: string;
  body?: string | null;
  /** In-app hash route, e.g. '/me' or '/payroll/runs/<id>'. */
  link?: string | null;
}

/**
 * In-app notifications. They are written in the same transaction as the
 * change they describe, so a rolled-back action never leaves a notice behind.
 * Nothing is sent outside the system (no e-mail, SMS or WhatsApp).
 */
export async function notifyUsers(userIds: Array<string | null | undefined>, notice: NoticeInput, tx?: Transaction | null): Promise<number> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return 0;
  const rows = ids.map((userId) => ({
    id: randomUUID(), userId, kind: notice.kind.slice(0, 30), title: notice.title.slice(0, 200),
    body: notice.body ? notice.body.slice(0, 1000) : null, link: notice.link ? notice.link.slice(0, 300) : null,
  }));
  await execute(
    `INSERT INTO notifications (id, user_id, kind, title, body, link)
     SELECT x.id, x."userId", x.kind, x.title, x.body, x.link
     FROM jsonb_to_recordset(:rows::jsonb) AS x(id uuid, "userId" uuid, kind varchar, title varchar, body varchar, link varchar)
     JOIN users u ON u.id = x."userId" AND u.is_active`,
    { rows: JSON.stringify(rows) },
    tx,
  );
  return rows.length;
}

/** Notifies the accounts linked to these employee files (employees without an account are skipped). */
export async function notifyEmployees(employeeIds: Array<string | null | undefined>, notice: NoticeInput, tx?: Transaction | null): Promise<number> {
  const ids = [...new Set(employeeIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return 0;
  const users = await select<{ id: string }>('SELECT id FROM users WHERE employee_id IN (:ids) AND is_active', { ids }, tx);
  return notifyUsers(users.map((user) => user.id), notice, tx);
}

/** Notifies every active account whose role holds the permission, optionally leaving one person out. */
export async function notifyPermission(permission: Permission, notice: NoticeInput, tx?: Transaction | null, exceptUserId?: string): Promise<number> {
  const settings = await getSettings();
  const roles = ROLES.filter((role) => role === 'super_admin'
    ? (PERMISSIONS as readonly string[]).includes(permission)
    : settings.roles[role]?.permissions.includes(permission));
  if (!roles.length) return 0;
  const users = await select<{ id: string }>(
    'SELECT id FROM users WHERE role::text IN (:roles) AND is_active AND id <> COALESCE(:except::uuid, \'00000000-0000-0000-0000-000000000000\'::uuid)',
    { roles, except: exceptUserId ?? null },
    tx,
  );
  return notifyUsers(users.map((user) => user.id), notice, tx);
}

/** The direct manager's account of an employee, if the manager has one. */
export async function managerUserOf(employeeId: string, tx?: Transaction | null): Promise<string | null> {
  const rows = await select<{ id: string }>(
    `SELECT u.id FROM employees e JOIN users u ON u.employee_id = e.manager_id AND u.is_active WHERE e.id = :employeeId LIMIT 1`,
    { employeeId },
    tx,
  );
  return rows[0]?.id ?? null;
}
