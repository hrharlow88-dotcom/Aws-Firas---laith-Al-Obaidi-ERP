import {
  DataTypes,
  Model,
  Optional,
  Sequelize,
} from 'sequelize';
import { ROLES, UserRole } from '../types';
import type { SystemSettings } from '../config/systemSettings';

export const sequelize = new Sequelize(
  process.env.DB_NAME || 'erp_system',
  process.env.DB_USER || 'erp_app',
  process.env.DB_PASSWORD || '',
  {
    dialect: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    logging: false,
    dialectOptions: process.env.DB_SSL === 'true'
      ? { ssl: { require: true, rejectUnauthorized: true } }
      : undefined,
    pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
  },
);

interface BranchAttributes {
  id: string;
  code: string;
  name: string;
  city: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
}

type BranchCreationAttributes = Optional<BranchAttributes, 'id' | 'address' | 'phone' | 'isActive'>;

export class Branch extends Model<BranchAttributes, BranchCreationAttributes> implements BranchAttributes {
  declare id: string;
  declare code: string;
  declare name: string;
  declare city: string;
  declare address: string | null;
  declare phone: string | null;
  declare isActive: boolean;
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
}

type UserCreationAttributes = Optional<UserAttributes, 'id' | 'branchId' | 'isActive' | 'tokenVersion'>;

export class User extends Model<UserAttributes, UserCreationAttributes> implements UserAttributes {
  declare id: string;
  declare name: string;
  declare email: string;
  declare passwordHash: string;
  declare role: UserRole;
  declare branchId: string | null;
  declare isActive: boolean;
  declare tokenVersion: number;
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
  employmentStatus: 'active' | 'inactive' | 'on_leave';
  customFields: Record<string, string | number>;
}

type EmployeeCreationAttributes = Optional<EmployeeAttributes, 'id' | 'email' | 'phone' | 'employmentStatus' | 'customFields'>;

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
  declare employmentStatus: 'active' | 'inactive' | 'on_leave';
  declare customFields: Record<string, string | number>;
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
      type: DataTypes.ENUM('active', 'inactive', 'on_leave'),
      allowNull: false,
      defaultValue: 'active',
      field: 'employment_status',
    },
    customFields: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'custom_fields' },
  },
  { sequelize, tableName: 'employees', underscored: true },
);

interface AuditLogAttributes {
  id: string;
  userId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt?: Date;
}

type AuditLogCreationAttributes = Optional<AuditLogAttributes, 'id' | 'entityId' | 'createdAt'>;

export class AuditLog extends Model<AuditLogAttributes, AuditLogCreationAttributes> implements AuditLogAttributes {
  declare id: string;
  declare userId: string;
  declare action: string;
  declare entityType: string;
  declare entityId: string | null;
  declare createdAt: Date;
}

AuditLog.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
    action: { type: DataTypes.STRING(80), allowNull: false },
    entityType: { type: DataTypes.STRING(80), allowNull: false, field: 'entity_type' },
    entityId: { type: DataTypes.UUID, allowNull: true, field: 'entity_id' },
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
  status: LeaveRequestStatus;
  approvalRoles: UserRole[];
  approvalStepIndex: number;
  submittedBy: string;
  decidedAt: Date | null;
}

type LeaveRequestCreationAttributes = Optional<LeaveRequestAttributes, 'id' | 'startTime' | 'endTime' | 'substituteName' | 'status' | 'approvalStepIndex' | 'decidedAt'>;

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
  entryType: 'opening' | 'adjustment' | 'taken' | 'reversal';
  requestId: string | null;
  reason: string;
  createdBy: string;
}

type LeaveLedgerEntryCreationAttributes = Optional<LeaveLedgerEntryAttributes, 'id' | 'requestId'>;

export class LeaveLedgerEntry extends Model<LeaveLedgerEntryAttributes, LeaveLedgerEntryCreationAttributes> implements LeaveLedgerEntryAttributes {
  declare id: string;
  declare employeeId: string;
  declare leaveTypeId: string;
  declare quantity: string;
  declare entryType: LeaveLedgerEntryAttributes['entryType'];
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
    entryType: { type: DataTypes.ENUM('opening', 'adjustment', 'taken', 'reversal'), allowNull: false, field: 'entry_type' },
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
