import type { MigrationContext } from '../migrator';

/**
 * Baseline schema of phase one, as previously created by `sequelize.sync()`.
 * Every statement is idempotent so this runs safely both on an empty database
 * and on a database that phase one already created (it just records itself).
 */
const ROLE_VALUES = "'super_admin','hr_manager','hr_staff','finance','branch_manager','viewer'";

function createEnum(name: string, values: string): string {
  return `DO $$ BEGIN
    CREATE TYPE ${name} AS ENUM (${values});
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
}

export async function up({ sequelize }: MigrationContext): Promise<void> {
  const statements = [
    createEnum('enum_employees_employment_status', "'active','inactive','on_leave'"),
    createEnum('enum_leave_approvals_action', "'approved','rejected'"),
    createEnum('enum_leave_approvals_role', ROLE_VALUES),
    createEnum('enum_leave_ledger_entries_entry_type', "'opening','adjustment','taken','reversal'"),
    createEnum('enum_leave_requests_status', "'pending','approved','rejected','cancelled'"),
    createEnum('enum_users_role', ROLE_VALUES),

    `CREATE TABLE IF NOT EXISTS branches (
      id uuid PRIMARY KEY,
      code varchar(24) NOT NULL UNIQUE,
      name varchar(120) NOT NULL,
      city varchar(80) NOT NULL,
      address varchar(240),
      phone varchar(40),
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      name varchar(120) NOT NULL,
      email varchar(254) NOT NULL UNIQUE,
      password_hash varchar(100) NOT NULL,
      role enum_users_role NOT NULL DEFAULT 'viewer',
      branch_id uuid REFERENCES branches(id) ON UPDATE CASCADE ON DELETE SET NULL,
      is_active boolean NOT NULL DEFAULT true,
      token_version integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS employees (
      id uuid PRIMARY KEY,
      employee_no varchar(40) NOT NULL UNIQUE,
      full_name varchar(180) NOT NULL,
      email varchar(254),
      phone varchar(40),
      branch_id uuid NOT NULL REFERENCES branches(id) ON UPDATE CASCADE ON DELETE CASCADE,
      department varchar(120) NOT NULL,
      "position" varchar(120) NOT NULL,
      hire_date date NOT NULL,
      employment_status enum_employees_employment_status NOT NULL DEFAULT 'active',
      custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    )`,
    "ALTER TABLE employees ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb",
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      action varchar(80) NOT NULL,
      entity_type varchar(80) NOT NULL,
      entity_id uuid,
      created_at timestamptz NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS system_settings (
      id uuid PRIMARY KEY,
      value jsonb NOT NULL,
      updated_by uuid NOT NULL,
      updated_at timestamptz NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS leave_requests (
      id uuid PRIMARY KEY,
      employee_id uuid NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE CASCADE,
      leave_type_id uuid NOT NULL,
      starts_on date NOT NULL,
      ends_on date NOT NULL,
      start_time time,
      end_time time,
      quantity numeric(8,2) NOT NULL,
      reason varchar(1000) NOT NULL,
      substitute_name varchar(180),
      medical_certificate_reference varchar(180),
      status enum_leave_requests_status NOT NULL DEFAULT 'pending',
      approval_roles jsonb NOT NULL,
      approval_step_index integer NOT NULL DEFAULT 0,
      submitted_by uuid NOT NULL,
      decided_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    )`,
    'ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS medical_certificate_reference varchar(180)',
    `CREATE TABLE IF NOT EXISTS leave_ledger_entries (
      id uuid PRIMARY KEY,
      employee_id uuid NOT NULL REFERENCES employees(id) ON UPDATE CASCADE,
      leave_type_id uuid NOT NULL,
      quantity numeric(8,2) NOT NULL,
      entry_type enum_leave_ledger_entries_entry_type NOT NULL,
      request_id uuid,
      reason varchar(1000) NOT NULL,
      created_by uuid NOT NULL,
      created_at timestamptz NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS leave_approvals (
      id uuid PRIMARY KEY,
      request_id uuid NOT NULL REFERENCES leave_requests(id) ON UPDATE CASCADE ON DELETE CASCADE,
      step_index integer NOT NULL,
      role enum_leave_approvals_role NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
      action enum_leave_approvals_action NOT NULL,
      note varchar(1000),
      created_at timestamptz NOT NULL
    )`,
  ];
  for (const statement of statements) {
    await sequelize.query(statement);
  }
}
