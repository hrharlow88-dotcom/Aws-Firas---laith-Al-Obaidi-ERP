import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { NextFunction, Request, Response } from 'express';
import { execute, select, selectOne, transaction } from '../db/query';
import { createSetupToken } from '../services/passwordSetup';
import { recordAudit } from '../utils/audit';
import { badRequest, body, conflict, HttpError, notFound, optionalText } from '../utils/http';
import { isUuid } from '../utils/validation';

const DEMO_ROLES = ['employee', 'hr_manager', 'executive', 'finance', 'line_manager', 'payroll_officer'];
const INVITE_MINUTES = 7 * 24 * 60;
export const demoInstance = () => process.env.DEMO_MODE === 'true';
/** The real system reaches the demo copy through this private link (set on both, same key). */
const bridge = () => (process.env.DEMO_BRIDGE_URL && process.env.DEMO_BRIDGE_KEY && !demoInstance()
  ? { url: process.env.DEMO_BRIDGE_URL.replace(/\/$/, ''), key: process.env.DEMO_BRIDGE_KEY } : null);

interface Invite { id: string; name: string; login: string; path: string; origin: string | null; expiresAt: string | null }

/* ---------- the work itself, done on the demo copy ---------- */

async function listAccounts() {
  const accounts = await select(
    `SELECT u.id, u.name, u.email, u.role::text AS role, u.is_active AS "isActive", u.demo_expires_at AS "expiresAt",
            u.last_login_at AS "lastLoginAt", e.full_name AS "employeeName",
            (SELECT count(*) FROM login_events l WHERE l.user_id = u.id)::int AS logins
     FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.is_demo ORDER BY u.created_at DESC`,
  );
  const employees = await select(
    `SELECT e.id, e.employee_no AS "employeeNo", e.full_name AS "fullName" FROM employees e
     WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.employee_id = e.id) ORDER BY e.employee_no LIMIT 200`,
  );
  return { accounts, employees };
}

async function inviteFor(req: Request, userId: string): Promise<Invite> {
  const user = await selectOne<{ id: string; name: string; email: string; demo_expires_at: string | null }>(
    'SELECT id, name, email, demo_expires_at FROM users WHERE id = :id AND is_demo AND is_active', { id: userId });
  if (!user) throw notFound('الحساب التجريبي غير موجود أو موقوف.');
  const token = await createSetupToken(user.id, INVITE_MINUTES);
  await recordAudit(req, null, 'demo.invite_created', 'user', user.id);
  return { id: user.id, name: user.name, login: user.email, path: `/#/set-password/${token}`, origin: process.env.PUBLIC_URL || null,
    expiresAt: user.demo_expires_at };
}

async function createAccount(req: Request, input: Record<string, unknown>): Promise<Invite> {
  const name = optionalText(input, 'name', 120);
  const email = String(input.email || '').trim().toLowerCase();
  const role = String(input.role || 'employee');
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('اكتب اسم الضيف وبريده.');
  if (!DEMO_ROLES.includes(role)) throw badRequest('دور غير متاح للحساب التجريبي.');
  const employeeId = isUuid(input.employeeId) ? String(input.employeeId) : null;
  if (role === 'employee' && !employeeId) throw badRequest('اختر الموظف الوهمي الذي يمثله حساب الموظف التجريبي.');
  const expiresAt = typeof input.expiresAt === 'string' && input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw badRequest('تاريخ الانتهاء غير صالح.');
  if (await selectOne('SELECT 1 FROM users WHERE lower(email) = :email', { email })) throw conflict('البريد مستخدم.');
  const id = randomUUID();
  // No password from anyone: the guest chooses it from the invitation link.
  const hash = await bcrypt.hash(randomBytes(32).toString('base64url'), 12);
  await transaction(async (tx) => {
    await execute(
      `INSERT INTO users (id, name, email, password_hash, role, is_active, token_version, employee_id, failed_logins, is_demo, demo_expires_at, created_at, updated_at)
       VALUES (:id, :name, :email, :hash, :role, true, 0, :employeeId, 0, true, :expiresAt, now(), now())`,
      { id, name, email, hash, role, employeeId, expiresAt: expiresAt?.toISOString() ?? null }, tx,
    );
    await recordAudit(req, tx, 'demo.account_created', 'user', id, { email, role, expiresAt });
  });
  return inviteFor(req, id);
}

async function updateAccount(req: Request, id: string, input: Record<string, unknown>) {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (typeof input.isActive === 'boolean') { sets.push('is_active = :active', 'token_version = token_version + 1'); params.active = input.isActive; }
  if (input.expiresAt !== undefined) {
    const date = input.expiresAt ? new Date(String(input.expiresAt)) : null;
    if (date && Number.isNaN(date.getTime())) throw badRequest('تاريخ غير صالح.');
    sets.push('demo_expires_at = :expires'); params.expires = date?.toISOString() ?? null;
  }
  if (!sets.length) throw badRequest('لا يوجد تغيير.');
  const rows = await execute(`UPDATE users SET ${[...new Set(sets)].join(', ')}, updated_at = now() WHERE id = :id AND is_demo RETURNING id`, params);
  if (!rows.length) throw notFound('الحساب التجريبي غير موجود.');
  await recordAudit(req, null, 'demo.account_updated', 'user', id, { isActive: input.isActive, expiresAt: input.expiresAt });
  return { ok: true };
}

async function toggleAccounts(req: Request, on: boolean) {
  const rows = await execute('UPDATE users SET is_active = :on, token_version = token_version + 1, updated_at = now() WHERE is_demo RETURNING id', { on });
  await recordAudit(req, null, on ? 'demo.all_enabled' : 'demo.all_disabled', 'user', null, { count: rows.length });
  return { count: rows.length };
}

