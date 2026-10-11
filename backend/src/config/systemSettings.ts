import { ROLES, UserRole } from '../types';

export const PERMISSIONS = [
  'branches.manage',
  'employees.create',
  'employees.update',
  'users.manage',
  'leaves.view',
  'leaves.request',
  'leaves.approve',
  'leaves.manage_balances',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface CompanySettings {
  displayName: string;
  legalName: string;
  phone: string;
  email: string;
  address: string;
  currency: string;
  timeZone: string;
}

export interface LeaveTypeSetting {
  id: string;
  name: string;
  unit: 'days' | 'hours';
  paid: boolean;
  active: boolean;
  annualEntitlement: number | null;
  carryForwardLimit: number | null;
  serviceEntitlements?: Array<{ minimumYears: number; days: number }>;
  dayCountBasis?: 'working' | 'calendar';
  requiresMedicalCertificate?: boolean;
  deductsBalance?: boolean;
}

export interface ApprovalStepSetting {
  id: string;
  role: UserRole;
}

export interface EmployeeFieldSetting {
  id: string;
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select';
  required: boolean;
  enabled: boolean;
  options: string[];
}

export type PayrollComponentCategory = 'earning' | 'deduction';
export type PayrollCalculation = 'manual' | 'percentage_of_gross' | 'percentage_of_basic' | 'per_day';

export interface PayrollComponentSetting {
  id: string;
  name: string;
  category: PayrollComponentCategory;
  calculation: PayrollCalculation;
  rate: number;
  active: boolean;
  statutory: boolean;
  legalApproved: boolean;
}

export interface PayrollRulesSetting {
  baseCurrency: string;
  monthlyDivisor: number;
  roundingDigits: number;
  components: PayrollComponentSetting[];
}

export interface RoleSetting {
  label: string;
  permissions: Permission[];
}

export interface SystemSettings {
  company: CompanySettings;
  leaveTypes: LeaveTypeSetting[];
  approvalSteps: ApprovalStepSetting[];
  roles: Record<UserRole, RoleSetting>;
  employeeFields: EmployeeFieldSetting[];
  payrollRules: PayrollRulesSetting;
  leaveRules: {
    workingDays: number[];
    officialHolidays: string[];
    maxHoursPerRequest: number;
    hourlyMonthlyQuota: number;
    hourlyMonthlyUsageLimit: number;
    lowBalanceThreshold: number;
  };
}

export const DEFAULT_ROLE_SETTINGS: Record<UserRole, RoleSetting> = {
  super_admin: { label: 'مدير النظام', permissions: [...PERMISSIONS] },
  hr_manager: { label: 'مدير الموارد البشرية', permissions: [...PERMISSIONS.filter((permission) => permission !== 'users.manage'), 'leaves.view', 'leaves.request', 'leaves.approve', 'leaves.manage_balances'] },
  hr_staff: { label: 'موظف موارد بشرية', permissions: ['employees.create', 'employees.update', 'leaves.view', 'leaves.request'] },
  finance: { label: 'المالية', permissions: [] },
  branch_manager: { label: 'مدير فرع', permissions: ['employees.update', 'leaves.view', 'leaves.request', 'leaves.approve'] },
  viewer: { label: 'مشاهدة فقط', permissions: ['leaves.view'] },
};

export const DEFAULT_PAYROLL_RULES: PayrollRulesSetting = {
  baseCurrency: 'IQD',
  monthlyDivisor: 30,
  roundingDigits: 2,
  components: [
    { id: '30000000-0000-4000-8000-000000000001', name: 'الراتب الأساسي', category: 'earning', calculation: 'percentage_of_gross', rate: 50, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000002', name: 'بدل الطعام', category: 'earning', calculation: 'percentage_of_gross', rate: 25, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000003', name: 'بدل تحسين المعيشة', category: 'earning', calculation: 'percentage_of_gross', rate: 25, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000004', name: 'العمولة', category: 'earning', calculation: 'manual', rate: 0, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000005', name: 'المكافأة', category: 'earning', calculation: 'manual', rate: 0, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000006', name: 'الزيادة والفروقات', category: 'earning', calculation: 'manual', rate: 0, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000007', name: 'خصم الغياب والتأخير', category: 'deduction', calculation: 'per_day', rate: 1, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000008', name: 'غرامات المركبات', category: 'deduction', calculation: 'manual', rate: 0, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000009', name: 'استقطاع آخر', category: 'deduction', calculation: 'manual', rate: 0, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000010', name: 'السلف', category: 'deduction', calculation: 'manual', rate: 0, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000011', name: 'الضمان الاجتماعي', category: 'deduction', calculation: 'percentage_of_basic', rate: 5, active: false, statutory: true, legalApproved: false },
  ],
};

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  company: {
    displayName: 'مجموعة ليث العبيدي للسيارات',
    legalName: '',
    phone: '',
    email: '',
    address: '',
    currency: '',
    timeZone: 'Asia/Baghdad',
  },
  leaveTypes: [],
  approvalSteps: [],
  roles: DEFAULT_ROLE_SETTINGS,
  employeeFields: [],
  payrollRules: DEFAULT_PAYROLL_RULES,
  leaveRules: {
    workingDays: [0, 1, 2, 3, 4, 6],
    officialHolidays: [],
    maxHoursPerRequest: 3,
    hourlyMonthlyQuota: 6,
    hourlyMonthlyUsageLimit: 2,
    lowBalanceThreshold: 5,
  },
};

