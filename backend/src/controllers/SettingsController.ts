import { Request, Response } from 'express';
import { AuditLog, SystemSetting, sequelize } from '../models';
import {
  EmployeeFieldSetting,
  LeaveTypeSetting,
  normalizeSystemSettings,
  PERMISSIONS,
  SystemSettings,
  isUserRole,
} from '../config/systemSettings';
import { ROLES } from '../types';

const GLOBAL_SETTINGS_ID = '00000000-0000-4000-8000-000000000001';
const MAX_LIST_ITEMS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isOptionalNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000);
}

function validateLeaveTypes(value: unknown): value is LeaveTypeSetting[] {
  return Array.isArray(value) && value.length <= MAX_LIST_ITEMS && value.every((item) =>
    isRecord(item) &&
    hasOnlyKeys(item, ['id', 'name', 'unit', 'paid', 'active', 'annualEntitlement', 'carryForwardLimit']) &&
    typeof item.id === 'string' && /^[0-9a-f-]{36}$/i.test(item.id) &&
    isText(item.name, 80) && item.name.trim().length > 0 &&
    (item.unit === 'days' || item.unit === 'hours') &&
    typeof item.paid === 'boolean' &&
    typeof item.active === 'boolean' &&
    isOptionalNumber(item.annualEntitlement) &&
    isOptionalNumber(item.carryForwardLimit),
  ) && new Set(value.map((item) => item.id)).size === value.length;
}

function validateEmployeeFields(value: unknown): value is EmployeeFieldSetting[] {
  return Array.isArray(value) && value.length <= MAX_LIST_ITEMS && value.every((item) =>
    isRecord(item) &&
    hasOnlyKeys(item, ['id', 'key', 'label', 'type', 'required', 'enabled', 'options']) &&
    typeof item.id === 'string' && /^[0-9a-f-]{36}$/i.test(item.id) &&
    typeof item.key === 'string' && /^[a-z][a-zA-Z0-9_]{0,39}$/.test(item.key) &&
    isText(item.label, 80) && item.label.trim().length > 0 &&
    ['text', 'number', 'date', 'select'].includes(String(item.type)) &&
    typeof item.required === 'boolean' &&
    typeof item.enabled === 'boolean' &&
    Array.isArray(item.options) && item.options.length <= 50 &&
    item.options.every((option) => isText(option, 80) && option.trim().length > 0) &&
    (item.type === 'select' || item.options.length === 0),
  ) && new Set(value.map((item) => item.id)).size === value.length &&
    new Set(value.map((item) => item.key)).size === value.length;
}

function validateLeaveRules(value: unknown): value is SystemSettings['leaveRules'] {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'workingDays', 'officialHolidays', 'hoursPerWorkday', 'hourlyMonthlyQuota',
    'hourlyMonthlyUsageLimit', 'lowBalanceThreshold',
  ])) return false;
  const workingDays = value.workingDays;
  const officialHolidays = value.officialHolidays;
  return Array.isArray(workingDays) && workingDays.length > 0 && workingDays.length <= 7 &&
    workingDays.every((day) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6) &&
    new Set(workingDays).size === workingDays.length &&
    Array.isArray(officialHolidays) && officialHolidays.length <= 500 &&
    officialHolidays.every((date) =>
      typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      !Number.isNaN(Date.parse(`${date}T00:00:00.000Z`)) &&
      new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date,
    ) &&
    new Set(officialHolidays).size === officialHolidays.length &&
    typeof value.hoursPerWorkday === 'number' && Number.isFinite(value.hoursPerWorkday) &&
    value.hoursPerWorkday > 0 && value.hoursPerWorkday <= 24 &&
    typeof value.hourlyMonthlyQuota === 'number' && Number.isFinite(value.hourlyMonthlyQuota) &&
    value.hourlyMonthlyQuota >= 0 && value.hourlyMonthlyQuota <= 744 &&
    Number.isInteger(value.hourlyMonthlyUsageLimit) &&
    Number(value.hourlyMonthlyUsageLimit) >= 0 && Number(value.hourlyMonthlyUsageLimit) <= 31 &&
    typeof value.lowBalanceThreshold === 'number' && Number.isFinite(value.lowBalanceThreshold) &&
    value.lowBalanceThreshold >= 0 && value.lowBalanceThreshold <= 10000;
}

