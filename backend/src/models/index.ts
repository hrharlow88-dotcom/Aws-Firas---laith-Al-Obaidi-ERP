import {
  DataTypes,
  Model,
  Optional,
  Sequelize,
} from 'sequelize';
import { ROLES, UserRole } from '../types';
import type { SystemSettings } from '../config/systemSettings';
import { connectionOptions } from '../db/connection';

export const sequelize = new Sequelize(connectionOptions());

interface BranchAttributes {
  id: string;
  code: string;
  name: string;
  city: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
  companyId: string | null;
  governorateId: string | null;
}

type BranchCreationAttributes = Optional<BranchAttributes, 'id' | 'address' | 'phone' | 'isActive' | 'companyId' | 'governorateId'>;

export class Branch extends Model<BranchAttributes, BranchCreationAttributes> implements BranchAttributes {
  declare id: string;
  declare code: string;
  declare name: string;
  declare city: string;
  declare address: string | null;
  declare phone: string | null;
  declare isActive: boolean;
  declare companyId: string | null;
  declare governorateId: string | null;
}

Branch.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    code: { type: DataTypes.STRING(24), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    city: { type: DataTypes.STRING(80), allowNull: false },
    address: { type: DataTypes.STRING(240), allowNull: true },
    phone: { type: DataTypes.STRING(40), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    companyId: { type: DataTypes.UUID, allowNull: true, field: 'company_id' },
    governorateId: { type: DataTypes.UUID, allowNull: true, field: 'governorate_id' },
  },
  { sequelize, tableName: 'branches', underscored: true },
);

interface UserAttributes {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  branchId: string | null;
  isActive: boolean;
  tokenVersion: number;
  employeeId: string | null;
  failedLogins: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  lastSeenAt: Date | null;
  isDemo: boolean;
  demoExpiresAt: Date | null;
  appAccess: string[] | null;
  notifyEmail: boolean;
  personalEmail: string | null;
}

type UserCreationAttributes = Optional<UserAttributes,
  'id' | 'branchId' | 'isActive' | 'tokenVersion' | 'employeeId' | 'failedLogins' | 'lockedUntil' | 'lastLoginAt' | 'lastSeenAt' | 'isDemo' | 'demoExpiresAt' | 'appAccess' | 'notifyEmail' | 'personalEmail'>;

export class User extends Model<UserAttributes, UserCreationAttributes> implements UserAttributes {
  declare id: string;
  declare name: string;
  declare email: string;
  declare passwordHash: string;
  declare role: UserRole;
  declare branchId: string | null;
  declare isActive: boolean;
  declare tokenVersion: number;
  declare employeeId: string | null;
  declare failedLogins: number;
  declare lockedUntil: Date | null;
  declare lastLoginAt: Date | null;
  declare lastSeenAt: Date | null;
  declare isDemo: boolean;
  declare demoExpiresAt: Date | null;
  declare appAccess: string[] | null;
  declare notifyEmail: boolean;
  declare personalEmail: string | null;
}

User.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    email: { type: DataTypes.STRING(254), allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING(100), allowNull: false, field: 'password_hash' },
    role: { type: DataTypes.ENUM(...ROLES), allowNull: false, defaultValue: 'viewer' },
    branchId: { type: DataTypes.UUID, allowNull: true, field: 'branch_id' },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    tokenVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'token_version' },
    employeeId: { type: DataTypes.UUID, allowNull: true, field: 'employee_id' },
    failedLogins: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'failed_logins' },
    lockedUntil: { type: DataTypes.DATE, allowNull: true, field: 'locked_until' },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true, field: 'last_login_at' },
    lastSeenAt: { type: DataTypes.DATE, allowNull: true, field: 'last_seen_at' },
    isDemo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_demo' },
    demoExpiresAt: { type: DataTypes.DATE, allowNull: true, field: 'demo_expires_at' },
    appAccess: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: true, field: 'app_access' },
    notifyEmail: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'notify_email' },
    personalEmail: { type: DataTypes.STRING(254), allowNull: true, field: 'personal_email' },
  },
  { sequelize, tableName: 'users', underscored: true },
);

