import { Request, Response } from 'express';
import { AuditLog, EMPLOYMENT_TYPES, SystemSetting, sequelize } from '../models';
import {
  DEFAULT_PORTAL,
  EmployeeFieldSetting,
  LeaveTypeSetting,
  normalizeSystemSettings,
  PAYROLL_CALCULATIONS,
  PERMISSIONS,
  PayrollComponentSetting,
  SystemSettings,
  isUserRole,
} from '../config/systemSettings';
import { invalidateSettingsCache, userPermissions } from '../services/settings';
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
    'hourlyMonthlyUsageLimit', 'lowBalanceThreshold', 'accrualStartPeriod', 'compLeaveDaysPerHoliday',
  ])) return false;
  if (value.compLeaveDaysPerHoliday !== undefined && !(typeof value.compLeaveDaysPerHoliday === 'number' &&
    value.compLeaveDaysPerHoliday >= 0.5 && value.compLeaveDaysPerHoliday <= 3)) return false;
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
    'baseCurrency', 'monthlyDivisor', 'roundingDigits', 'terminatedPaidBySettlement', 'approvalChain', 'usdRate', 'branchUsdRates', 'components',
    'launchPeriod',
  ])) {
    return false;
  }
  if (value.launchPeriod !== undefined && value.launchPeriod !== null &&
    !(typeof value.launchPeriod === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.launchPeriod))) return false;
  const validRate = (rate: unknown) => typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && rate < 1e6;
  if (value.usdRate !== undefined && !validRate(value.usdRate)) return false;
  if (value.branchUsdRates !== undefined && (!isRecord(value.branchUsdRates) ||
    !Object.entries(value.branchUsdRates).every(([branchId, rate]) => /^[0-9a-f-]{36}$/i.test(branchId) && validRate(rate)))) return false;
  if (value.terminatedPaidBySettlement !== undefined && typeof value.terminatedPaidBySettlement !== 'boolean') return false;
  if (value.approvalChain !== undefined && typeof value.approvalChain !== 'boolean') return false;
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
    'lateMonthlyAllowanceMinutes', 'overtimeMinimumMinutes', 'duplicatePunchWindowMinutes', 'markAbsentWithoutPunch', 'lateDayTiers',
  ])) return false;
  const minutes = (item: unknown, max: number) => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= max;
  const tiers = value.lateDayTiers;
  if (tiers !== undefined && !(Array.isArray(tiers) && tiers.length <= 10 && tiers.every((tier) => isRecord(tier) &&
    hasOnlyKeys(tier, ['minutes', 'days']) && Number.isInteger(tier.minutes) && Number(tier.minutes) >= 1 && Number(tier.minutes) <= 1440 &&
    typeof tier.days === 'number' && Number.isFinite(tier.days) && tier.days > 0 && tier.days <= 3) &&
    new Set(tiers.map((tier) => (tier as Record<string, unknown>).minutes)).size === tiers.length)) return false;
  return minutes(value.lateMonthlyAllowanceMinutes, 6000) &&
    minutes(value.overtimeMinimumMinutes, 600) &&
    minutes(value.duplicatePunchWindowMinutes, 60) &&
    typeof value.markAbsentWithoutPunch === 'boolean';
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateSecurity(value: unknown): boolean {
  if (value === undefined) return true;
  return isRecord(value) && hasOnlyKeys(value, [
    'idleMinutes', 'askLocationOnLogin', 'workdayStart', 'workdayEnd', 'failedLoginAlertThreshold', 'exportAlertThreshold',
    'autoBlockMinutes', 'wafEnabled', 'requestsPerMinute',
  ]) &&
    (value.autoBlockMinutes === undefined || (Number.isInteger(value.autoBlockMinutes) && Number(value.autoBlockMinutes) >= 0 && Number(value.autoBlockMinutes) <= 10080)) &&
    (value.wafEnabled === undefined || typeof value.wafEnabled === 'boolean') &&
    (value.requestsPerMinute === undefined || (Number.isInteger(value.requestsPerMinute) && Number(value.requestsPerMinute) >= 60 && Number(value.requestsPerMinute) <= 10000)) &&
    Number.isInteger(value.idleMinutes) && Number(value.idleMinutes) >= 5 && Number(value.idleMinutes) <= 480 &&
    typeof value.askLocationOnLogin === 'boolean' &&
    typeof value.workdayStart === 'string' && CLOCK.test(value.workdayStart) &&
    typeof value.workdayEnd === 'string' && CLOCK.test(value.workdayEnd) &&
    Number.isInteger(value.failedLoginAlertThreshold) && Number(value.failedLoginAlertThreshold) >= 3 && Number(value.failedLoginAlertThreshold) <= 100 &&
    Number.isInteger(value.exportAlertThreshold) && Number(value.exportAlertThreshold) >= 3 && Number(value.exportAlertThreshold) <= 500;
}

