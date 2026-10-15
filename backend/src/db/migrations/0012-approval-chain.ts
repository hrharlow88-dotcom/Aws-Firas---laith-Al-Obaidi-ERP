import type { MigrationContext } from '../migrator';

/**
 * Electronic signatures and the payroll approval chain:
 * HR → audit → chief executive → finance (disbursement).
 * Each sign-off keeps a copy of the signature image as it was when signed.
 */
export async function up({ sequelize }: MigrationContext): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS user_signatures (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      image text NOT NULL CHECK (image LIKE 'data:image/png;base64,%' AND length(image) <= 300000),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS payroll_run_signoffs (
      id uuid PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES payroll_runs(id) ON UPDATE CASCADE ON DELETE CASCADE,
      step varchar(10) NOT NULL CHECK (step IN ('hr','audit','ceo','finance')),
      user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      signature text NOT NULL,
      signature_sha256 char(64) NOT NULL,
      note varchar(500),
      ip varchar(64),
      signed_at timestamptz NOT NULL DEFAULT now(),
      voided_at timestamptz,
      voided_reason varchar(500)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS payroll_run_signoffs_live
      ON payroll_run_signoffs (run_id, step) WHERE voided_at IS NULL`,
    'ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS paid_at timestamptz',
    'ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS paid_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT',
  ];
  for (const statement of statements) await sequelize.query(statement);
}
