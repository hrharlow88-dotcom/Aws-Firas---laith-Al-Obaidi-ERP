import type { MigrationContext } from '../migrator';

export async function up({ sequelize }: MigrationContext): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS departments (
      id uuid PRIMARY KEY,
      code varchar(24) NOT NULL UNIQUE,
      name varchar(120) NOT NULL,
      parent_id uuid REFERENCES departments(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      branch_id uuid REFERENCES branches(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      manager_employee_id uuid,
      cost_center_code varchar(40),
      sort_order integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (parent_id IS NULL OR parent_id <> id)
    )`,
    'CREATE INDEX IF NOT EXISTS departments_parent_idx ON departments (parent_id)',

    `CREATE TABLE IF NOT EXISTS job_titles (
      id uuid PRIMARY KEY,
      code varchar(24) NOT NULL UNIQUE,
      name varchar(120) NOT NULL,
      department_id uuid REFERENCES departments(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      grade varchar(20),
      description varchar(2000),
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,

    'ALTER TABLE employees ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    'ALTER TABLE employees ADD COLUMN IF NOT EXISTS job_title_id uuid REFERENCES job_titles(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    'ALTER TABLE employees ADD COLUMN IF NOT EXISTS manager_id uuid REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL',
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_type varchar(20) NOT NULL DEFAULT 'permanent'
      CHECK (employment_type IN ('permanent','fixed_term','probation','daily','part_time','contractor'))`,
    'ALTER TABLE employees ADD COLUMN IF NOT EXISTS attendance_pin varchar(40)',
    'ALTER TABLE employees ADD COLUMN IF NOT EXISTS card_token varchar(64)',
    'ALTER TABLE employees ADD COLUMN IF NOT EXISTS card_issued_at timestamptz',
    'ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo_document_id uuid',
    'ALTER TABLE employees ADD COLUMN IF NOT EXISTS termination_date date',
    'CREATE UNIQUE INDEX IF NOT EXISTS employees_attendance_pin_key ON employees (attendance_pin) WHERE attendance_pin IS NOT NULL',
    'CREATE UNIQUE INDEX IF NOT EXISTS employees_card_token_key ON employees (card_token) WHERE card_token IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS employees_department_idx ON employees (department_id)',
    'CREATE INDEX IF NOT EXISTS employees_manager_idx ON employees (manager_id)',
    `DO $$ BEGIN
      ALTER TABLE departments ADD CONSTRAINT departments_manager_fkey FOREIGN KEY (manager_employee_id)
        REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

    `CREATE TABLE IF NOT EXISTS employee_profiles (
      employee_id uuid PRIMARY KEY REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      name_en varchar(180),
      mother_name varchar(180),
      gender varchar(10) CHECK (gender IN ('male','female')),
      birth_date date,
      birth_place varchar(120),
      nationality varchar(80),
      marital_status varchar(20) CHECK (marital_status IN ('single','married','divorced','widowed')),
      dependents_count integer CHECK (dependents_count BETWEEN 0 AND 30),
      national_id_no text,
      address varchar(400),
      governorate varchar(80),
      emergency_contact_name varchar(180),
      emergency_contact_phone varchar(40),
      emergency_contact_relation varchar(60),
      education_level varchar(80),
      education_major varchar(120),
      blood_type varchar(4),
      social_security_no varchar(40),
      payment_method varchar(10) NOT NULL DEFAULT 'bank' CHECK (payment_method IN ('bank','cash','wallet')),
      bank_name varchar(120),
      bank_account_no text,
      wallet_provider varchar(60),
      updated_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,

    `CREATE TABLE IF NOT EXISTS employee_compensation (
      id uuid PRIMARY KEY,
      employee_id uuid NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      effective_from date NOT NULL,
      gross_salary numeric(14,2) NOT NULL CHECK (gross_salary >= 0),
      currency char(3) NOT NULL,
      component_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
      reason varchar(500) NOT NULL,
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (employee_id, effective_from)
    )`,

    `CREATE TABLE IF NOT EXISTS employee_documents (
      id uuid PRIMARY KEY,
      employee_id uuid NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      doc_type varchar(30) NOT NULL,
      title varchar(160) NOT NULL,
      doc_number varchar(80),
      issue_date date,
      expiry_date date,
      storage_key varchar(300) NOT NULL,
      original_name varchar(255) NOT NULL,
      mime_type varchar(100) NOT NULL,
      size_bytes integer NOT NULL,
      sha256 char(64) NOT NULL,
      uploaded_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT
    )`,
    'CREATE INDEX IF NOT EXISTS employee_documents_employee_idx ON employee_documents (employee_id) WHERE deleted_at IS NULL',
    'CREATE INDEX IF NOT EXISTS employee_documents_expiry_idx ON employee_documents (expiry_date) WHERE deleted_at IS NULL AND expiry_date IS NOT NULL',

    `CREATE TABLE IF NOT EXISTS employee_contracts (
      id uuid PRIMARY KEY,
      employee_id uuid NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      contract_no varchar(60),
      contract_type varchar(20) NOT NULL CHECK (contract_type IN ('permanent','fixed_term','probation','daily','part_time','contractor')),
      starts_on date NOT NULL,
      ends_on date,
      probation_ends_on date,
      status varchar(12) NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','expired','terminated')),
      document_id uuid REFERENCES employee_documents(id) ON UPDATE CASCADE ON DELETE SET NULL,
      notes varchar(1000),
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (ends_on IS NULL OR ends_on >= starts_on)
    )`,
    'CREATE INDEX IF NOT EXISTS employee_contracts_employee_idx ON employee_contracts (employee_id)',
  ];
  for (const statement of statements) {
    await sequelize.query(statement);
  }
}
