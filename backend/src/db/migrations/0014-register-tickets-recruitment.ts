import type { MigrationContext } from '../migrator';

/**
 * HR register (warnings, penalties, violations), the helpdesk (IT,
 * maintenance, vehicle and transport requests) and recruitment.
 */
export async function up({ sequelize }: MigrationContext): Promise<void> {
  const statements = [
    'CREATE SEQUENCE IF NOT EXISTS disciplinary_ref_seq',
    `CREATE TABLE IF NOT EXISTS disciplinary_records (
      id uuid PRIMARY KEY,
      ref_no varchar(20) NOT NULL UNIQUE,
      employee_id uuid NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      category varchar(20) NOT NULL CHECK (category IN ('lateness','absence','conduct','performance','safety','policy','property','other')),
      action varchar(20) NOT NULL CHECK (action IN ('note','verbal_warning','written_warning','final_warning','deduction','suspension','termination')),
      title varchar(200) NOT NULL,
      description text NOT NULL,
      incident_date date NOT NULL,
      deduction_amount numeric(14,2) CHECK (deduction_amount > 0),
      deduction_currency char(3),
      deduction_period char(7) CHECK (deduction_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      suspension_days integer CHECK (suspension_days BETWEEN 1 AND 60),
      payroll_input_id uuid REFERENCES payroll_inputs(id) ON UPDATE CASCADE ON DELETE SET NULL,
      status varchar(14) NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','acknowledged','cancelled')),
      signature text,
      issued_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      issued_at timestamptz NOT NULL DEFAULT now(),
      acknowledged_at timestamptz,
      employee_comment varchar(1000),
      cancelled_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      cancelled_at timestamptz,
      cancel_reason varchar(500)
    )`,
    'CREATE INDEX IF NOT EXISTS disciplinary_records_employee_idx ON disciplinary_records (employee_id, incident_date DESC)',

    'CREATE SEQUENCE IF NOT EXISTS ticket_ref_seq',
    `CREATE TABLE IF NOT EXISTS tickets (
      id uuid PRIMARY KEY,
      ref_no varchar(20) NOT NULL UNIQUE,
      category varchar(12) NOT NULL CHECK (category IN ('it','maintenance','vehicle','transport')),
      subtype varchar(60),
      title varchar(200) NOT NULL,
      description text NOT NULL,
      priority varchar(8) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
      status varchar(12) NOT NULL DEFAULT 'new' CHECK (status IN ('new','assigned','in_progress','waiting','resolved','closed','cancelled')),
      requester_user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      requester_employee_id uuid REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      branch_id uuid REFERENCES branches(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      location varchar(200),
      assignee_user_id uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      needed_from timestamptz,
      needed_to timestamptz,
      destination varchar(200),
      passengers integer CHECK (passengers BETWEEN 1 AND 100),
      vehicle_plate varchar(30),
      resolution text,
      resolved_at timestamptz,
      closed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    'CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (category, status)',
    'CREATE INDEX IF NOT EXISTS tickets_requester_idx ON tickets (requester_user_id, created_at DESC)',
    `CREATE TABLE IF NOT EXISTS ticket_comments (
      id uuid PRIMARY KEY,
      ticket_id uuid NOT NULL REFERENCES tickets(id) ON UPDATE CASCADE ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      body varchar(2000) NOT NULL,
      kind varchar(10) NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','status','assign')),
      created_at timestamptz NOT NULL DEFAULT now()
    )`,

    `CREATE TABLE IF NOT EXISTS job_positions (
      id uuid PRIMARY KEY,
      title varchar(150) NOT NULL,
      title_en varchar(150),
      department_id uuid REFERENCES departments(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      branch_id uuid REFERENCES branches(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      job_title_id uuid REFERENCES job_titles(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      description text,
      requirements text,
      vacancies integer NOT NULL DEFAULT 1 CHECK (vacancies BETWEEN 1 AND 500),
      status varchar(8) NOT NULL DEFAULT 'open' CHECK (status IN ('open','paused','closed')),
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS applicants (
      id uuid PRIMARY KEY,
      position_id uuid NOT NULL REFERENCES job_positions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      full_name varchar(180) NOT NULL,
      email varchar(254),
      phone varchar(40),
      source varchar(40),
      expected_salary numeric(14,2),
      currency char(3),
      stage varchar(12) NOT NULL DEFAULT 'new' CHECK (stage IN ('new','screening','interview1','interview2','offer','hired','refused')),
      priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
      notes text,
      cv_key varchar(255),
      cv_name varchar(255),
      interview_at timestamptz,
      refuse_reason varchar(500),
      hired_employee_id uuid REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      stage_changed_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    'CREATE INDEX IF NOT EXISTS applicants_position_idx ON applicants (position_id, stage)',
    `CREATE TABLE IF NOT EXISTS applicant_activities (
      id uuid PRIMARY KEY,
      applicant_id uuid NOT NULL REFERENCES applicants(id) ON UPDATE CASCADE ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      kind varchar(10) NOT NULL CHECK (kind IN ('note','stage','created','hired')),
      body varchar(2000) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  ];
  for (const statement of statements) await sequelize.query(statement);
}