export function normalizeSystemSettings(value: SystemSettings | null | undefined): SystemSettings {
  if (!value) return DEFAULT_SYSTEM_SETTINGS;
  return {
    ...DEFAULT_SYSTEM_SETTINGS,
    ...value,
    company: { ...DEFAULT_SYSTEM_SETTINGS.company, ...value.company },
    roles: Object.fromEntries(
      ROLES.map((role) => {
        const saved = value.roles?.[role];
        const base = DEFAULT_ROLE_SETTINGS[role];
        const savedPermissions = saved?.permissions || [];
        const hasCurrentLeavePermissions = savedPermissions.some((permission) => permission.startsWith('leaves.'));
        return [role, {
          ...base,
          ...saved,
          permissions: hasCurrentLeavePermissions
            ? savedPermissions
            : [...new Set([...savedPermissions, ...base.permissions.filter((permission) => permission.startsWith('leaves.'))])],
        }];
      }),
    ) as Record<UserRole, RoleSetting>,
    payrollRules: {
      ...DEFAULT_PAYROLL_RULES,
      ...value.payrollRules,
      components: value.payrollRules?.components ?? DEFAULT_PAYROLL_RULES.components,
    },
    leaveRules: {
      workingDays: value.leaveRules?.workingDays ?? DEFAULT_SYSTEM_SETTINGS.leaveRules.workingDays,
      officialHolidays: value.leaveRules?.officialHolidays ?? DEFAULT_SYSTEM_SETTINGS.leaveRules.officialHolidays,
      maxHoursPerRequest: value.leaveRules?.maxHoursPerRequest ?? 3,
      hourlyMonthlyQuota: value.leaveRules?.hourlyMonthlyQuota ?? DEFAULT_SYSTEM_SETTINGS.leaveRules.hourlyMonthlyQuota,
      hourlyMonthlyUsageLimit: value.leaveRules?.hourlyMonthlyUsageLimit ?? DEFAULT_SYSTEM_SETTINGS.leaveRules.hourlyMonthlyUsageLimit,
      lowBalanceThreshold: value.leaveRules?.lowBalanceThreshold ?? DEFAULT_SYSTEM_SETTINGS.leaveRules.lowBalanceThreshold,
    },
  };
}

export function permissionsFor(role: UserRole, settings: SystemSettings): Permission[] {
  return role === 'super_admin' ? [...PERMISSIONS] : settings.roles[role].permissions;
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
