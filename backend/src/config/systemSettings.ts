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
  'org.manage',
  'employees.view_profile',
  'employees.manage_profile',
  'compensation.view',
  'compensation.manage',
  'attendance.view',
  'attendance.manage',
  'payroll.view',
  'payroll.prepare',
  'payroll.approve',
  'finance.view',
  'finance.manage',
  'finance.post',
  'audit.view',
  'integrations.manage',
  // Own record only: profile summary, own payslips, own leave balances.
  'self.service',
] as const;

/** Permissions that existed before settings started recording knownPermissions. */
const LEGACY_BASE_PERMISSIONS = ['branches.manage', 'employees.create', 'employees.update', 'users.manage'];
const LEAVE_PERMISSIONS = ['leaves.view', 'leaves.request', 'leaves.approve', 'leaves.manage_balances'];

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
export type PayrollCalculation =
  | 'manual'
  | 'percentage_of_gross'
  | 'percentage_of_basic'
  | 'per_day'
  | 'per_late_minute'
  | 'per_overtime_hour'
  | 'percentage_of_ss_base'
  | 'loan_installments';

export const PAYROLL_CALCULATIONS: PayrollCalculation[] = [
  'manual', 'percentage_of_gross', 'percentage_of_basic', 'per_day', 'per_late_minute', 'per_overtime_hour',
  'percentage_of_ss_base', 'loan_installments',
];

/** The component treated as the basic salary when none is flagged with isBasic. */
export const DEFAULT_BASIC_COMPONENT_ID = '30000000-0000-4000-8000-000000000001';

export interface PayrollComponentSetting {
  id: string;
  name: string;
  category: PayrollComponentCategory;
  calculation: PayrollCalculation;
  rate: number;
  active: boolean;
  statutory: boolean;
  legalApproved: boolean;
  isBasic?: boolean;
  /**
   * Fixed amounts from the salary record follow the days paid in the month
   * unless this is false (a monthly raise is paid in full, for example).
   */
  prorate?: boolean;
  /** percentage_of_ss_base: the declared salary is clamped to this range first. */
  minBase?: number;
  maxBase?: number;
  /** Rounding for this component only (social security is rounded to whole dinars). */
  roundingDigits?: number;
}

export interface AttendanceRulesSetting {
  /** Late minutes forgiven each month before per-minute deductions apply. */
  lateMonthlyAllowanceMinutes: number;
  /** Overtime shorter than this on a day is ignored. */
  overtimeMinimumMinutes: number;
  /** Two punches closer than this are treated as one (double tap on the device). */
  duplicatePunchWindowMinutes: number;
  /** A working day without any punch or approved leave counts as absence. */
  markAbsentWithoutPunch: boolean;
}

export interface PayrollRulesSetting {
  baseCurrency: string;
  monthlyDivisor: number;
  roundingDigits: number;
  /**
   * When true, an employee who leaves during the month is paid through the
   * final settlement and not through the monthly run.
   */
  terminatedPaidBySettlement?: boolean;
  /** Dinars per US dollar, used when a loan and the salary are in different currencies. */
  usdRate?: number;
  /** Branch-specific dinar rate (branch id → rate), e.g. Erbil buys dollars at another rate. */
  branchUsdRates?: Record<string, number>;
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
  attendanceRules: AttendanceRulesSetting;
  knownPermissions: Permission[];
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
  hr_manager: {
    label: 'مدير الموارد البشرية',
    permissions: [
      'branches.manage', 'employees.create', 'employees.update',
      ...LEAVE_PERMISSIONS,
      'org.manage', 'employees.view_profile', 'employees.manage_profile',
      'compensation.view', 'compensation.manage',
      'attendance.view', 'attendance.manage',
      'payroll.view', 'payroll.prepare', 'audit.view', 'self.service',
    ] as Permission[],
  },
  hr_staff: {
    label: 'موظف موارد بشرية',
    permissions: [
      'employees.create', 'employees.update', 'leaves.view', 'leaves.request',
      'employees.view_profile', 'employees.manage_profile', 'attendance.view', 'attendance.manage', 'self.service',
    ] as Permission[],
  },
  payroll_officer: {
    label: 'مسؤول الرواتب',
    permissions: [
      'compensation.view', 'attendance.view', 'leaves.view', 'payroll.view', 'payroll.prepare', 'self.service',
    ] as Permission[],
  },
  finance: {
    label: 'المالية',
    permissions: [
      'compensation.view', 'payroll.view', 'payroll.approve',
      'finance.view', 'finance.manage', 'finance.post', 'audit.view', 'self.service',
    ] as Permission[],
  },
  branch_manager: {
    label: 'مدير فرع',
    permissions: ['employees.update', 'leaves.view', 'leaves.request', 'leaves.approve', 'attendance.view', 'self.service'] as Permission[],
  },
  line_manager: {
    label: 'مدير مباشر',
    permissions: ['leaves.view', 'leaves.request', 'leaves.approve', 'attendance.view', 'self.service'] as Permission[],
  },
  employee: {
    label: 'موظف',
    permissions: ['leaves.view', 'leaves.request', 'self.service'] as Permission[],
  },
  auditor: {
    label: 'تدقيق (قراءة فقط)',
    permissions: [
      'employees.view_profile', 'compensation.view', 'attendance.view', 'leaves.view',
      'payroll.view', 'finance.view', 'audit.view', 'self.service',
    ] as Permission[],
  },
  executive: {
    label: 'الإدارة العليا',
    permissions: [
      'employees.view_profile', 'compensation.view', 'attendance.view', 'leaves.view',
      'payroll.view', 'finance.view', 'audit.view', 'self.service',
    ] as Permission[],
  },
  it_admin: {
    label: 'مدير النظام التقني',
    permissions: ['users.manage', 'integrations.manage', 'self.service'] as Permission[],
  },
  viewer: { label: 'مشاهدة فقط', permissions: ['leaves.view'] },
};

