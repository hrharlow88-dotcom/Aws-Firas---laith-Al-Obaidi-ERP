import { Request, Response } from 'express';
import { AuditLog, EMPLOYMENT_TYPES, SystemSetting, sequelize } from '../models';
import {
  EmployeeFieldSetting,
  LeaveTypeSetting,
  normalizeSystemSettings,
  PAYROLL_CALCULATIONS,
  PERMISSIONS,
  PayrollComponentSetting,
  SystemSettings,
  isUserRole,
} from '../config/systemSettings';
import { invalidateSettingsCache } from '../services/settings';
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
    hasOnlyKeys(item, ['id', 'name', 'unit', 'paid', 'active', 'annualEntitlement', 'carryForwardLimit', 'serviceEntitlements', 'dayCountBasis', 'requiresMedicalCertificate', 'deductsBalance', 'monthlyAccrual', 'accrualEmploymentTypes']) &&
    typeof item.id === 'string' && /^[0-9a-f-]{36}$/i.test(item.id) &&
    isText(item.name, 80) && item.name.trim().length > 0 &&
    (item.unit === 'days' || item.unit === 'hours') &&
    typeof item.paid === 'boolean' &&
    typeof item.active === 'boolean' &&
    isOptionalNumber(item.annualEntitlement) &&
    isOptionalNumber(item.carryForwardLimit) &&
    (item.serviceEntitlements === undefined ||
      (Array.isArray(item.serviceEntitlements) && item.serviceEntitlements.length <= 20 &&
        item.serviceEntitlements.every((tier) => isRecord(tier) &&
          hasOnlyKeys(tier, ['minimumYears', 'days']) &&
          Number.isInteger(tier.minimumYears) && Number(tier.minimumYears) >= 0 && Number(tier.minimumYears) <= 60 &&
          typeof tier.days === 'number' && Number.isFinite(tier.days) && tier.days >= 0 && tier.days <= 365) &&
        new Set(item.serviceEntitlements.map((tier) => (tier as Record<string, unknown>).minimumYears)).size === item.serviceEntitlements.length &&
        item.serviceEntitlements.every((tier, index, tiers) =>
          index === 0 || Number((tiers[index - 1] as Record<string, unknown>).minimumYears) < Number((tier as Record<string, unknown>).minimumYears),
        ))) &&
    (item.dayCountBasis === undefined || item.dayCountBasis === 'working' || item.dayCountBasis === 'calendar') &&
    (item.requiresMedicalCertificate === undefined || typeof item.requiresMedicalCertificate === 'boolean') &&
    (item.deductsBalance === undefined || typeof item.deductsBalance === 'boolean') &&
    (item.monthlyAccrual === undefined || typeof item.monthlyAccrual === 'boolean') &&
    (item.monthlyAccrual !== true || (item.unit === 'days' && typeof item.annualEntitlement === 'number' && item.deductsBalance !== false)) &&
    (item.accrualEmploymentTypes === undefined || (Array.isArray(item.accrualEmploymentTypes) &&
      item.accrualEmploymentTypes.every((type) => typeof type === 'string' && (EMPLOYMENT_TYPES as readonly string[]).includes(type)))),
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
    'workingDays', 'officialHolidays', 'maxHoursPerRequest', 'hourlyMonthlyQuota',
    'hourlyMonthlyUsageLimit', 'lowBalanceThreshold', 'accrualStartPeriod',
  ])) return false;
  if (value.accrualStartPeriod !== undefined && value.accrualStartPeriod !== null &&
    !(typeof value.accrualStartPeriod === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.accrualStartPeriod))) return false;
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
    typeof value.maxHoursPerRequest === 'number' && Number.isFinite(value.maxHoursPerRequest) &&
    value.maxHoursPerRequest > 0 && value.maxHoursPerRequest <= 24 &&
    typeof value.hourlyMonthlyQuota === 'number' && Number.isFinite(value.hourlyMonthlyQuota) &&
    value.hourlyMonthlyQuota >= 0 && value.hourlyMonthlyQuota <= 744 &&
    Number.isInteger(value.hourlyMonthlyUsageLimit) &&
    Number(value.hourlyMonthlyUsageLimit) >= 0 && Number(value.hourlyMonthlyUsageLimit) <= 31 &&
    typeof value.lowBalanceThreshold === 'number' && Number.isFinite(value.lowBalanceThreshold) &&
    value.lowBalanceThreshold >= 0 && value.lowBalanceThreshold <= 10000;
}

