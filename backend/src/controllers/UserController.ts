import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { Op } from 'sequelize';
import { Branch, Employee, User } from '../models';
import { ROLES, UserRole } from '../types';
import { audited } from '../utils/audit';
import { isUuid } from '../utils/validation';
import { createSetupToken } from '../services/passwordSetup';
import { recordAudit } from '../utils/audit';

/** Roles whose data scope comes from the linked employee record. */
const NEEDS_EMPLOYEE: UserRole[] = ['employee', 'line_manager'];

function toSafeUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    branchId: user.branchId,
    employeeId: user.employeeId,
    isActive: user.isActive,
    lockedUntil: user.lockedUntil && user.lockedUntil > new Date() ? user.lockedUntil : null,
    lastLoginAt: user.lastLoginAt,
    appAccess: user.appAccess,
    notifyEmail: user.notifyEmail,
    personalEmail: user.personalEmail,
  };
}

const APP_ID = /^[a-z-]{2,30}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Someone who manages accounts but is not the system owner can only hand out
 * roles that give no more than they have themselves, so the IT administrator
 * cannot create an HR or payroll account and use it to read salaries.
 */
async function assertMayGrant(req: Request, role: UserRole): Promise<string | null> {
  if (req.user?.role === 'super_admin' && !req.user.isDemo) return null;
  // A plain employee account only ever sees its own record, so any account manager may invite one to the portal.
  if (role === 'employee' && !req.user?.isDemo) return null;
  // Every other role and permission is granted by the system owner alone.
  return 'منح الأدوار والصلاحيات لمالك النظام فقط.';
}

async function validateEmployeeLink(employeeId: unknown, userId?: string): Promise<{ error?: string; id?: string | null }> {
  if (employeeId === undefined) return {};
  if (employeeId === null || employeeId === '') return { id: null };
  if (!isUuid(employeeId)) return { error: 'معرّف الموظف غير صالح.' };
  const employee = await Employee.findByPk(employeeId);
  if (!employee) return { error: 'الموظف غير موجود.' };
  const taken = await User.findOne({ where: { employeeId, ...(userId ? { id: { [Op.ne]: userId } } : {}) } });
  if (taken) return { error: `هذا الموظف مرتبط بحساب آخر (${taken.email}).` };
  return { id: employee.id };
}

export class UserController {
  /** The owner chooses which apps an account sees (null = everything its role allows). */
  static async setApps(req: Request, res: Response): Promise<void> {
    const user = await User.findByPk(req.params.id);
    if (!user) { res.status(404).json({ message: 'الحساب غير موجود.' }); return; }
    const apps = req.body?.apps;
    if (apps !== null && !(Array.isArray(apps) && apps.length <= 60 && apps.every((app) => typeof app === 'string' && APP_ID.test(app)))) {
      res.status(400).json({ message: 'قائمة التطبيقات غير صالحة.' });
      return;
    }
    const before = user.appAccess;
    user.appAccess = apps === null ? null : [...new Set(apps as string[])];
    await user.save();
    await recordAudit(req, null, 'user.apps_set', 'user', user.id, { before, after: user.appAccess });
    res.json({ data: toSafeUser(user) });
  }

  /** E-mail copies of notifications and approvals, to the work or a personal address. */
  static async setNotifications(req: Request, res: Response): Promise<void> {
    const self = !req.params.id || req.params.id === 'me';
    const user = await User.findByPk(self ? req.user!.id : req.params.id);
    if (!user) { res.status(404).json({ message: 'الحساب غير موجود.' }); return; }
    if (!self && req.user!.role !== 'super_admin') { res.status(403).json({ message: 'ليس لديك صلاحية لتنفيذ هذا الإجراء.' }); return; }
    const { notifyEmail, personalEmail } = req.body ?? {};
    if (typeof notifyEmail !== 'boolean' || (personalEmail !== null && personalEmail !== undefined && personalEmail !== '' &&
      !(typeof personalEmail === 'string' && personalEmail.length <= 254 && EMAIL.test(personalEmail)))) {
      res.status(400).json({ message: 'تحقق من البريد.' });
      return;
    }
    user.notifyEmail = notifyEmail;
    user.personalEmail = personalEmail ? String(personalEmail).trim().toLowerCase() : null;
    await user.save();
    await recordAudit(req, null, 'user.notifications_set', 'user', user.id, { notifyEmail, personalEmail: Boolean(user.personalEmail) });
    res.json({ data: toSafeUser(user) });
  }

