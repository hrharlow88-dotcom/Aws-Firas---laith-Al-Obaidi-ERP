import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models';
import { AuthenticatedUser, UserRole } from '../types';
import { Permission } from '../config/systemSettings';
import { getSettings, userPermissions } from '../services/settings';
import { recordSecurityEvent } from '../services/security';
import { execute } from '../db/query';

/** last_seen_at is written at most this often per account. */
const SEEN_WRITE_MS = 30000;

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const jwtSecret = process.env.JWT_SECRET;
  const header = req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token || !jwtSecret) {
    res.status(401).json({ message: 'يلزم تسجيل الدخول للمتابعة.' });
    return;
  }

  try {
    const claims = jwt.verify(token, jwtSecret);
    if (typeof claims === 'string' || !claims.sub) {
      res.status(401).json({ message: 'انتهت صلاحية الجلسة. سجّل الدخول مجدداً.' });
      return;
    }

    void Promise.all([User.findByPk(String(claims.sub)), getSettings()]).then(async ([user, settings]) => {
      if (!user || !user.isActive || Number(claims.ver) !== user.tokenVersion) {
        res.status(401).json({ message: 'الحساب غير نشط أو غير موجود.' });
        return;
      }
      // Idle sign-out: a session with no activity for the owner's chosen minutes ends.
      // Background polling (notification counts) does not count as activity.
      const now = Date.now();
      const idleMs = settings.security.idleMinutes * 60000;
      const lastSeen = user.lastSeenAt?.getTime() ?? 0;
      if (lastSeen && now - lastSeen > idleMs) {
        res.status(401).json({ message: `انتهت الجلسة بعد ${settings.security.idleMinutes} دقيقة بلا نشاط. سجّل الدخول مجدداً.`, reason: 'idle' });
        return;
      }
      if (req.header('x-background') !== '1' && now - lastSeen > SEEN_WRITE_MS) {
        await execute('UPDATE users SET last_seen_at = now() WHERE id = :id', { id: user.id });
      }
      req.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        branchId: user.branchId,
        employeeId: user.employeeId,
      };
      next();
    }).catch(next);
  } catch {
    res.status(401).json({ message: 'انتهت صلاحية الجلسة. سجّل الدخول مجدداً.' });
  }
}

export function allowRoles(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user || !roles.includes(user.role)) {
      if (user) void recordSecurityEvent('forbidden', req, { needed: roles });
      res.status(403).json({ message: 'ليس لديك صلاحية لتنفيذ هذا الإجراء.' });
      return;
    }
    next();
  };
}

export function allowPermission(permission: Permission) {
  return allowAnyPermission(permission);
}

export function allowAnyPermission(...permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(403).json({ message: 'ليس لديك صلاحية لتنفيذ هذا الإجراء.' });
      return;
    }
    void userPermissions(req)
      .then((granted) => {
        if (!granted.some((permission) => permissions.includes(permission))) {
          void recordSecurityEvent('forbidden', req, { needed: permissions });
          res.status(403).json({ message: 'ليس لديك صلاحية لتنفيذ هذا الإجراء.' });
          return;
        }
        next();
      })
      .catch(next);
  };
}
