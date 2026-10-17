import type { MigrationContext } from '../migrator';

/**
 * v1.3: the employee sends their own photo from the portal and HR takes it in;
 * the fingerprint system's three exports (attendance, leave, app tasks) are
 * imported separately; imported leave is marked as such.
 */
export async function up({ sequelize }: MigrationContext): Promise<void> {
  const run = (sql: string) => sequelize.query(sql);

  // Photos sent from the portal, waiting for HR. One open submission per employee.
  await run(`CREATE TABLE IF NOT EXISTS employee_photo_submissions (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    storage_key varchar(300) NOT NULL,
    mime_type varchar(60) NOT NULL,
    size_bytes integer NOT NULL CHECK (size_bytes > 0),
    sha256 char(64) NOT NULL,
    status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','replaced')),
    submitted_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    submitted_at timestamptz NOT NULL DEFAULT now(),
    decided_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    decided_at timestamptz,
    decision_note varchar(500),
    document_id uuid REFERENCES employee_documents(id) ON UPDATE CASCADE ON DELETE SET NULL
  )`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS employee_photo_submissions_open
    ON employee_photo_submissions (employee_id) WHERE status = 'pending'`);
  await run('CREATE INDEX IF NOT EXISTS employee_photo_submissions_employee_idx ON employee_photo_submissions (employee_id, submitted_at DESC)');

  // Which of the three fingerprint exports an import came from, and what it did.
  await run(`ALTER TABLE attendance_imports ADD COLUMN IF NOT EXISTS kind varchar(12) NOT NULL DEFAULT 'attendance'`);
  await run(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_imports_kind_check') THEN
      ALTER TABLE attendance_imports ADD CONSTRAINT attendance_imports_kind_check CHECK (kind IN ('attendance','leaves','tasks'));
    END IF;
  END $$`);
  await run(`ALTER TABLE attendance_imports ADD COLUMN IF NOT EXISTS summary jsonb NOT NULL DEFAULT '{}'::jsonb`);

  // Punches made with the fingerprint app (external work) are kept apart from the device's.
  await run('ALTER TABLE attendance_punches DROP CONSTRAINT IF EXISTS attendance_punches_source_check');
  await run(`ALTER TABLE attendance_punches ADD CONSTRAINT attendance_punches_source_check
    CHECK (source IN ('device','import','manual','app'))`);

  // External work: a whole day or a time window on a date, from the tasks export.
  await run(`CREATE TABLE IF NOT EXISTS attendance_tasks (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    device_pin varchar(40),
    work_date date NOT NULL,
    start_time time,
    end_time time,
    title varchar(200) NOT NULL,
    location varchar(300),
    note varchar(500),
    source varchar(10) NOT NULL DEFAULT 'import' CHECK (source IN ('import','manual')),
    import_id uuid REFERENCES attendance_imports(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    created_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    voided_at timestamptz,
    voided_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CHECK (end_time IS NULL OR start_time IS NOT NULL)
  )`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS attendance_tasks_once
    ON attendance_tasks (employee_id, work_date, COALESCE(start_time, '00:00'::time), COALESCE(end_time, '00:00'::time))
    WHERE voided_at IS NULL`);
  await run('CREATE INDEX IF NOT EXISTS attendance_tasks_import_id_idx ON attendance_tasks (import_id)');
  await run('ALTER TABLE attendance_days ADD COLUMN IF NOT EXISTS task_title varchar(200)');

  // Leave that came from the fingerprint system's leave export.
  await run(`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS source varchar(10) NOT NULL DEFAULT 'request'`);
  await run(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_requests_source_check') THEN
      ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_source_check CHECK (source IN ('request','import'));
    END IF;
  END $$`);
  await run(`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS import_id uuid
    REFERENCES attendance_imports(id) ON UPDATE CASCADE ON DELETE RESTRICT`);
  await run('CREATE INDEX IF NOT EXISTS leave_requests_import_id_idx ON leave_requests (import_id)');

  // Two identical indexes on employees.manager_id (0003 and 0008); keep one.
  await run('DROP INDEX IF EXISTS employees_manager_id_idx');
}