  static async list(_req: Request, res: Response): Promise<void> {
    const users = await User.findAll({ order: [['name', 'ASC']] });
    const employees = new Map((await Employee.findAll({
      where: { id: users.map((user) => user.employeeId).filter((id): id is string => Boolean(id)) },
      attributes: ['id', 'employeeNo', 'fullName'],
    })).map((employee) => [employee.id, { employeeNo: employee.employeeNo, fullName: employee.fullName }]));
    res.json({ data: users.map((user) => ({ ...toSafeUser(user), employee: user.employeeId ? employees.get(user.employeeId) ?? null : null })) });
  }

  static async create(req: Request, res: Response): Promise<void> {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { name, email, password, role, branchId } = body;
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      typeof email !== 'string' ||
      !email.trim() ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
      typeof password !== 'string' ||
      password.length < 12 ||
      Buffer.byteLength(password, 'utf8') > 72 ||
      !ROLES.includes(role as UserRole)
    ) {
      res.status(400).json({ message: 'أدخل اسماً وبريداً صحيحاً ودوراً صالحاً وكلمة مرور من 12 محرفاً على الأقل.' });
      return;
    }
    if (
      Object.keys(body).some((field) => !['name', 'email', 'password', 'role', 'branchId', 'employeeId'].includes(field)) ||
      (branchId !== undefined && branchId !== null && branchId !== '' && !isUuid(branchId))
    ) {
      res.status(400).json({ message: 'تحقق من الحقول المدخلة.' });
      return;
    }
    const refused = await assertMayGrant(req, role as UserRole);
    if (refused) {
      res.status(403).json({ message: refused });
      return;
    }
    if (role === 'branch_manager' && !isUuid(branchId)) {
      res.status(400).json({ message: 'يجب ربط مدير الفرع بفرع محدد.' });
      return;
    }
    const linkedBranch = isUuid(branchId) ? await Branch.findByPk(branchId) : null;
    if (role === 'branch_manager' && (!linkedBranch || !linkedBranch.isActive)) {
      res.status(400).json({ message: 'اختر فرعاً نشطاً لمدير الفرع.' });
      return;
    }
    const link = await validateEmployeeLink(body.employeeId);
    if (link.error) {
      res.status(400).json({ message: link.error });
      return;
    }
    if (NEEDS_EMPLOYEE.includes(role as UserRole) && !link.id) {
      res.status(400).json({ message: 'اربط الحساب بملف الموظف: صلاحيات الموظف والمدير المباشر تُحدد منه.' });
      return;
    }
    if (await User.findOne({ where: { email: email.trim().toLowerCase() } })) {
      res.status(409).json({ message: 'يوجد حساب بهذا البريد.' });
      return;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await audited(req.user!.id, 'user.created', 'user', (transaction) => User.create({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      passwordHash,
      role: role as UserRole,
      branchId: linkedBranch?.id || null,
      employeeId: link.id ?? null,
    }, { transaction }), { role, employeeId: link.id ?? null });
    res.status(201).json({ data: toSafeUser(user) });
  }

