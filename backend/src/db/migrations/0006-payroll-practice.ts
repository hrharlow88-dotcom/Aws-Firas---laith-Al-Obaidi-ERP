import type { MigrationContext } from '../migrator';

/**
 * Brings the payroll engine in line with how the company actually pays:
 * - "On Hold" employees (suspended) are kept on file but not paid.
 * - Social security is deducted from the salary declared on the SS platform,
 *   which is not the gross salary, so it is stored with the compensation.
 * - HR can set payable days and absence days per month for staff who are not
 *   on a fingerprint device yet.
 * - Loans are repaid in monthly instalments, capped so a payslip never goes
 *   negative; each deduction is tied to the run that made it.
 */
export async function up({ sequelize }: MigrationContext): Promise<void> {
  // ADD VALUE cannot be used in the same transaction that adds it, which is fine here:
  // nothing below references the new value.
  await sequelize.query("ALTER TYPE enum_employees_employment_status ADD VALUE IF NOT EXISTS 'suspended'");

  const statements = [
    'ALTER TABLE employee_compensation ADD COLUMN IF NOT EXISTS social_security_base numeric(14,2) CHECK (social_security_base >= 0)',

    `CREATE TABLE IF NOT EXISTS payroll_day_adjustments (
      period char(7) NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      employee_id uuid NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      payable_days numeric(5,2) CHECK (payable_days BETWEEN 0 AND 31),
      absence_days numeric(5,2) NOT NULL DEFAULT 0 CHECK (absence_days BETWEEN 0 AND 31),
      note varchar(500),
      updated_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (period, employee_id)
    )`,

    `CREATE TABLE IF NOT EXISTS employee_loans (
      id uuid PRIMARY KEY,
      employee_id uuid NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      currency char(3) NOT NULL,
      principal numeric(14,2) NOT NULL CHECK (principal > 0),
      installment numeric(14,2) NOT NULL CHECK (installment > 0),
      paid_before numeric(14,2) NOT NULL DEFAULT 0 CHECK (paid_before >= 0),
      -- Agreed number of instalments; the last one takes whatever is left (rounding).
      installments_total integer CHECK (installments_total BETWEEN 1 AND 240),
      installments_paid_before integer NOT NULL DEFAULT 0 CHECK (installments_paid_before >= 0),
      start_period char(7) NOT NULL CHECK (start_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      status varchar(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
      reference varchar(60),
      notes varchar(1000),
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (paid_before <= principal)
    )`,
    'CREATE INDEX IF NOT EXISTS employee_loans_employee_idx ON employee_loans (employee_id)',

    `CREATE TABLE IF NOT EXISTS loan_repayments (
      loan_id uuid NOT NULL REFERENCES employee_loans(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      run_id uuid NOT NULL REFERENCES payroll_runs(id) ON UPDATE CASCADE ON DELETE CASCADE,
      period char(7) NOT NULL,
      -- In the loan's currency (what reduces the balance) and in the run's currency (what the payslip shows).
      amount numeric(14,2) NOT NULL CHECK (amount > 0),
      payroll_amount numeric(14,2) NOT NULL CHECK (payroll_amount > 0),
      PRIMARY KEY (loan_id, run_id)
    )`,
    'CREATE INDEX IF NOT EXISTS loan_repayments_run_idx ON loan_repayments (run_id)',

    'ALTER TABLE payroll_lines ADD COLUMN IF NOT EXISTS payable_days numeric(5,2)',
    'ALTER TABLE payroll_lines ADD COLUMN IF NOT EXISTS social_security_base numeric(14,2)',
  ];
  for (const statement of statements) {
    await sequelize.query(statement);
  }
}