/* ---------- the real system asks the demo copy ---------- */

async function viaBridge<T>(path: string, method = 'GET', payload?: unknown): Promise<T> {
  const link = bridge()!;
  let response: globalThis.Response;
  try {
    response = await fetch(`${link.url}/api/demo-bridge${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-Demo-Bridge-Key': link.key },
      body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new HttpError(502, 'تعذر الوصول إلى نسخة العرض التجريبية. تأكد أنها تعمل.');
  }
  const json = await response.json().catch(() => ({})) as { data?: T; message?: string };
  if (!response.ok) throw new HttpError(response.status === 401 ? 502 : response.status, json.message || 'رفضت نسخة العرض الطلب.');
  return json.data as T;
}

/**
 * Demo accounts for showing the system to others. Only the owner manages them,
 * from the owner console of the real system: he invites a guest by WhatsApp,
 * SMS or e-mail, and switches the account on or off or gives it an end date.
 * The accounts themselves live on the separate demo copy with made-up data,
 * so a guest never sees a real name or salary, and the guest sets the password.
 */
export class DemoController {
  static async list(_req: Request, res: Response): Promise<void> {
    if (demoInstance()) { res.json({ data: { ...(await listAccounts()), mode: 'local' } }); return; }
    if (bridge()) {
      try { res.json({ data: { ...(await viaBridge<object>('/accounts')), mode: 'bridge' } }); }
      catch (error) { res.json({ data: { accounts: [], employees: [], mode: 'bridge', error: (error as Error).message } }); }
      return;
    }
    res.json({ data: { accounts: [], employees: [], mode: 'off' } });
  }

  static async create(req: Request, res: Response): Promise<void> {
    const input = body(req);
    if (demoInstance()) { res.status(201).json({ data: await createAccount(req, input) }); return; }
    if (!bridge()) throw conflict('نسخة العرض التجريبية غير مربوطة بعد.');
    const invite = await viaBridge<Invite>('/accounts', 'POST', input);
    await recordAudit(req, null, 'demo.guest_invited', 'demo_account', invite.id, { email: invite.login, role: input.role });
    res.status(201).json({ data: invite });
  }

  static async invite(req: Request, res: Response): Promise<void> {
    if (demoInstance()) { res.json({ data: await inviteFor(req, req.params.id) }); return; }
    if (!bridge()) throw conflict('نسخة العرض التجريبية غير مربوطة بعد.');
    const invite = await viaBridge<Invite>(`/accounts/${req.params.id}/invite`, 'POST', {});
    await recordAudit(req, null, 'demo.guest_reinvited', 'demo_account', req.params.id);
    res.json({ data: invite });
  }

  static async update(req: Request, res: Response): Promise<void> {
    const input = body(req);
    if (demoInstance()) { res.json({ data: await updateAccount(req, req.params.id, input) }); return; }
    if (bridge()) {
      const result = await viaBridge(`/accounts/${req.params.id}`, 'PATCH', input);
      await recordAudit(req, null, 'demo.guest_updated', 'demo_account', req.params.id, { isActive: input.isActive, expiresAt: input.expiresAt });
      res.json({ data: result });
      return;
    }
    // A demo account found inside the real system can only be switched off here.
    if (input.isActive !== false) throw conflict('لا تُفعّل الحسابات التجريبية في النظام الحقيقي.');
    res.json({ data: await updateAccount(req, req.params.id, { isActive: false }) });
  }

  static async toggleAll(req: Request, res: Response): Promise<void> {
    const on = body(req).enabled === true;
    if (demoInstance()) { res.json({ data: await toggleAccounts(req, on) }); return; }
    if (bridge()) {
      const result = await viaBridge('/toggle', 'POST', { enabled: on });
      await recordAudit(req, null, on ? 'demo.guests_enabled' : 'demo.guests_disabled', 'demo_account', null);
      res.json({ data: result });
      return;
    }
    if (on) throw conflict('لا تُفعّل الحسابات التجريبية في النظام الحقيقي.');
    res.json({ data: await toggleAccounts(req, false) });
  }

  /* ---------- the demo copy's private door for the real system ---------- */

  /** Lets in only the real system holding the shared key; the work is recorded under the demo copy's owner. */
  static async bridgeAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const expected = process.env.DEMO_BRIDGE_KEY || '';
    const given = req.header('x-demo-bridge-key') || '';
    const ok = demoInstance() && expected.length >= 32 && given.length === expected.length
      && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) { res.status(404).json({ message: 'غير موجود.' }); return; }
    const owner = await selectOne<{ id: string; name: string; email: string }>(
      "SELECT id, name, email FROM users WHERE role = 'super_admin' AND is_active ORDER BY created_at LIMIT 1");
    if (!owner) { res.status(503).json({ message: 'نسخة العرض بلا مالك.' }); return; }
    req.user = { id: owner.id, name: owner.name, email: owner.email, role: 'super_admin', branchId: null, employeeId: null };
    next();
  }
  static async bridgeList(_req: Request, res: Response): Promise<void> { res.json({ data: await listAccounts() }); }
  static async bridgeCreate(req: Request, res: Response): Promise<void> { res.status(201).json({ data: await createAccount(req, body(req)) }); }
  static async bridgeInvite(req: Request, res: Response): Promise<void> { res.json({ data: await inviteFor(req, req.params.id) }); }
  static async bridgeUpdate(req: Request, res: Response): Promise<void> { res.json({ data: await updateAccount(req, req.params.id, body(req)) }); }
  static async bridgeToggle(req: Request, res: Response): Promise<void> { res.json({ data: await toggleAccounts(req, body(req).enabled === true) }); }
}

export default DemoController;
