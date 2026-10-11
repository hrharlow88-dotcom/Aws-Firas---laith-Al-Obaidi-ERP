import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AuditLog, User, sequelize } from '../models';

export class AuthController {
  static async login(req: Request, res: Response): Promise<void> {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = email ? await User.findOne({ where: { email } }) : null;

    if (
      !user ||
      !user.isActive ||
      Buffer.byteLength(password, 'utf8') > 72 ||
      !(await bcrypt.compare(password, user.passwordHash))
    ) {
      res.status(401).json({ message: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' });
      return;
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      res.status(500).json({ message: 'إعدادات تسجيل الدخول غير مكتملة.' });
      return;
    }

    const token = jwt.sign({ sub: user.id, ver: tokenVersion }, secret, { expiresIn: '8h' });
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        branchId: user.branchId,
      },
    });
  }

  static async changePassword(req: Request, res: Response): Promise<void> {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (newPassword.length < 12 || Buffer.byteLength(newPassword, 'utf8') > 72) {
      res.status(400).json({ message: 'كلمة المرور الجديدة يجب ألا تقل عن 12 محرفاً ولا تتجاوز 72 بايتاً.' });
      return;
    }
    const user = req.user ? await User.findByPk(req.user.id) : null;
    if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      res.status(400).json({ message: 'كلمة المرور الحالية غير صحيحة.' });
      return;
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      res.status(400).json({ message: 'اختر كلمة مرور مختلفة عن الحالية.' });
      return;
    }
    const tokenVersion = user.tokenVersion + 1;
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await sequelize.transaction(async (transaction) => {
      await user.update({ passwordHash, tokenVersion }, { transaction });
      await AuditLog.create({
        userId: user.id,
        action: 'user.password_changed',
        entityType: 'user',
        entityId: user.id,
      }, { transaction });
    });
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      res.status(500).json({ message: 'إعدادات تسجيل الدخول غير مكتملة.' });
      return;
    }
    const token = jwt.sign({ sub: user.id, ver: user.tokenVersion }, secret, { expiresIn: '8h' });
    res.json({ token, message: 'تم تغيير كلمة المرور وإنهاء الجلسات الأخرى.' });
  }

  static me(req: Request, res: Response): void {
    res.json({ user: req.user });
  }
}

export default AuthController;