export const DEFAULT_ATTENDANCE_RULES: AttendanceRulesSetting = {
  lateMonthlyAllowanceMinutes: 0,
  overtimeMinimumMinutes: 30,
  duplicatePunchWindowMinutes: 2,
  markAbsentWithoutPunch: true,
};

export const DEFAULT_PAYROLL_RULES: PayrollRulesSetting = {
  baseCurrency: 'IQD',
  monthlyDivisor: 30,
  roundingDigits: 2,
  components: [
    { id: '30000000-0000-4000-8000-000000000001', name: 'الراتب الأساسي', category: 'earning', calculation: 'percentage_of_gross', rate: 50, active: true, statutory: false, legalApproved: false, isBasic: true },
    { id: '30000000-0000-4000-8000-000000000002', name: 'بدل الطعام', category: 'earning', calculation: 'percentage_of_gross', rate: 25, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000003', name: 'بدل تحسين المعيشة', category: 'earning', calculation: 'percentage_of_gross', rate: 25, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000004', name: 'العمولة', category: 'earning', calculation: 'manual', rate: 0, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000005', name: 'المكافأة', category: 'earning', calculation: 'manual', rate: 0, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000006', name: 'الزيادة والفروقات', category: 'earning', calculation: 'manual', rate: 0, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000007', name: 'خصم الغياب والتأخير', category: 'deduction', calculation: 'per_day', rate: 1, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000008', name: 'غرامات المركبات', category: 'deduction', calculation: 'manual', rate: 0, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000009', name: 'استقطاع آخر', category: 'deduction', calculation: 'manual', rate: 0, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000010', name: 'السلف', category: 'deduction', calculation: 'manual', rate: 0, active: true, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000011', name: 'الضمان الاجتماعي', category: 'deduction', calculation: 'percentage_of_ss_base', rate: 5, active: false, statutory: true, legalApproved: false, minBase: 350000, maxBase: 1750000, roundingDigits: 0 },
    { id: '30000000-0000-4000-8000-000000000012', name: 'العمل الإضافي', category: 'earning', calculation: 'per_overtime_hour', rate: 1.5, active: false, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000013', name: 'خصم دقائق التأخير', category: 'deduction', calculation: 'per_late_minute', rate: 1, active: false, statutory: false, legalApproved: false },
    { id: '30000000-0000-4000-8000-000000000014', name: 'الزيادة الشهرية', category: 'earning', calculation: 'manual', rate: 0, active: true, statutory: false, legalApproved: false, prorate: false },
    { id: '30000000-0000-4000-8000-000000000015', name: 'أقساط القروض', category: 'deduction', calculation: 'loan_installments', rate: 0, active: true, statutory: false, legalApproved: false },
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
  attendanceRules: DEFAULT_ATTENDANCE_RULES,
  knownPermissions: [...PERMISSIONS],
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
        if (!saved) return [role, base];
        const savedPermissions = (saved.permissions || [])
          .filter((permission) => (PERMISSIONS as readonly string[]).includes(permission));
        // Permissions the administrator has already seen keep their saved state
        // (granted or deliberately removed). Permissions introduced after the
        // settings were saved start from the role's defaults.
        const known = value.knownPermissions ?? [
          ...LEGACY_BASE_PERMISSIONS,
          ...(savedPermissions.some((permission) => permission.startsWith('leaves.')) ? LEAVE_PERMISSIONS : []),
        ];
        const introduced = base.permissions.filter((permission) => !known.includes(permission));
        return [role, { ...base, ...saved, permissions: [...new Set([...savedPermissions, ...introduced])] }];
      }),
    ) as Record<UserRole, RoleSetting>,
    knownPermissions: [...PERMISSIONS],
    attendanceRules: { ...DEFAULT_ATTENDANCE_RULES, ...value.attendanceRules },
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

export function basicComponentId(rules: PayrollRulesSetting): string | null {
  const flagged = rules.components.find((item) => item.isBasic && item.category === 'earning');
  if (flagged) return flagged.id;
  return rules.components.find((item) => item.id === DEFAULT_BASIC_COMPONENT_ID)?.id ?? null;
}

export function permissionsFor(role: UserRole, settings: SystemSettings): Permission[] {
  return role === 'super_admin' ? [...PERMISSIONS] : settings.roles[role].permissions;
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
