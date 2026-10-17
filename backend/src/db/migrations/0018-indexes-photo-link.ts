import type { MigrationContext } from '../migrator';

/**
 * Indexes for the link columns that screens filter and join on (found missing
 * in the v1.1 audit), and a real foreign key from an employee to the document
 * that is their photo, cleared if that document ever disappears.
 */
const INDEXES: Array<[string, string]> = [
  ['approval_actions', 'request_id'],
  ['approval_requests', 'employee_id'],
  ['approval_requests', 'requester_id'],
  ['approval_requests', 'category_id'],
  ['expense_lines', 'request_id'],
  ['ticket_comments', 'ticket_id'],
  ['tickets', 'requester_employee_id'],
  ['tickets', 'assignee_user_id'],
  ['payroll_inputs', 'employee_id'],
  ['payroll_day_adjustments', 'employee_id'],
  ['attendance_days', 'payroll_run_id'],
  ['attendance_punches', 'import_id'],
  ['attendance_punches', 'device_id'],
  ['leave_approvals', 'request_id'],
  ['employee_requests', 'loan_id'],
  ['chat_messages', 'user_id'],
  ['applicant_activities', 'applicant_id'],
  ['announcement_receipts', 'user_id'],
  ['security_events', 'user_id'],
  ['security_alerts', 'user_id'],
  ['password_setup_tokens', 'user_id'],
  ['employees', 'job_title_id'],
  ['employees', 'shift_id'],
  ['departments', 'branch_id'],
  ['job_titles', 'department_id'],
  ['payroll_runs', 'branch_id'],
  ['payroll_runs', 'governorate_id'],
  ['outbound_messages', 'employee_id'],
  ['users', 'branch_id'],
];

export async function up({ sequelize }: MigrationContext): Promise<void> {
  for (const [table, column] of INDEXES) {
    await sequelize.query(`CREATE INDEX IF NOT EXISTS ${table}_${column}_idx ON ${table} (${column})`);
  }
  // A photo pointer to a document that no longer exists is cleared first, then guarded.
  await sequelize.query(`UPDATE employees e SET photo_document_id = NULL
    WHERE photo_document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employee_documents d WHERE d.id = e.photo_document_id)`);
  await sequelize.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_photo_document_id_fkey') THEN
      ALTER TABLE employees ADD CONSTRAINT employees_photo_document_id_fkey
        FOREIGN KEY (photo_document_id) REFERENCES employee_documents(id) ON UPDATE CASCADE ON DELETE SET NULL;
    END IF;
  END $$`);
}
