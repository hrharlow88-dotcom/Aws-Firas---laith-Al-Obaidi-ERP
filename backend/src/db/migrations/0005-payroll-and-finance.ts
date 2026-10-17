import type { MigrationContext } from '../migrator';

export async function up({ sequelize }: MigrationContext): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS payroll_runs (
      id uuid PRIMARY KEY,
      period char(7) NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      starts_on date NOT NULL,
      ends_on date NOT NULL,
      branch_id uuid REFERENCES branches(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      status varchar(12) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','calculated','approved','posted','cancelled')),
      currency char(3) NOT NULL,
      employee_count integer NOT NULL DEFAULT 0,
      total_earnings numeric(16,2) NOT NULL DEFAULT 0,
      total_deductions numeric(16,2) NOT NULL DEFAULT 0,
      total_net numeric(16,2) NOT NULL DEFAULT 0,
      warning_count integer NOT NULL DEFAULT 0,
      notes varchar(1000),
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      calculated_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      calculated_at timestamptz,
      approved_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      approved_at timestamptz,
      posted_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      posted_at timestamptz,
      cancelled_reason varchar(500),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (ends_on >= starts_on)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_one_active_per_scope
      ON payroll_runs (period, currency, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
      WHERE status <> 'cancelled'`,

    `CREATE TABLE IF NOT EXISTS payroll_lines (
      id uuid PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES payroll_runs(id) ON UPDATE CASCADE ON DELETE CASCADE,
      employee_id uuid NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      branch_id uuid NOT NULL REFERENCES branches(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      department_id uuid REFERENCES departments(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      cost_center_code varchar(40),
      gross_salary numeric(14,2) NOT NULL,
      currency char(3) NOT NULL,
      period_days integer NOT NULL,
      employed_days integer NOT NULL,
      scheduled_days integer NOT NULL DEFAULT 0,
      present_days integer NOT NULL DEFAULT 0,
      absent_days integer NOT NULL DEFAULT 0,
      unpaid_leave_days integer NOT NULL DEFAULT 0,
      late_minutes integer NOT NULL DEFAULT 0,
      overtime_minutes integer NOT NULL DEFAULT 0,
      attendance_tracked boolean NOT NULL DEFAULT false,
      earnings jsonb NOT NULL DEFAULT '[]'::jsonb,
      deductions jsonb NOT NULL DEFAULT '[]'::jsonb,
      total_earnings numeric(14,2) NOT NULL,
      total_deductions numeric(14,2) NOT NULL,
      net_pay numeric(14,2) NOT NULL,
      payment_method varchar(10) NOT NULL DEFAULT 'bank',
      warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (run_id, employee_id)
    )`,
    'CREATE INDEX IF NOT EXISTS payroll_lines_employee_idx ON payroll_lines (employee_id)',

    `CREATE TABLE IF NOT EXISTS payroll_inputs (
      id uuid PRIMARY KEY,
      period char(7) NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      employee_id uuid NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      component_id uuid NOT NULL,
      amount numeric(14,2) NOT NULL CHECK (amount >= 0),
      note varchar(500),
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    'CREATE INDEX IF NOT EXISTS payroll_inputs_period_idx ON payroll_inputs (period, employee_id)',

    `DO $$ BEGIN
      ALTER TABLE attendance_days ADD CONSTRAINT attendance_days_payroll_run_fkey FOREIGN KEY (payroll_run_id)
        REFERENCES payroll_runs(id) ON UPDATE CASCADE ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

    `CREATE TABLE IF NOT EXISTS finance_account_mappings (
      mapping_key varchar(40) PRIMARY KEY,
      label varchar(120) NOT NULL,
      debit_account varchar(40),
      credit_account varchar(40),
      use_cost_center boolean NOT NULL DEFAULT true,
      updated_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,

    `CREATE TABLE IF NOT EXISTS journal_entries (
      id uuid PRIMARY KEY,
      reference varchar(50) NOT NULL UNIQUE,
      source_type varchar(20) NOT NULL,
      source_id uuid NOT NULL,
      entry_date date NOT NULL,
      memo varchar(254) NOT NULL,
      currency char(3) NOT NULL,
      total_debit numeric(16,2) NOT NULL,
      total_credit numeric(16,2) NOT NULL,
      status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','posting','posted','failed','cancelled')),
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz,
      last_error varchar(2000),
      sap_trans_id integer,
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      queued_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      queued_at timestamptz,
      posted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (total_debit = total_credit)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_active_per_source
      ON journal_entries (source_type, source_id) WHERE status <> 'cancelled'`,
    'CREATE INDEX IF NOT EXISTS journal_entries_queue_idx ON journal_entries (status, next_attempt_at)',

    `CREATE TABLE IF NOT EXISTS journal_lines (
      id uuid PRIMARY KEY,
      entry_id uuid NOT NULL REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE CASCADE,
      line_no integer NOT NULL,
      account_code varchar(40) NOT NULL,
      debit numeric(16,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
      credit numeric(16,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
      cost_center varchar(40),
      memo varchar(100),
      UNIQUE (entry_id, line_no),
      CHECK ((debit = 0) <> (credit = 0))
    )`,

    `CREATE TABLE IF NOT EXISTS integration_api_keys (
      id uuid PRIMARY KEY,
      name varchar(120) NOT NULL,
      key_prefix varchar(16) NOT NULL UNIQUE,
      key_hash char(64) NOT NULL,
      scopes jsonb NOT NULL,
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz,
      revoked_at timestamptz
    )`,
  ];
  for (const statement of statements) {
    await sequelize.query(statement);
  }
}
