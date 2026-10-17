import type { MigrationContext } from '../migrator';

function replaceForeignKey(table: string, column: string, target: string, onDelete: string): string[] {
  const name = `${table}_${column}_fkey`;
  return [
    `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`,
    `ALTER TABLE ${table} ADD CONSTRAINT ${name} FOREIGN KEY (${column}) REFERENCES ${target}(id) ON UPDATE CASCADE ON DELETE ${onDelete}`,
  ];
}

/**
 * Phase one cascaded deletes from branches to employees, from employees to
 * leave requests, and from users to their audit trail. With payroll and
 * accounting data on top, a deleted parent must be refused instead.
 * The audit trail also becomes append-only at the database level.
 */
export async function up({ sequelize }: MigrationContext): Promise<void> {
  const statements = [
    ...replaceForeignKey('employees', 'branch_id', 'branches', 'RESTRICT'),
    ...replaceForeignKey('leave_requests', 'employee_id', 'employees', 'RESTRICT'),
    ...replaceForeignKey('audit_logs', 'user_id', 'users', 'RESTRICT'),

    'ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS details jsonb',
    'ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip varchar(64)',
    'CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at DESC)',
    'CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs (entity_type, entity_id)',
    'CREATE INDEX IF NOT EXISTS audit_logs_user_idx ON audit_logs (user_id)',
    `CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
     BEGIN
       RAISE EXCEPTION 'audit_logs is append-only';
     END $$ LANGUAGE plpgsql`,
    'DROP TRIGGER IF EXISTS audit_logs_no_change ON audit_logs',
    `CREATE TRIGGER audit_logs_no_change BEFORE UPDATE OR DELETE ON audit_logs
     FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only()`,

    'CREATE INDEX IF NOT EXISTS employees_branch_idx ON employees (branch_id)',
    'CREATE INDEX IF NOT EXISTS leave_requests_employee_idx ON leave_requests (employee_id, status)',
    'CREATE INDEX IF NOT EXISTS leave_ledger_employee_type_idx ON leave_ledger_entries (employee_id, leave_type_id)',
  ];
  for (const statement of statements) {
    await sequelize.query(statement);
  }
}
