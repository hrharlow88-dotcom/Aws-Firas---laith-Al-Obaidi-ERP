import type { MigrationContext } from '../migrator';

/**
 * Monthly leave accrual. Each run posts one 'accrual' ledger entry per
 * employee and leave type for a calendar month; the unique index makes a
 * second run for the same month impossible, so balances cannot be credited twice.
 */
export async function up({ sequelize }: MigrationContext): Promise<void> {
  await sequelize.query("ALTER TYPE enum_leave_ledger_entries_entry_type ADD VALUE IF NOT EXISTS 'accrual'");
  const statements = [
    `CREATE TABLE IF NOT EXISTS leave_accrual_runs (
      id uuid PRIMARY KEY,
      leave_type_id uuid NOT NULL,
      period char(7) NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      employee_count integer NOT NULL,
      total_days numeric(12,2) NOT NULL,
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (leave_type_id, period)
    )`,
    'ALTER TABLE leave_ledger_entries ADD COLUMN IF NOT EXISTS accrual_period char(7)',
    `CREATE UNIQUE INDEX IF NOT EXISTS leave_ledger_accrual_once
      ON leave_ledger_entries (employee_id, leave_type_id, accrual_period) WHERE accrual_period IS NOT NULL`,
  ];
  for (const statement of statements) await sequelize.query(statement);
}
