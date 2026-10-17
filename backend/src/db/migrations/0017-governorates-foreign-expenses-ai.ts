import type { MigrationContext } from '../migrator';

/**
 * Governorates (Baghdad, Mosul, Erbil) over branches, the daily dollar rate,
 * foreign employees' passports and residencies, reminders, compensatory leave,
 * the official holiday calendar, the AI assistant, direct-deduction advances,
 * per-user app access, expenses and approvals.
 */
export async function up({ sequelize }: MigrationContext): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS governorates (
      id uuid PRIMARY KEY,
      code varchar(12) NOT NULL UNIQUE,
      name_ar varchar(80) NOT NULL,
      name_en varchar(80) NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `INSERT INTO governorates (id, code, name_ar, name_en, sort_order) VALUES
      ('70000000-0000-4000-8000-000000000001', 'BGD', 'بغداد', 'Baghdad', 1),
      ('70000000-0000-4000-8000-000000000002', 'MSL', 'الموصل', 'Mosul', 2),
      ('70000000-0000-4000-8000-000000000003', 'EBL', 'أربيل', 'Erbil', 3)
     ON CONFLICT (code) DO NOTHING`,
    'ALTER TABLE branches ADD COLUMN IF NOT EXISTS governorate_id uuid REFERENCES governorates(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    `UPDATE branches SET governorate_id = CASE
        WHEN city ~ '(بغداد|Baghdad)' OR name ~ '(بغداد|Baghdad)' THEN '70000000-0000-4000-8000-000000000001'::uuid
        WHEN city ~ '(موصل|نينوى|Mosul)' OR name ~ '(موصل|Mosul)' THEN '70000000-0000-4000-8000-000000000002'::uuid
        WHEN city ~ '(أربيل|اربيل|Erbil)' OR name ~ '(أربيل|اربيل|Erbil)' THEN '70000000-0000-4000-8000-000000000003'::uuid
      END
     WHERE governorate_id IS NULL`,
    'ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS governorate_id uuid REFERENCES governorates(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    // One live run per month, currency and scope (company, governorate or branch).
    'DROP INDEX IF EXISTS payroll_runs_one_active_per_scope',
    `CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_one_active_per_scope ON payroll_runs (period, currency,
       COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(governorate_id, '00000000-0000-0000-0000-000000000000'::uuid))
     WHERE status <> 'cancelled'`,
    'ALTER TABLE payroll_archive_months ADD COLUMN IF NOT EXISTS governorate_id uuid REFERENCES governorates(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    `UPDATE payroll_archive_months m SET governorate_id = b.governorate_id FROM branches b WHERE b.id = m.branch_id AND m.governorate_id IS NULL`,

    // Dinars per US dollar, one bulletin per day.
    `CREATE TABLE IF NOT EXISTS exchange_rates (
      rate_date date PRIMARY KEY,
      usd_iqd numeric(12,2) NOT NULL CHECK (usd_iqd > 0),
      note varchar(200),
      set_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,

    // Local or foreign employee, passport and residency (visa).
    "ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS residency_status varchar(10) NOT NULL DEFAULT 'local' CHECK (residency_status IN ('local','foreign'))",
    'ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS passport_no text',
    'ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS passport_expiry date',
    'ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS residency_type varchar(60)',
    'ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS residency_no varchar(60)',
    'ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS residency_expiry date',

    // One row per reminder sent, so each one goes out once.
    `CREATE TABLE IF NOT EXISTS reminder_log (
      kind varchar(30) NOT NULL,
      entity_id uuid NOT NULL,
      ref_date date NOT NULL,
      sent_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, entity_id, ref_date)
    )`,

    // Official holiday calendar: proposed by the system, confirmed by the owner.
    `CREATE TABLE IF NOT EXISTS holiday_calendar (
      holiday_date date PRIMARY KEY,
      name_ar varchar(120) NOT NULL,
      name_en varchar(120),
      source varchar(12) NOT NULL DEFAULT 'manual' CHECK (source IN ('fixed','hijri','manual')),
      confirmed boolean NOT NULL DEFAULT false,
      confirmed_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
      confirmed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,

    // Compensatory leave: work on an official holiday earns days outside the annual balance.
    `CREATE TABLE IF NOT EXISTS comp_leave_credits (
      id uuid PRIMARY KEY,
      employee_id uuid NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      work_date date NOT NULL,
      days numeric(5,2) NOT NULL CHECK (days > 0 AND days <= 5),
      reason varchar(300),
      ledger_entry_id uuid,
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (employee_id, work_date)
    )`,

    // Secrets the owner sets (the AI key), encrypted with DATA_ENCRYPTION_KEY.
    `CREATE TABLE IF NOT EXISTS app_secrets (
      key varchar(40) PRIMARY KEY,
      value_enc text NOT NULL,
      updated_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS ai_jobs (
      id uuid PRIMARY KEY,
      kind varchar(20) NOT NULL CHECK (kind IN ('attendance_rules','import')),
      instruction text,
      file_key varchar(300),
      file_name varchar(255),
      status varchar(12) NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','applied','discarded','failed')),
      engine varchar(20) NOT NULL DEFAULT 'rules',
      proposal jsonb,
      result jsonb,
      error varchar(500),
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      applied_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
      applied_at timestamptz
    )`,

    // Advances: an instalment plan, or a direct deduction taken in one go then archived.
    "ALTER TABLE employee_loans ADD COLUMN IF NOT EXISTS kind varchar(12) NOT NULL DEFAULT 'installment' CHECK (kind IN ('installment','direct'))",
    'ALTER TABLE employee_loans ADD COLUMN IF NOT EXISTS closed_at timestamptz',
    'ALTER TABLE employee_loans ADD COLUMN IF NOT EXISTS archived_at timestamptz',
    "ALTER TABLE contract_templates ADD COLUMN IF NOT EXISTS kind varchar(12) NOT NULL DEFAULT 'contract'",

    // Per-user app access (null = what the role allows) and e-mail notifications.
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS app_access text[]',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_email boolean NOT NULL DEFAULT false',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_email varchar(254)',

    // Approvals: categories with ordered approvers, requests and every decision.
    `CREATE TABLE IF NOT EXISTS approval_categories (
      id uuid PRIMARY KEY,
      code varchar(20) NOT NULL UNIQUE,
      name_ar varchar(120) NOT NULL,
      name_en varchar(120),
      description varchar(500),
      steps jsonb NOT NULL DEFAULT '[]',
      needs_amount boolean NOT NULL DEFAULT false,
      needs_dates boolean NOT NULL DEFAULT false,
      needs_attachment boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `INSERT INTO approval_categories (id, code, name_ar, name_en, steps, needs_amount, needs_dates, needs_attachment, sort_order) VALUES
      ('71000000-0000-4000-8000-000000000001', 'PURCHASE', 'طلب شراء', 'Purchase request', '[{"type":"manager"},{"type":"role","role":"finance"}]', true, false, true, 1),
      ('71000000-0000-4000-8000-000000000002', 'TRIP', 'سفر عمل', 'Business trip', '[{"type":"manager"},{"type":"role","role":"hr_manager"}]', true, true, false, 2),
      ('71000000-0000-4000-8000-000000000003', 'BORROW', 'استلام عهدة', 'Borrow items', '[{"type":"manager"}]', false, true, false, 3),
      ('71000000-0000-4000-8000-000000000004', 'GENERAL', 'موافقة عامة', 'General approval', '[{"type":"manager"},{"type":"role","role":"executive"}]', false, false, false, 4)
     ON CONFLICT (code) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS approval_requests (
      id uuid PRIMARY KEY,
      number varchar(20) NOT NULL UNIQUE,
      category_id uuid REFERENCES approval_categories(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      entity_type varchar(20) NOT NULL DEFAULT 'approval' CHECK (entity_type IN ('approval','expense')),
      requester_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      employee_id uuid REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      title varchar(200) NOT NULL,
      details text,
      amount numeric(14,2),
      currency char(3),
      date_from date,
      date_to date,
      attachment_key varchar(300),
      attachment_name varchar(255),
      steps jsonb NOT NULL,
      current_step integer NOT NULL DEFAULT 0,
      status varchar(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('draft','pending','approved','refused','cancelled','paid')),
      paid_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
      paid_at timestamptz,
      payment_mode varchar(10),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    'CREATE INDEX IF NOT EXISTS approval_requests_status_idx ON approval_requests (status, entity_type)',
    `CREATE TABLE IF NOT EXISTS approval_actions (
      id uuid PRIMARY KEY,
      request_id uuid NOT NULL REFERENCES approval_requests(id) ON UPDATE CASCADE ON DELETE CASCADE,
      step integer NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      decision varchar(10) NOT NULL CHECK (decision IN ('approved','refused','submitted','paid','cancelled')),
      note varchar(500),
      at timestamptz NOT NULL DEFAULT now()
    )`,
    // Expense lines of an expense report (approval_requests with entity_type = 'expense').
    `CREATE TABLE IF NOT EXISTS expense_lines (
      id uuid PRIMARY KEY,
      request_id uuid NOT NULL REFERENCES approval_requests(id) ON UPDATE CASCADE ON DELETE CASCADE,
      expense_date date NOT NULL,
      category varchar(40) NOT NULL,
      description varchar(300) NOT NULL,
      amount numeric(14,2) NOT NULL CHECK (amount > 0),
      receipt_key varchar(300),
      receipt_name varchar(255)
    )`,
  ];
  for (const statement of statements) await sequelize.query(statement);
}