function validateInterface(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, ['hiddenApps', 'brands', 'moduleManagers', 'texts', 'appOrder'])) return false;
  if (value.appOrder !== undefined && !(Array.isArray(value.appOrder) && value.appOrder.length <= 60 &&
    value.appOrder.every((app) => typeof app === 'string' && /^[a-z-]{2,30}$/.test(app)))) return false;
  const texts = value.texts;
  if (texts !== undefined && !(isRecord(texts) && Object.keys(texts).length <= 400 &&
    Object.entries(texts).every(([key, text]) => key.length >= 1 && key.length <= 120 && isRecord(text) && hasOnlyKeys(text, ['ar', 'en']) &&
      isText(text.ar, 300) && (text.en === undefined || isText(text.en, 300))))) return false;
  const managers = value.moduleManagers;
  if (managers !== undefined && !(isRecord(managers) && Object.keys(managers).length <= 50 &&
    Object.entries(managers).every(([app, ids]) => /^[a-z-]{2,30}$/.test(app) && Array.isArray(ids) && ids.length <= 10 &&
      ids.every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))))) return false;
  const apps = value.hiddenApps;
  const brands = value.brands;
  return Array.isArray(apps) && apps.length <= 50 && apps.every((app) => typeof app === 'string' && /^[a-z-]{2,30}$/.test(app)) &&
    Array.isArray(brands) && brands.length >= 0 && brands.length <= 30 && brands.every((brand) => isRecord(brand) &&
      hasOnlyKeys(brand, ['id', 'name', 'logoKey']) &&
      typeof brand.id === 'string' && /^[a-z0-9-]{2,30}$/.test(brand.id) &&
      isText(brand.name, 40) && brand.name.trim().length > 0 &&
      (brand.logoKey === null || (typeof brand.logoKey === 'string' && /^brands\/[0-9a-f-]{36}\.(png|jpg|webp)$/.test(brand.logoKey)))) &&
    new Set(brands.map((brand) => (brand as Record<string, unknown>).id)).size === brands.length;
}

const DOC = /^[a-z_]{2,30}$/;
function validateSteps(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1 && value.length <= 6 && value.every((step) => isRecord(step) &&
    hasOnlyKeys(step, ['type', 'role', 'userId']) &&
    (step.type === 'manager' || (step.type === 'role' && isUserRole(step.role)) ||
      (step.type === 'user' && typeof step.userId === 'string' && /^[0-9a-f-]{36}$/i.test(step.userId))));
}

function validateHr(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, ['documentRules', 'expenseSteps', 'expenseCategories', 'ai'])) return false;
  const rules = value.documentRules;
  if (rules !== undefined && !(isRecord(rules) && hasOnlyKeys(rules, ['local', 'foreign', 'exempt', 'priority']) &&
    ['local', 'foreign'].every((key) => Array.isArray(rules[key]) && (rules[key] as unknown[]).length <= 20 &&
      (rules[key] as unknown[]).every((type) => typeof type === 'string' && DOC.test(type))) &&
    Array.isArray(rules.exempt) && rules.exempt.length <= 2000 && rules.exempt.every((item) => isRecord(item) &&
      hasOnlyKeys(item, ['employeeId', 'docType']) && typeof item.employeeId === 'string' && /^[0-9a-f-]{36}$/i.test(item.employeeId) &&
      typeof item.docType === 'string' && DOC.test(item.docType)) &&
    Array.isArray(rules.priority) && rules.priority.length <= 2000 &&
    rules.priority.every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)))) return false;
  if (value.expenseSteps !== undefined && !validateSteps(value.expenseSteps)) return false;
  if (value.expenseCategories !== undefined && !(Array.isArray(value.expenseCategories) && value.expenseCategories.length >= 1 &&
    value.expenseCategories.length <= 40 && value.expenseCategories.every((item) => isText(item, 40) && item.trim().length > 0))) return false;
  const ai = value.ai;
  return ai === undefined || (isRecord(ai) && hasOnlyKeys(ai, ['enabled', 'model']) && typeof ai.enabled === 'boolean' &&
    typeof ai.model === 'string' && /^[a-z0-9.-]{3,60}$/.test(ai.model));
}

const PORTAL_SWITCHES = Object.keys(DEFAULT_PORTAL).filter((key) => key !== 'welcome');

/** The owner's choices for the employee portal: on/off switches and a short note. */
function validatePortal(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'welcome') { if (typeof item !== 'string' || item.length > 500) return false; continue; }
    if (!PORTAL_SWITCHES.includes(key) || typeof item !== 'boolean') return false;
  }
  return true;
}

function validateSettings(value: unknown): value is SystemSettings {
  if (
    !isRecord(value) ||
    !isRecord(value.company) ||
    !isRecord(value.roles) ||
    !hasOnlyKeys(value, [
      'company', 'leaveTypes', 'approvalSteps', 'roles', 'employeeFields', 'leaveRules', 'payrollRules',
      'attendanceRules', 'knownPermissions', 'security', 'ui', 'hr', 'portal',
    ]) ||
    !validateHr(value.hr) ||
    !validatePortal(value.portal) ||
    !validateSecurity(value.security) ||
    !validateInterface(value.ui) ||
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
  /**
   * Everyone signed in needs the settings the screens run on (leave types,
   * texts, the portal switches, their own role's permissions). The guard's
   * thresholds and other roles' permissions are for the owner and for those
   * who manage accounts.
   */
  static async get(req: Request, res: Response): Promise<void> {
    const record = await SystemSetting.findByPk(GLOBAL_SETTINGS_ID);
    const settings = normalizeSystemSettings(record?.value);
    if (req.user?.role === 'super_admin') {
      res.json({ data: settings });
      return;
    }
    const managesAccounts = (await userPermissions(req)).includes('users.manage');
    const own = req.user!.role;
    res.json({
      data: {
        ...settings,
        security: { idleMinutes: settings.security.idleMinutes, askLocationOnLogin: settings.security.askLocationOnLogin },
        roles: managesAccounts ? settings.roles : Object.fromEntries(Object.entries(settings.roles).map(([role, entry]) =>
          [role, role === own ? entry : { ...entry, permissions: [] }])),
      },
    });
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