export interface EmployeeAttributes {
  id: string;
  employeeNo: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  branchId: string;
  department: string;
  position: string;
  hireDate: string;
  employmentStatus: 'active' | 'inactive' | 'on_leave' | 'suspended';
  customFields: Record<string, string | number>;
  departmentId: string | null;
  jobTitleId: string | null;
  managerId: string | null;
  employmentType: EmploymentType;
  attendancePin: string | null;
  cardToken: string | null;
  cardIssuedAt: Date | null;
  photoDocumentId: string | null;
  terminationDate: string | null;
  shiftId: string | null;
}

export const EMPLOYMENT_TYPES = ['permanent', 'fixed_term', 'probation', 'daily', 'part_time', 'contractor'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

type EmployeeCreationAttributes = Optional<EmployeeAttributes,
  'id' | 'email' | 'phone' | 'employmentStatus' | 'customFields' | 'departmentId' | 'jobTitleId' | 'managerId' |
  'employmentType' | 'attendancePin' | 'cardToken' | 'cardIssuedAt' | 'photoDocumentId' | 'terminationDate' | 'shiftId'>;

export class Employee extends Model<EmployeeAttributes, EmployeeCreationAttributes> implements EmployeeAttributes {
  declare id: string;
  declare employeeNo: string;
  declare fullName: string;
  declare email: string | null;
  declare phone: string | null;
  declare branchId: string;
  declare department: string;
  declare position: string;
  declare hireDate: string;
  declare employmentStatus: 'active' | 'inactive' | 'on_leave' | 'suspended';
  declare customFields: Record<string, string | number>;
  declare departmentId: string | null;
  declare jobTitleId: string | null;
  declare managerId: string | null;
  declare employmentType: EmploymentType;
  declare attendancePin: string | null;
  declare cardToken: string | null;
  declare cardIssuedAt: Date | null;
  declare photoDocumentId: string | null;
  declare terminationDate: string | null;
  declare shiftId: string | null;
}

Employee.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    employeeNo: { type: DataTypes.STRING(40), allowNull: false, unique: true, field: 'employee_no' },
    fullName: { type: DataTypes.STRING(180), allowNull: false, field: 'full_name' },
    email: { type: DataTypes.STRING(254), allowNull: true },
    phone: { type: DataTypes.STRING(40), allowNull: true },
    branchId: { type: DataTypes.UUID, allowNull: false, field: 'branch_id' },
    department: { type: DataTypes.STRING(120), allowNull: false },
    position: { type: DataTypes.STRING(120), allowNull: false },
    hireDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'hire_date' },
    employmentStatus: {
      type: DataTypes.ENUM('active', 'inactive', 'on_leave', 'suspended'),
      allowNull: false,
      defaultValue: 'active',
      field: 'employment_status',
    },
    customFields: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'custom_fields' },
    departmentId: { type: DataTypes.UUID, allowNull: true, field: 'department_id' },
    jobTitleId: { type: DataTypes.UUID, allowNull: true, field: 'job_title_id' },
    managerId: { type: DataTypes.UUID, allowNull: true, field: 'manager_id' },
    employmentType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'permanent', field: 'employment_type' },
    attendancePin: { type: DataTypes.STRING(40), allowNull: true, field: 'attendance_pin' },
    cardToken: { type: DataTypes.STRING(64), allowNull: true, field: 'card_token' },
    cardIssuedAt: { type: DataTypes.DATE, allowNull: true, field: 'card_issued_at' },
    photoDocumentId: { type: DataTypes.UUID, allowNull: true, field: 'photo_document_id' },
    terminationDate: { type: DataTypes.DATEONLY, allowNull: true, field: 'termination_date' },
    shiftId: { type: DataTypes.UUID, allowNull: true, field: 'shift_id' },
  },
  {
    sequelize,
    tableName: 'employees',
    underscored: true,
    // The card token is a bearer secret for the public verification link; it is
    // only read explicitly when a card is printed.
    defaultScope: { attributes: { exclude: ['cardToken'] } },
  },
);

interface AuditLogAttributes {
  id: string;
  userId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  createdAt?: Date;
}

