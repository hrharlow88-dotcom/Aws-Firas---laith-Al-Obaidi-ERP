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
