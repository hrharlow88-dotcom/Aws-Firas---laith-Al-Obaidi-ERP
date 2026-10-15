import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Request, Response } from 'express';
import { execute, select, selectOne, transaction } from '../db/query';
import { recordAudit } from '../utils/audit';
import { badRequest, body, conflict, notFound, optionalText } from '../utils/http';
import { isUuid } from '../utils/validation';

const DEMO_ROLES = ['employee', 'hr_manager', 'executive', 'finance', 'line_manager', 'payroll_officer'];
export const demoInstance = () => process.env.DEMO_MODE === 'true';

/**
 * Demo accounts for showing the system to others. They exist only on the
 * demo copy (fictional data); the owner switches each one on or off, can
 * give it an end date, and sets its password. Demo users cannot change it.
 */
export class DemoController {
  static async list(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT u.id, u.name, u.email, u.username, u.role::text AS role, u.is_active AS "isActive", u.demo_expires_at AS "expiresAt",
              u.last_login_at AS "lastLoginAt", e.full_name AS "employeeName",
              (SELECT count(*) FROM login_events l WHERE l.user_id = u.id)::int AS logins
       FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.is_demo ORDER BY u.created_at`,
    );
    res.json({ data: { accounts: rows, demoInstance: demoInstance() } });
  }

  static async create(req: Request, res: Response): Promise<void> {
    if (!demoInstance()) throw conflict('الحسابات التجريبية تُنشأ في نسخة العرض التجريبية فقط، حتى لا ترى بيانات حقيقية.');
    const input = body(req);
    const name = optionalText(input, 'name', 120);
    const email = String(input.email || '').trim().toLowerCase();
    const password = typeof input.password === 'string' ? input.password : '';
    const role = String(input.role || 'employee');
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('اكتب الاسم والبريد.');
    if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) throw badRequest('كلمة المرور 12 محرفاً على الأقل.');
    if (!DEMO_ROLES.includes(role)) throw badRequest('دور غير متاح للحساب التجريبي.');
    const employeeId = isUuid(input.employeeId) ? String(input.employeeId) : null;
    if (role === 'employee' && !employeeId) throw badRequest('اختر الموظف الوهمي الذي يمثله حساب الموظف التجريبي.');
    const expiresAt = typeof input.expiresAt === 'string' && input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw badRequest('تاريخ الانتهاء غير صالح.');
    if (await selectOne('SELECT 1 FROM users WHERE lower(email) = :email', { email })) throw conflict('البريد مستخدم.');
    const id = randomUUID();
    const hash = await bcrypt.hash(password, 12);
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO users (id, name, email, password_hash, role, is_active, token_version, employee_id, failed_logins, is_demo, demo_expires_at, created_at, updated_at)
         VALUES (:id, :name, :email, :hash, :role, true, 0, :employeeId, 0, true, :expiresAt, now(), now())`,
        { id, name, email, hash, role, employeeId, expiresAt: expiresAt?.toISOString() ?? null }, tx,
      );
      await recordAudit(req, tx, 'demo.account_created', 'user', id, { email, role, expiresAt });
    });
    res.status(201).json({ data: { id } });
  }

  /** Switch on or off, change the end date or the password. */
  static async update(req: Request, res: Response): Promise<void> {
    const input = body(req);
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: req.params.id };
    if (typeof input.isActive === 'boolean') {
      if (input.isActive && !demoInstance()) throw conflict('لا تُفعّل الحسابات التجريبية في النظام الحقيقي.');
      sets.push('is_active = :active', 'token_version = token_version + 1'); params.active = input.isActive;
    }
    if (input.expiresAt !== undefined) {
      const date = input.expiresAt ? new Date(String(input.expiresAt)) : null;
      if (date && Number.isNaN(date.getTime())) throw badRequest('تاريخ غير صالح.');
      sets.push('demo_expires_at = :expires'); params.expires = date?.toISOString() ?? null;
    }
    if (typeof input.password === 'string' && input.password) {
      if (input.password.length < 12 || Buffer.byteLength(input.password, 'utf8') > 72) throw badRequest('كلمة المرور 12 محرفاً على الأقل.');
      sets.push('password_hash = :hash', 'token_version = token_version + 1'); params.hash = await bcrypt.hash(input.password, 12);
    }
    if (!sets.length) throw badRequest('لا يوجد تغيير.');
    const rows = await execute(`UPDATE users SET ${[...new Set(sets)].join(', ')}, updated_at = now() WHERE id = :id AND is_demo RETURNING id`, params);
    if (!rows.length) throw notFound('الحساب التجريبي غير موجود.');
    await recordAudit(req, null, 'demo.account_updated', 'user', req.params.id, { isActive: input.isActive, expiresAt: input.expiresAt, password: Boolean(input.password) });
    res.json({ data: { ok: true } });
  }

  /** One switch for all demo accounts. */
  static async toggleAll(req: Request, res: Response): Promise<void> {
    const on = body(req).enabled === true;
    if (on && !demoInstance()) throw conflict('لا تُفعّل الحسابات التجريبية في النظام الحقيقي.');
    const rows = await execute(`UPDATE users SET is_active = :on, token_version = token_version + 1, updated_at = now() WHERE is_demo RETURNING id`, { on });
    await recordAudit(req, null, on ? 'demo.all_enabled' : 'demo.all_disabled', 'user', null, { count: rows.length });
    res.json({ data: { count: rows.length } });
  }
}

export default DemoController;