type AuditLogCreationAttributes = Optional<AuditLogAttributes, 'id' | 'entityId' | 'details' | 'ip' | 'createdAt'>;

export class AuditLog extends Model<AuditLogAttributes, AuditLogCreationAttributes> implements AuditLogAttributes {
  declare id: string;
  declare userId: string;
  declare action: string;
  declare entityType: string;
  declare entityId: string | null;
  declare details: Record<string, unknown> | null;
  declare ip: string | null;
  declare createdAt: Date;
}

AuditLog.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
    action: { type: DataTypes.STRING(80), allowNull: false },
    entityType: { type: DataTypes.STRING(80), allowNull: false, field: 'entity_type' },
    entityId: { type: DataTypes.UUID, allowNull: true, field: 'entity_id' },
    details: { type: DataTypes.JSONB, allowNull: true },
    ip: { type: DataTypes.STRING(64), allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'created_at' },
  },
  { sequelize, tableName: 'audit_logs', underscored: true, updatedAt: false },
);

interface SystemSettingAttributes {
  id: string;
  value: SystemSettings;
  updatedBy: string;
}

export class SystemSetting extends Model<SystemSettingAttributes> implements SystemSettingAttributes {
  declare id: string;
  declare value: SystemSettings;
  declare updatedBy: string;
}

SystemSetting.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    value: { type: DataTypes.JSONB, allowNull: false },
    updatedBy: { type: DataTypes.UUID, allowNull: false, field: 'updated_by' },
  },
  { sequelize, tableName: 'system_settings', underscored: true, timestamps: true, createdAt: false },
);

export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

interface LeaveRequestAttributes {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  startsOn: string;
  endsOn: string;
  startTime: string | null;
  endTime: string | null;
  quantity: string;
  reason: string;
  substituteName: string | null;
  medicalCertificateReference: string | null;
  status: LeaveRequestStatus;
  approvalRoles: UserRole[];
  approvalStepIndex: number;
  submittedBy: string;
  decidedAt: Date | null;
}

type LeaveRequestCreationAttributes = Optional<LeaveRequestAttributes, 'id' | 'startTime' | 'endTime' | 'substituteName' | 'medicalCertificateReference' | 'status' | 'approvalStepIndex' | 'decidedAt'>;

export class LeaveRequest extends Model<LeaveRequestAttributes, LeaveRequestCreationAttributes> implements LeaveRequestAttributes {
  declare id: string;
  declare employeeId: string;
  declare leaveTypeId: string;
  declare startsOn: string;
  declare endsOn: string;
  declare startTime: string | null;
  declare endTime: string | null;
  declare quantity: string;
  declare reason: string;
  declare substituteName: string | null;
  declare medicalCertificateReference: string | null;
  declare status: LeaveRequestStatus;
  declare approvalRoles: UserRole[];
  declare approvalStepIndex: number;
  declare submittedBy: string;
  declare decidedAt: Date | null;
}

LeaveRequest.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    employeeId: { type: DataTypes.UUID, allowNull: false, field: 'employee_id' },
    leaveTypeId: { type: DataTypes.UUID, allowNull: false, field: 'leave_type_id' },
    startsOn: { type: DataTypes.DATEONLY, allowNull: false, field: 'starts_on' },
    endsOn: { type: DataTypes.DATEONLY, allowNull: false, field: 'ends_on' },
    startTime: { type: DataTypes.TIME, allowNull: true, field: 'start_time' },
    endTime: { type: DataTypes.TIME, allowNull: true, field: 'end_time' },
    quantity: { type: DataTypes.DECIMAL(8, 2), allowNull: false },
    reason: { type: DataTypes.STRING(1000), allowNull: false },
    substituteName: { type: DataTypes.STRING(180), allowNull: true, field: 'substitute_name' },
    medicalCertificateReference: { type: DataTypes.STRING(180), allowNull: true, field: 'medical_certificate_reference' },
    status: { type: DataTypes.ENUM('pending', 'approved', 'rejected', 'cancelled'), allowNull: false, defaultValue: 'pending' },
    approvalRoles: { type: DataTypes.JSONB, allowNull: false, field: 'approval_roles' },
    approvalStepIndex: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'approval_step_index' },
    submittedBy: { type: DataTypes.UUID, allowNull: false, field: 'submitted_by' },
    decidedAt: { type: DataTypes.DATE, allowNull: true, field: 'decided_at' },
  },
  { sequelize, tableName: 'leave_requests', underscored: true },
);

