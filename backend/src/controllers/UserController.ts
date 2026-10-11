import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { Branch, User } from '../models';
import { ROLES, UserRole } from '../types';
import { audited } from '../utils/audit';
import { isUuid } from '../utils/validation';

function toSafeUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    branchId: user.branchId,
    isActive: user.isActive,
  };
}

export class UserController {
  static async list(_req: Request, res: Response): Promise<void> {
    const users = await User.findAll({
      attributes: ['id', 'name', 'email', 'role', 'branchId', 'isActive'],
      order: [['name', 'ASC']],
    });
    res.json({ data: users.map(toSafeUser) });
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
    if (role === 'super_admin' && req.user?.role !== 'super_admin') {
      res.status(403).json({ message: 'لا يمكن إنشاء مدير نظام إلا بواسطة مدير النظام.' });
      return;
    }
    if (
      Object.keys(body).some((field) => !['name', 'email', 'password', 'role', 'branchId'].includes(field)) ||
      (branchId !== undefined && branchId !== null && branchId !== '' && !isUuid(branchId))
    ) {
      res.status(400).json({ message: 'تحقق من الحقول المدخلة.' });
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
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await audited(req.user!.id, 'user.created', 'user', (transaction) => User.create({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      passwordHash,
      role: role as UserRole,
      branchId: linkedBranch?.id || null,
    }, { transaction }));
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
    if (Object.keys(body).some((field) => !['name', 'role', 'branchId', 'isActive'].includes(field))) {
      res.status(400).json({ message: 'يتضمن الطلب حقلاً غير قابل للتعديل.' });
      return;
    }
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      res.status(400).json({ message: 'أدخل اسماً صالحاً للمستخدم.' });
      return;
    }
    const nextRole = (role || user.role) as UserRole;
    const nextBranchId = branchId === undefined ? user.branchId : branchId;
    if (role !== undefined && !ROLES.includes(role as UserRole)) {
      res.status(400).json({ message: 'الدور المحدد غير صالح.' });
      return;
    }
    if (role === 'super_admin' && req.user?.role !== 'super_admin') {
      res.status(403).json({ message: 'لا يمكن ترقية حساب إلى مدير نظام إلا بواسطة مدير النظام.' });
      return;
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
      res.status(400).json({ message: 'حالة الحساب المحددة غير صالحة.' });
      return;
    }
    if (Object.keys(body).length === 0) {
      res.status(400).json({ message: 'أرسل حقلاً واحداً على الأقل لتحديثه.' });
      return;
    }
    if (req.user?.id === user.id && isActive === false) {
      res.status(400).json({ message: 'لا يمكنك تعطيل حسابك أثناء استخدامه.' });
      return;
    }
    if (nextRole === 'branch_manager' && (typeof nextBranchId !== 'string' || !nextBranchId)) {
      res.status(400).json({ message: 'يجب ربط مدير الفرع بفرع محدد.' });
      return;
    }
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
    if (branchId !== undefined && branchId !== null && !isUuid(branchId)) {
      res.status(400).json({ message: 'معرّف الفرع غير صالح.' });
      return;
    }
    if (isUuid(branchId)) {
      const linkedBranch = await Branch.findByPk(branchId);
      if (!linkedBranch || !linkedBranch.isActive) {
        res.status(400).json({ message: 'اختر فرعاً نشطاً وصحيحاً.' });
        return;
      }
    }
    if (
      user.role === 'super_admin' &&
      (role === 'hr_manager' || role === 'hr_staff' || role === 'finance' || role === 'branch_manager' || role === 'viewer' || isActive === false)
    ) {
      const activeAdmins = await User.count({ where: { role: 'super_admin', isActive: true } });
      if (user.isActive && activeAdmins <= 1) {
        res.status(400).json({ message: 'يجب الإبقاء على مدير نظام نشط واحد على الأقل.' });
        return;
      }
    }
    const updatedUser = await audited(req.user!.id, 'user.updated', 'user', (transaction) => user.update({
      ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
      ...(role ? { role: role as UserRole } : {}),
      ...(branchId === null || typeof branchId === 'string' ? { branchId } : {}),
      ...(typeof isActive === 'boolean' ? { isActive } : {}),
    }, { transaction }));
    res.json({ data: toSafeUser(updatedUser) });
  }
}

export default UserController;
