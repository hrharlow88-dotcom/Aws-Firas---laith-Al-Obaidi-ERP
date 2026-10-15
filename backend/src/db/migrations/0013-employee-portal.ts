import type { MigrationContext } from '../migrator';

/**
 * Employee portal: sign-in by employee number, and requests that are not
 * leave (loans and work-expense claims) with HR's decision and payment.
 */
export async function up({ sequelize }: MigrationContext): Promise<void> {
  const statements = [
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS username varchar(40)',
    'CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (lower(username)) WHERE username IS NOT NULL',
    'ALTER TABLE password_setup_tokens ADD COLUMN IF NOT EXISTS purpose varchar(12) NOT NULL DEFAULT \'reset\'',
    `CREATE TABLE IF NOT EXISTS employee_requests (
      id uuid PRIMARY KEY,
      employee_id uuid NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      kind varchar(10) NOT NULL CHECK (kind IN ('loan','expense')),
      amount numeric(14,2) NOT NULL CHECK (amount > 0),
      currency char(3) NOT NULL,
      months integer CHECK (months BETWEEN 1 AND 60),
      start_period char(7) CHECK (start_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      expense_date date,
      description varchar(1000) NOT NULL,
      receipt_key varchar(255),
      receipt_name varchar(255),
      status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','paid','cancelled')),
      decided_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      decided_at timestamptz,
      decision_note varchar(500),
      decision_signature text,
      loan_id uuid REFERENCES employee_loans(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      paid_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      paid_at timestamptz,
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    'CREATE INDEX IF NOT EXISTS employee_requests_employee_idx ON employee_requests (employee_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS employee_requests_status_idx ON employee_requests (status, kind)',
  ];
  for (const statement of statements) await sequelize.query(statement);
}
