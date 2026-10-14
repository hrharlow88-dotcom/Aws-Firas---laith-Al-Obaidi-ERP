import type { MigrationContext } from '../migrator';

/**
 * Attendance. Punch times are stored as local wall-clock time (timestamp
 * without time zone) in the company time zone, which is how devices report
 * them and how shifts are defined; Baghdad has no daylight-saving changes.
 */
export async function up({ sequelize }: MigrationContext): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS shifts (
      id uuid PRIMARY KEY,
      code varchar(24) NOT NULL UNIQUE,
      name varchar(120) NOT NULL,
      start_time time NOT NULL,
      end_time time NOT NULL,
      break_minutes integer NOT NULL DEFAULT 0 CHECK (break_minutes BETWEEN 0 AND 480),
      grace_minutes integer NOT NULL DEFAULT 0 CHECK (grace_minutes BETWEEN 0 AND 240),
      early_leave_grace_minutes integer NOT NULL DEFAULT 0 CHECK (early_leave_grace_minutes BETWEEN 0 AND 240),
      working_days smallint[] NOT NULL,
      is_default boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (start_time <> end_time)
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS shifts_single_default ON shifts (is_default) WHERE is_default',
    'ALTER TABLE employees ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES shifts(id) ON UPDATE CASCADE ON DELETE RESTRICT',

    `CREATE TABLE IF NOT EXISTS attendance_devices (
      id uuid PRIMARY KEY,
      name varchar(120) NOT NULL,
      serial_no varchar(60) NOT NULL UNIQUE,
      branch_id uuid REFERENCES branches(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      ip_allowlist varchar(400),
      is_active boolean NOT NULL DEFAULT true,
      last_seen_at timestamptz,
      last_punch_at timestamp,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,

    `CREATE TABLE IF NOT EXISTS attendance_imports (
      id uuid PRIMARY KEY,
      source varchar(10) NOT NULL CHECK (source IN ('file','device')),
      file_name varchar(255),
      device_id uuid REFERENCES attendance_devices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      rows_total integer NOT NULL DEFAULT 0,
      rows_imported integer NOT NULL DEFAULT 0,
      rows_duplicate integer NOT NULL DEFAULT 0,
      rows_unmatched integer NOT NULL DEFAULT 0,
      rows_invalid integer NOT NULL DEFAULT 0,
      created_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,

    `CREATE TABLE IF NOT EXISTS attendance_punches (
      id uuid PRIMARY KEY,
      employee_id uuid REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      device_pin varchar(40) NOT NULL,
      punched_at timestamp NOT NULL,
      source varchar(10) NOT NULL CHECK (source IN ('device','import','manual')),
      device_id uuid REFERENCES attendance_devices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      import_id uuid REFERENCES attendance_imports(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      note varchar(500),
      created_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      voided_at timestamptz,
      voided_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      void_reason varchar(500),
      UNIQUE (device_pin, punched_at)
    )`,
    'CREATE INDEX IF NOT EXISTS attendance_punches_employee_idx ON attendance_punches (employee_id, punched_at)',
    'CREATE INDEX IF NOT EXISTS attendance_punches_unmatched_idx ON attendance_punches (device_pin) WHERE employee_id IS NULL',

    `CREATE TABLE IF NOT EXISTS attendance_days (
      employee_id uuid NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      work_date date NOT NULL,
      shift_id uuid REFERENCES shifts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      scheduled_minutes integer NOT NULL DEFAULT 0,
      first_in timestamp,
      last_out timestamp,
      punch_count integer NOT NULL DEFAULT 0,
      worked_minutes integer NOT NULL DEFAULT 0,
      late_minutes integer NOT NULL DEFAULT 0,
      early_leave_minutes integer NOT NULL DEFAULT 0,
      overtime_minutes integer NOT NULL DEFAULT 0,
      excused_minutes integer NOT NULL DEFAULT 0,
      status varchar(16) NOT NULL CHECK (status IN
        ('present','absent','leave','unpaid_leave','holiday','weekend','incomplete','not_employed')),
      leave_request_id uuid REFERENCES leave_requests(id) ON UPDATE CASCADE ON DELETE SET NULL,
      leave_type_name varchar(80),
      override_status varchar(16) CHECK (override_status IN ('present','absent','leave','unpaid_leave','holiday','weekend')),
      override_late_minutes integer CHECK (override_late_minutes >= 0),
      override_overtime_minutes integer CHECK (override_overtime_minutes >= 0),
      override_reason varchar(500),
      overridden_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      overridden_at timestamptz,
      payroll_run_id uuid,
      computed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (employee_id, work_date)
    )`,
    'CREATE INDEX IF NOT EXISTS attendance_days_date_idx ON attendance_days (work_date)',
  ];
  for (const statement of statements) {
    await sequelize.query(statement);
  }
}
