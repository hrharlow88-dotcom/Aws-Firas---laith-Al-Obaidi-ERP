import { NextFunction, Request, Response } from 'express';
import type { Permission, PortalSection } from '../config/systemSettings';
import { forbidden } from '../utils/http';
import { getSettings, userPermissions } from './settings';

const REFUSED = 'هذه الخدمة غير متاحة في بوابة الموظف حالياً. يحددها مالك النظام.';

/** Whether the owner left this part of the employee portal switched on. */
export async function portalAllows(section: PortalSection): Promise<boolean> {
  const settings = await getSettings();
  return settings.portal?.[section] !== false;
}

/** Refuses (403) when the owner switched this part of the portal off. */
export async function assertPortal(section: PortalSection): Promise<void> {
  if (!(await portalAllows(section))) throw forbidden(REFUSED);
}

/**
 * Endpoints shared by HR and the portal (leave balances, leave requests):
 * the owner's switch applies when someone acts on their own record without
 * the HR permission that lets them handle anyone's.
 */
export async function selfServiceBlocked(
  req: Request, employeeId: string, section: PortalSection, hrPermission: Permission,
): Promise<boolean> {
  if (!req.user?.employeeId || req.user.employeeId !== employeeId || req.user.role === 'super_admin') return false;
  if (await portalAllows(section)) return false;
  return !(await userPermissions(req)).includes(hrPermission);
}

/** Route guard for /me/* endpoints. */
export function requirePortal(section: PortalSection) {
  return (req: Request, res: Response, next: NextFunction): void => {
    portalAllows(section)
      .then((allowed) => (allowed ? next() : void res.status(403).json({ message: REFUSED })))
      .catch(next);
  };
}

export { REFUSED as PORTAL_REFUSED };
