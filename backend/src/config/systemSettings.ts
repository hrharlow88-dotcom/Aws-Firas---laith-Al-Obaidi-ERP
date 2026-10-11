import { ROLES, UserRole } from '../types';

export const PERMISSIONS = [
  'branches.manage',
  'employees.create',
  'employees.update',
  'users.manage',
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
}

export const DEFAULT_ROLE_SETTINGS: Record<UserRole, RoleSetting> = {
  super_admin: { label: 'مدير النظام', permissions: [...PERMISSIONS] },
  hr_manager: { label: 'مدير الموارد البشرية', permissions: ['branches.manage', 'employees.create', 'employees.update'] },
  hr_staff: { label: 'موظف موارد بشرية', permissions: ['employees.create', 'employees.update'] },
  finance: { label: 'المالية', permissions: [] },
  branch_manager: { label: 'مدير فرع', permissions: ['employees.update'] },
  viewer: { label: 'مشاهدة فقط', permissions: [] },
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
};

export function permissionsFor(role: UserRole, settings: SystemSettings): Permission[] {
  return role === 'super_admin' ? [...PERMISSIONS] : settings.roles[role].permissions;
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
