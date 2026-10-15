import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AuditLog, User, sequelize } from '../models';
import { randomUUID } from 'node:crypto';
import { useSetupToken } from '../services/passwordSetup';
import { clientIp, recordSecurityEvent } from '../services/security';
import { getSettings } from '../services/settings';
import { execute } from '../db/query';
import { isUuid } from '../utils/validation';

/** Wrong passwords in a row before the account is locked, and for how long. */
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

export class AuthController {
  static async login(req: Request, res: Response): Promise<void> {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    // Staff sign in with their e-mail; employees on the portal may use their employee number.
    const user = !email ? null : email.includes('@')
      ? await User.findOne({ where: { email } })
      : await User.findOne({ where: sequelize.where(sequelize.fn('lower', sequelize.col('username')), email) });
    const refused = () => res.status(401).json({ message: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' });

    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      res.status(423).json({ message: `الحساب مقفل مؤقتاً بسبب محاولات دخول خاطئة. حاول بعد ${minutes} دقيقة أو اطلب فتحه من مدير النظام.` });
      return;
    }
    // Compare against a dummy hash for unknown e-mails so timing does not reveal which accounts exist.
    const passwordOk = Buffer.byteLength(password, 'utf8') <= 72 &&
      await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH) && Boolean(user);
    const demoExpired = Boolean(user?.isDemo && user.demoExpiresAt && user.demoExpiresAt < new Date());
    if (!user || !passwordOk || !user.isActive || demoExpired) {
      await recordSecurityEvent('login_failed', req, { known: Boolean(user) }, user?.id ?? null);
      if (user && !passwordOk) {
        // Count failures per account; the password itself is never logged.
        const failures = user.failedLogins + 1;
        const lock = failures >= MAX_FAILED_LOGINS;
        await sequelize.transaction(async (transaction) => {
          await user.update({
            failedLogins: lock ? 0 : failures,
            lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60000) : user.lockedUntil,
          }, { transaction });
          await AuditLog.create({
            userId: user.id, action: lock ? 'auth.account_locked' : 'auth.login_failed', entityType: 'user', entityId: user.id,
            details: { failures }, ip: (req.ip || '').slice(0, 64) || null,
          }, { transaction });
        });
      }
      refused();
      return;
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      res.status(500).json({ message: 'إعدادات تسجيل الدخول غير مكتملة.' });
      return;
    }
    const loginEventId = randomUUID();
    await sequelize.transaction(async (transaction) => {
      await user.update({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(), lastSeenAt: new Date() }, { transaction });
      await AuditLog.create({
        userId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, ip: (req.ip || '').slice(0, 64) || null,
      }, { transaction });
      await execute(
        `INSERT INTO login_events (id, user_id, channel, ip, user_agent) VALUES (:id, :userId, :channel, :ip, :agent)`,
        {
          id: loginEventId, userId: user.id, channel: user.role === 'employee' ? 'portal' : 'staff', ip: clientIp(req),
          agent: (req.header('user-agent') || '').slice(0, 400) || null,
        },
        transaction,
      );
    });
    const settings = await getSettings();

    const token = jwt.sign({ sub: user.id, ver: user.tokenVersion }, secret, { expiresIn: '8h' });
    res.json({
      token,
      loginEventId,
      askLocation: settings.security.askLocationOnLogin,
      idleMinutes: settings.security.idleMinutes,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        branchId: user.branchId,
        employeeId: user.employeeId,
        isDemo: user.isDemo,
      },
      demo: process.env.DEMO_MODE === 'true',
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
    if (user?.isDemo) {
      res.status(403).json({ message: 'كلمة مرور الحساب التجريبي يغيّرها مالك النظام فقط.' });
      return;
    }
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

  /** Sets a password with a one-time link printed on the server console. */
  static async setPasswordWithLink(req: Request, res: Response): Promise<void> {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const token = typeof body.token === 'string' ? body.token : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
      res.status(400).json({ message: 'الرابط غير صالح.' });
      return;
    }
    if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
      res.status(400).json({ message: 'كلمة المرور يجب ألا تقل عن 12 محرفاً ولا تتجاوز 72 بايتاً.' });
      return;
    }
    const email = await useSetupToken(token, password, (req.ip || '').slice(0, 64) || null);
    if (!email) {
      res.status(400).json({ message: 'انتهت صلاحية الرابط أو استُخدم سابقاً. اطلب رابطاً جديداً.' });
      return;
    }
    res.json({ email, message: 'عُيّنت كلمة المرور. سجّل الدخول بها الآن.' });
  }

  /**
   * The browser reports where the person signed in from, after they allowed it.
   * Only the person's own sign-in of the last ten minutes can be updated, once.
   */
  static async loginLocation(req: Request, res: Response): Promise<void> {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const eventId = body.eventId;
    const status = body.status;
    if (!isUuid(eventId) || !['shared', 'denied', 'unavailable'].includes(String(status))) {
      res.status(400).json({ message: 'بيانات الموقع غير صالحة.' });
      return;
    }
    const lat = Number(body.latitude);
    const lng = Number(body.longitude);
    const accuracy = Number(body.accuracy);
    const shared = status === 'shared';
    if (shared && !(Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lng) && lng >= -180 && lng <= 180)) {
      res.status(400).json({ message: 'إحداثيات غير صالحة.' });
      return;
    }
    const rows = await execute<{ id: string }>(
      `UPDATE login_events SET location_status = :status, latitude = :lat, longitude = :lng, accuracy_m = :accuracy, location_at = now()
       WHERE id = :eventId AND user_id = :userId AND location_status = 'pending' AND at > now() - interval '10 minutes'
       RETURNING id`,
      {
        status, eventId, userId: req.user!.id,
        lat: shared ? Math.round(lat * 1e6) / 1e6 : null, lng: shared ? Math.round(lng * 1e6) / 1e6 : null,
        accuracy: shared && Number.isFinite(accuracy) && accuracy >= 0 ? Math.min(Math.round(accuracy), 2000000) : null,
      },
    );
    res.json({ data: { saved: rows.length > 0 } });
  }

  static me(req: Request, res: Response): void {
    res.json({ user: req.user });
  }
}

export default AuthController;