function validateSettings(value: unknown): value is SystemSettings {
  if (
    !isRecord(value) ||
    !isRecord(value.company) ||
    !isRecord(value.roles) ||
    !hasOnlyKeys(value, ['company', 'leaveTypes', 'approvalSteps', 'roles', 'employeeFields', 'leaveRules']) ||
    !hasOnlyKeys(value.company, ['displayName', 'legalName', 'phone', 'email', 'address', 'currency', 'timeZone']) ||
    !hasOnlyKeys(value.roles, [...ROLES])
  ) return false;
  const company = value.company;
  const roles = value.roles;
  const steps = value.approvalSteps;
  const roleSettingsValid = ROLES.every((role) => {
    const entry = roles[role];
    return isRecord(entry) &&
      hasOnlyKeys(entry, ['label', 'permissions']) &&
      isText(entry.label, 80) && entry.label.trim().length > 0 &&
      Array.isArray(entry.permissions) &&
      entry.permissions.every((permission) => (PERMISSIONS as readonly unknown[]).includes(permission)) &&
      new Set(entry.permissions).size === entry.permissions.length &&
      (!entry.permissions.some((permission) =>
        ['leaves.request', 'leaves.approve', 'leaves.manage_balances'].includes(String(permission)),
      ) || entry.permissions.includes('leaves.view'));
  });
  const allPermissions = [...PERMISSIONS];
  return isText(company.displayName, 160) && company.displayName.trim().length > 0 &&
    isText(company.legalName, 160) &&
    isText(company.phone, 40) &&
    isText(company.email, 254) &&
    (!company.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(company.email)) &&
    isText(company.address, 240) &&
    isText(company.currency, 3) &&
    (!company.currency || /^[A-Z]{3}$/.test(company.currency)) &&
    isText(company.timeZone, 80) && company.timeZone.trim().length > 0 &&
    validateLeaveTypes(value.leaveTypes) &&
    validateLeaveRules(value.leaveRules) &&
    Array.isArray(steps) && steps.length <= 20 &&
    steps.every((step) => isRecord(step) &&
      hasOnlyKeys(step, ['id', 'role']) &&
      typeof step.id === 'string' && /^[0-9a-f-]{36}$/i.test(step.id) &&
      isUserRole(step.role)) &&
    new Set(steps.map((step) => (step as Record<string, unknown>).id)).size === steps.length &&
    new Set(steps.map((step) => (step as Record<string, unknown>).role)).size === steps.length &&
    roleSettingsValid &&
    (roles.super_admin as Record<string, unknown>).permissions instanceof Array &&
    allPermissions.every((permission) =>
      ((roles.super_admin as Record<string, unknown>).permissions as unknown[]).includes(permission),
    ) &&
    validateEmployeeFields(value.employeeFields);
}

export class SettingsController {
  static async get(_req: Request, res: Response): Promise<void> {
    const record = await SystemSetting.findByPk(GLOBAL_SETTINGS_ID);
    res.json({ data: normalizeSystemSettings(record?.value) });
  }

  static async update(req: Request, res: Response): Promise<void> {
    if (!validateSettings(req.body)) {
      res.status(400).json({ message: 'تحقق من إعدادات الشركة والإجازات والموافقات والأدوار والحقول.' });
      return;
    }
    const settings = req.body;
    const record = await sequelize.transaction(async (transaction) => {
      const [saved] = await SystemSetting.upsert({
        id: GLOBAL_SETTINGS_ID,
        value: settings,
        updatedBy: req.user!.id,
      }, { transaction, returning: true });
      await AuditLog.create({
        userId: req.user!.id,
        action: 'settings.updated',
        entityType: 'system_settings',
        entityId: saved.id,
      }, { transaction });
      return saved;
    });
    res.json({ data: record.value });
  }
}

export default SettingsController;
