import type { MigrationContext } from '../migrator';

/**
 * Accounts for every kind of user, not only HR: employees and line managers
 * see their own record or their team through the linked employee; payroll
 * officers, auditors, executives and the IT administrator get their own roles.
 * Repeated wrong passwords lock the account for a while.
 */
const NEW_ROLES = ['employee', 'line_manager', 'payroll_officer', 'auditor', 'executive', 'it_admin'];

export async function up({ sequelize }: MigrationContext): Promise<void> {
  for (const type of ['enum_users_role', 'enum_leave_approvals_role']) {
    for (const role of NEW_ROLES) {
      await sequelize.query(`ALTER TYPE ${type} ADD VALUE IF NOT EXISTS '${role}'`);
    }
  }
  const statements = [
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id uuid REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL',
    'CREATE UNIQUE INDEX IF NOT EXISTS users_employee_id_key ON users (employee_id) WHERE employee_id IS NOT NULL',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins integer NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz',
    // Team scope walks manager_id downwards.
    'CREATE INDEX IF NOT EXISTS employees_manager_id_idx ON employees (manager_id)',
    // Lookups of an employee's own payslips.
    'CREATE INDEX IF NOT EXISTS payroll_lines_employee_idx ON payroll_lines (employee_id)',
  ];
  for (const statement of statements) {
    await sequelize.query(statement);
  }
}