interface LeaveLedgerEntryAttributes {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  quantity: string;
  entryType: 'opening' | 'adjustment' | 'taken' | 'reversal' | 'accrual';
  accrualPeriod?: string | null;
  requestId: string | null;
  reason: string;
  createdBy: string;
}

type LeaveLedgerEntryCreationAttributes = Optional<LeaveLedgerEntryAttributes, 'id' | 'requestId' | 'accrualPeriod'>;

export class LeaveLedgerEntry extends Model<LeaveLedgerEntryAttributes, LeaveLedgerEntryCreationAttributes> implements LeaveLedgerEntryAttributes {
  declare id: string;
  declare employeeId: string;
  declare leaveTypeId: string;
  declare quantity: string;
  declare entryType: LeaveLedgerEntryAttributes['entryType'];
  declare accrualPeriod: string | null;
  declare requestId: string | null;
  declare reason: string;
  declare createdBy: string;
}

LeaveLedgerEntry.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    employeeId: { type: DataTypes.UUID, allowNull: false, field: 'employee_id' },
    leaveTypeId: { type: DataTypes.UUID, allowNull: false, field: 'leave_type_id' },
    quantity: { type: DataTypes.DECIMAL(8, 2), allowNull: false },
    entryType: { type: DataTypes.ENUM('opening', 'adjustment', 'taken', 'reversal', 'accrual'), allowNull: false, field: 'entry_type' },
    accrualPeriod: { type: DataTypes.CHAR(7), allowNull: true, field: 'accrual_period' },
    requestId: { type: DataTypes.UUID, allowNull: true, field: 'request_id' },
    reason: { type: DataTypes.STRING(1000), allowNull: false },
    createdBy: { type: DataTypes.UUID, allowNull: false, field: 'created_by' },
  },
  { sequelize, tableName: 'leave_ledger_entries', underscored: true, updatedAt: false },
);

interface LeaveApprovalAttributes {
  id: string;
  requestId: string;
  stepIndex: number;
  role: UserRole;
  userId: string;
  action: 'approved' | 'rejected';
  note: string | null;
}

type LeaveApprovalCreationAttributes = Optional<LeaveApprovalAttributes, 'id' | 'note'>;

export class LeaveApproval extends Model<LeaveApprovalAttributes, LeaveApprovalCreationAttributes> implements LeaveApprovalAttributes {
  declare id: string;
  declare requestId: string;
  declare stepIndex: number;
  declare role: UserRole;
  declare userId: string;
  declare action: 'approved' | 'rejected';
  declare note: string | null;
}

LeaveApproval.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    requestId: { type: DataTypes.UUID, allowNull: false, field: 'request_id' },
    stepIndex: { type: DataTypes.INTEGER, allowNull: false, field: 'step_index' },
    role: { type: DataTypes.ENUM(...ROLES), allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
    action: { type: DataTypes.ENUM('approved', 'rejected'), allowNull: false },
    note: { type: DataTypes.STRING(1000), allowNull: true },
  },
  { sequelize, tableName: 'leave_approvals', underscored: true, updatedAt: false },
);

Branch.hasMany(Employee, { foreignKey: 'branchId', as: 'employees' });
Employee.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
Branch.hasMany(User, { foreignKey: 'branchId', as: 'users' });
User.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
User.hasMany(AuditLog, { foreignKey: 'userId', as: 'auditLogs' });
AuditLog.belongsTo(User, { foreignKey: 'userId', as: 'user' });
Employee.hasMany(LeaveRequest, { foreignKey: 'employeeId', as: 'leaveRequests' });
LeaveRequest.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
LeaveRequest.hasMany(LeaveApproval, { foreignKey: 'requestId', as: 'approvals' });
LeaveApproval.belongsTo(User, { foreignKey: 'userId', as: 'approver' });
LeaveLedgerEntry.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
