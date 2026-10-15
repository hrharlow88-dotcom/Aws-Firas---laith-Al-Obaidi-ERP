import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models';
import { AuthenticatedUser, UserRole } from '../types';
import { Permission } from '../config/systemSettings';
import { userPermissions } from '../services/settings';

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

    void User.findByPk(String(claims.sub)).then((user) => {
      if (!user || !user.isActive || Number(claims.ver) !== user.tokenVersion) {
        res.status(401).json({ message: 'الحساب غير نشط أو غير موجود.' });
        return;
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
          res.status(403).json({ message: 'ليس لديك صلاحية لتنفيذ هذا الإجراء.' });
          return;
        }
        next();
      })
      .catch(next);
  };
}