function validatePayrollRules(value: unknown): value is SystemSettings['payrollRules'] {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'baseCurrency', 'monthlyDivisor', 'roundingDigits', 'terminatedPaidBySettlement', 'usdRate', 'branchUsdRates', 'components',
  ])) {
    return false;
  }
  const validRate = (rate: unknown) => typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && rate < 1e6;
  if (value.usdRate !== undefined && !validRate(value.usdRate)) return false;
  if (value.branchUsdRates !== undefined && (!isRecord(value.branchUsdRates) ||
    !Object.entries(value.branchUsdRates).every(([branchId, rate]) => /^[0-9a-f-]{36}$/i.test(branchId) && validRate(rate)))) return false;
  if (value.terminatedPaidBySettlement !== undefined && typeof value.terminatedPaidBySettlement !== 'boolean') return false;
  const components = value.components;
  if (
    !isText(value.baseCurrency, 3) || !/^[A-Z]{3}$/.test(value.baseCurrency) ||
    typeof value.monthlyDivisor !== 'number' || !Number.isFinite(value.monthlyDivisor) ||
    value.monthlyDivisor <= 0 || value.monthlyDivisor > 31 ||
    !Number.isInteger(value.roundingDigits) || Number(value.roundingDigits) < 0 || Number(value.roundingDigits) > 4 ||
    !Array.isArray(components) || components.length > MAX_LIST_ITEMS
  ) return false;

  const valid = components.every((item): item is PayrollComponentSetting =>
    isRecord(item) &&
    hasOnlyKeys(item, [
      'id', 'name', 'category', 'calculation', 'rate', 'active', 'statutory', 'legalApproved', 'isBasic',
      'prorate', 'minBase', 'maxBase', 'roundingDigits',
    ]) &&
    typeof item.id === 'string' && /^[0-9a-f-]{36}$/i.test(item.id) &&
    isText(item.name, 80) && item.name.trim().length > 0 &&
    (item.category === 'earning' || item.category === 'deduction') &&
    (PAYROLL_CALCULATIONS as string[]).includes(String(item.calculation)) &&
    (item.calculation !== 'per_overtime_hour' || item.category === 'earning') &&
    (item.calculation !== 'per_late_minute' || item.category === 'deduction') &&
    (!['percentage_of_ss_base', 'loan_installments'].includes(String(item.calculation)) || item.category === 'deduction') &&
    (item.prorate === undefined || typeof item.prorate === 'boolean') &&
    (item.minBase === undefined || (typeof item.minBase === 'number' && Number.isFinite(item.minBase) && item.minBase >= 0)) &&
    (item.maxBase === undefined || (typeof item.maxBase === 'number' && Number.isFinite(item.maxBase) && item.maxBase >= 0)) &&
    (item.minBase === undefined || item.maxBase === undefined || item.minBase <= item.maxBase) &&
    (item.roundingDigits === undefined || (typeof item.roundingDigits === 'number' && Number.isInteger(item.roundingDigits) && item.roundingDigits >= 0 && item.roundingDigits <= 4)) &&
    (item.isBasic === undefined || (typeof item.isBasic === 'boolean' && (!item.isBasic || item.category === 'earning'))) &&
    typeof item.rate === 'number' && Number.isFinite(item.rate) && item.rate >= 0 && item.rate <= 100000 &&
    (!['percentage_of_gross', 'percentage_of_basic', 'percentage_of_ss_base'].includes(String(item.calculation)) || item.rate <= 100) &&
    typeof item.active === 'boolean' &&
    typeof item.statutory === 'boolean' &&
    typeof item.legalApproved === 'boolean' &&
    (!item.statutory || !item.active || item.legalApproved),
  );
  return valid &&
    components.filter((item) => item.isBasic).length <= 1 &&
    components.filter((item) => item.active && item.calculation === 'loan_installments').length <= 1 &&
    new Set(components.map((item) => item.id)).size === components.length &&
    new Set(components.map((item) => item.name.trim().toLocaleLowerCase())).size === components.length &&
    components
      .filter((item) => item.category === 'earning' && item.calculation === 'percentage_of_gross' && item.active)
      .reduce((sum, item) => sum + item.rate, 0) <= 100;
}

function validateAttendanceRules(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'lateMonthlyAllowanceMinutes', 'overtimeMinimumMinutes', 'duplicatePunchWindowMinutes', 'markAbsentWithoutPunch',
  ])) return false;
  const minutes = (item: unknown, max: number) => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= max;
  return minutes(value.lateMonthlyAllowanceMinutes, 6000) &&
    minutes(value.overtimeMinimumMinutes, 600) &&
    minutes(value.duplicatePunchWindowMinutes, 60) &&
    typeof value.markAbsentWithoutPunch === 'boolean';
}

function validateSettings(value: unknown): value is SystemSettings {
  if (
    !isRecord(value) ||
    !isRecord(value.company) ||
    !isRecord(value.roles) ||
    !hasOnlyKeys(value, [
      'company', 'leaveTypes', 'approvalSteps', 'roles', 'employeeFields', 'leaveRules', 'payrollRules',
      'attendanceRules', 'knownPermissions',
    ]) ||
    (value.knownPermissions !== undefined && (!Array.isArray(value.knownPermissions) ||
      !value.knownPermissions.every((permission) => typeof permission === 'string'))) ||
    !validateAttendanceRules(value.attendanceRules) ||
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
    validatePayrollRules(value.payrollRules) &&
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
      res.status(400).json({ message: 'تحقق من إعدادات الشركة والإجازات والرواتب والموافقات والأدوار والحقول.' });
      return;
    }
    // The administrator saved the full permission matrix, so every permission
    // that exists now counts as reviewed for future upgrades.
    const settings = normalizeSystemSettings({ ...req.body, knownPermissions: [...PERMISSIONS] });
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
    invalidateSettingsCache();
    res.json({ data: normalizeSystemSettings(record.value) });
  }
}

export default SettingsController;
