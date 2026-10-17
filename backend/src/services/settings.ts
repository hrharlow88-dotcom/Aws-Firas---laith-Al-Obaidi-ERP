import { Request } from 'express';
import { SystemSetting } from '../models';
import { Permission, SystemSettings, normalizeSystemSettings, permissionsFor } from '../config/systemSettings';

export const SETTINGS_ID = '00000000-0000-4000-8000-000000000001';
const CACHE_MS = 5000;

let cached: { at: number; value: SystemSettings } | null = null;

/** Settings are read on nearly every request, so they are cached briefly. */
export async function getSettings(): Promise<SystemSettings> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const record = await SystemSetting.findByPk(SETTINGS_ID);
  const value = normalizeSystemSettings(record?.value);
  cached = { at: Date.now(), value };
  return value;
}

export function invalidateSettingsCache(): void {
  cached = null;
}

export async function userPermissions(req: Request): Promise<Permission[]> {
  if (!req.user) return [];
  return permissionsFor(req.user.role, await getSettings());
}

export async function can(req: Request, permission: Permission): Promise<boolean> {
  return (await userPermissions(req)).includes(permission);
}