  static async update(req: Request, res: Response): Promise<void> {
    const user = await User.findByPk(req.params.id);
    if (!user) {
      res.status(404).json({ message: 'المستخدم غير موجود.' });
      return;
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { name, role, branchId, isActive } = body;
    if (Object.keys(body).some((field) => !['name', 'role', 'branchId', 'isActive', 'employeeId', 'unlock'].includes(field))) {
      res.status(400).json({ message: 'يتضمن الطلب حقلاً غير قابل للتعديل.' });
      return;
    }
    if (Object.keys(body).length === 0) {
      res.status(400).json({ message: 'أرسل حقلاً واحداً على الأقل لتحديثه.' });
      return;
    }
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      res.status(400).json({ message: 'أدخل اسماً صالحاً للمستخدم.' });
      return;
    }
    if (role !== undefined && !ROLES.includes(role as UserRole)) {
      res.status(400).json({ message: 'الدور المحدد غير صالح.' });
      return;
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
      res.status(400).json({ message: 'حالة الحساب المحددة غير صالحة.' });
      return;
    }
    if (req.user!.role !== 'super_admin') {
      if (user.role === 'super_admin') {
        res.status(403).json({ message: 'حساب مدير النظام يعدّله مدير النظام فقط.' });
        return;
      }
      if (role !== undefined && req.user!.id === user.id) {
        res.status(403).json({ message: 'لا يمكنك تغيير دور حسابك.' });
        return;
      }
      // Changing a role, or switching a privileged account back on, is granting access: the owner's alone.
      const granting = (role !== undefined && role !== user.role) || (isActive === true && !user.isActive);
      const refused = granting ? await assertMayGrant(req, (role ?? user.role) as UserRole) : null;
      if (refused) {
        res.status(403).json({ message: refused });
        return;
      }
    }
    if (req.user?.id === user.id && isActive === false) {
      res.status(400).json({ message: 'لا يمكنك تعطيل حسابك أثناء استخدامه.' });
      return;
    }
    const nextRole = (role || user.role) as UserRole;
    const nextBranchId = branchId === undefined ? user.branchId : branchId;
    if (nextRole === 'branch_manager') {
      if (!isUuid(nextBranchId)) {
        res.status(400).json({ message: 'يجب ربط مدير الفرع بفرع محدد.' });
        return;
      }
      const linkedBranch = await Branch.findByPk(nextBranchId as string);
      if (!linkedBranch || !linkedBranch.isActive) {
        res.status(400).json({ message: 'اختر فرعاً نشطاً لمدير الفرع.' });
        return;
      }
    }
    if (branchId !== undefined && branchId !== null && branchId !== '' && !isUuid(branchId)) {
      res.status(400).json({ message: 'معرّف الفرع غير صالح.' });
      return;
    }
    const link = await validateEmployeeLink(body.employeeId, user.id);
    if (link.error) {
      res.status(400).json({ message: link.error });
      return;
    }
    const nextEmployeeId = link.id === undefined ? user.employeeId : link.id;
    if (NEEDS_EMPLOYEE.includes(nextRole) && !nextEmployeeId) {
      res.status(400).json({ message: 'اربط الحساب بملف الموظف: صلاحيات الموظف والمدير المباشر تُحدد منه.' });
      return;
    }
    if (user.role === 'super_admin' && ((role && role !== 'super_admin') || isActive === false)) {
      const activeAdmins = await User.count({ where: { role: 'super_admin', isActive: true } });
      if (user.isActive && activeAdmins <= 1) {
        res.status(400).json({ message: 'يجب الإبقاء على مدير نظام نشط واحد على الأقل.' });
        return;
      }
    }
    // Changing what an account may see signs it out everywhere.
    const scopeChanged = (role && role !== user.role) || (branchId !== undefined && branchId !== user.branchId) ||
      (link.id !== undefined && link.id !== user.employeeId) || isActive === false;
    const updatedUser = await audited(req.user!.id, 'user.updated', 'user', (transaction) => user.update({
      ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
      ...(role ? { role: role as UserRole } : {}),
      ...(branchId === null || branchId === '' ? { branchId: null } : typeof branchId === 'string' ? { branchId } : {}),
      ...(typeof isActive === 'boolean' ? { isActive } : {}),
      ...(link.id !== undefined ? { employeeId: link.id } : {}),
      ...(body.unlock === true ? { failedLogins: 0, lockedUntil: null } : {}),
      ...(scopeChanged ? { tokenVersion: user.tokenVersion + 1 } : {}),
    }, { transaction }), {
      role: role ?? undefined, branchId: branchId ?? undefined, isActive: isActive ?? undefined,
      employeeId: link.id ?? undefined, unlocked: body.unlock === true || undefined,
    });
    res.json({ data: toSafeUser(updatedUser) });
  }

  /** A one-week link for a staff member to set their own password (sent by WhatsApp, SMS or e-mail). */
  static async invite(req: Request, res: Response): Promise<void> {
    const user = await User.findByPk(req.params.id);
    if (!user || !user.isActive) {
      res.status(404).json({ message: 'الحساب غير موجود أو موقوف.' });
      return;
    }
    if (user.role === 'super_admin' && req.user!.role !== 'super_admin') {
      res.status(403).json({ message: 'ليس لديك صلاحية لتنفيذ هذا الإجراء.' });
      return;
    }
    const token = await createSetupToken(user.id, 7 * 24 * 60);
    await recordAudit(req, null, 'user.invite_created', 'user', user.id);
    res.json({ data: { path: `/#/set-password/${token}`, login: user.email.endsWith('@portal.local') ? user.email.slice(4, -13).toUpperCase() : user.email, name: user.name, validDays: 7 } });
  }
}

export default UserController;
