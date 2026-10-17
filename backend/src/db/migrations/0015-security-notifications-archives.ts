import type { MigrationContext } from '../migrator';

/**
 * Security guard (sign-in trail with location, security events and alerts,
 * tamper-evident audit chain, idle sign-out), in-app notifications, the
 * document archive, the payroll archive for the months before the system
 * went live, and separation details for the former-employees archive.
 */
export async function up({ sequelize }: MigrationContext): Promise<void> {
  const statements = [
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz',

    `CREATE TABLE IF NOT EXISTS notifications (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      kind varchar(30) NOT NULL,
      title varchar(200) NOT NULL,
      body varchar(1000),
      link varchar(300),
      created_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz
    )`,
    'CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL',

    `CREATE TABLE IF NOT EXISTS login_events (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      channel varchar(10) NOT NULL CHECK (channel IN ('portal','staff')),
      at timestamptz NOT NULL DEFAULT now(),
      ip varchar(64),
      user_agent varchar(400),
      latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
      longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
      accuracy_m integer CHECK (accuracy_m >= 0),
      location_at timestamptz,
      location_status varchar(12) NOT NULL DEFAULT 'pending' CHECK (location_status IN ('pending','shared','denied','unavailable'))
    )`,
    'CREATE INDEX IF NOT EXISTS login_events_user_idx ON login_events (user_id, at DESC)',
    'CREATE INDEX IF NOT EXISTS login_events_at_idx ON login_events (at DESC)',

    `CREATE TABLE IF NOT EXISTS security_events (
      id bigserial PRIMARY KEY,
      at timestamptz NOT NULL DEFAULT now(),
      kind varchar(30) NOT NULL,
      user_id uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
      ip varchar(64),
      path varchar(300),
      details jsonb
    )`,
    'CREATE INDEX IF NOT EXISTS security_events_at_idx ON security_events (at DESC)',
    'CREATE INDEX IF NOT EXISTS security_events_kind_idx ON security_events (kind, at DESC)',

    `CREATE TABLE IF NOT EXISTS security_alerts (
      id uuid PRIMARY KEY,
      at timestamptz NOT NULL DEFAULT now(),
      severity varchar(8) NOT NULL CHECK (severity IN ('low','medium','high','critical')),
      kind varchar(40) NOT NULL,
      title varchar(200) NOT NULL,
      details jsonb,
      user_id uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
      ip varchar(64),
      fingerprint varchar(200) NOT NULL,
      resolved_at timestamptz,
      resolved_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      resolution varchar(500)
    )`,
    // One open alert per fingerprint, so a repeating pattern raises one alert, not hundreds.
    'CREATE UNIQUE INDEX IF NOT EXISTS security_alerts_open_uidx ON security_alerts (fingerprint) WHERE resolved_at IS NULL',
    'CREATE INDEX IF NOT EXISTS security_alerts_at_idx ON security_alerts (at DESC)',

    // Tamper-evident audit trail: every entry carries the hash of the one before it.
    'ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS seq bigserial',
    'ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS prev_hash char(64)',
    'ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS hash char(64)',
    'CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_seq_uidx ON audit_logs (seq)',
    `CREATE OR REPLACE FUNCTION audit_log_digest(prev text, row_id uuid, actor uuid, act text, etype text, eid uuid, det jsonb, addr text, created timestamptz)
     RETURNS char(64) LANGUAGE sql IMMUTABLE AS $$
       SELECT encode(sha256(convert_to(
         coalesce(prev, '') || '|' || row_id::text || '|' || coalesce(actor::text, '') || '|' || act || '|' || etype || '|' ||
         coalesce(eid::text, '') || '|' || coalesce(det::text, '') || '|' || coalesce(addr, '') || '|' ||
         to_char(created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex')
     $$`,
    `CREATE OR REPLACE FUNCTION audit_logs_chain() RETURNS trigger AS $$
     DECLARE last_hash char(64);
     BEGIN
       PERFORM pg_advisory_xact_lock(727275);
       SELECT hash INTO last_hash FROM audit_logs ORDER BY seq DESC LIMIT 1;
       NEW.seq := nextval(pg_get_serial_sequence('audit_logs', 'seq'));
       NEW.prev_hash := last_hash;
       NEW.hash := audit_log_digest(last_hash, NEW.id, NEW.user_id, NEW.action, NEW.entity_type, NEW.entity_id, NEW.details, NEW.ip, NEW.created_at);
       RETURN NEW;
     END $$ LANGUAGE plpgsql`,
  ];
  for (const statement of statements) await sequelize.query(statement);

  // Chain the entries written before this migration, oldest first.
  await sequelize.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_change');
  await sequelize.query(`DO $$
    DECLARE r record; last_hash char(64) := NULL; n bigint := 0;
    BEGIN
      FOR r IN SELECT * FROM audit_logs ORDER BY created_at, seq LOOP
        n := n + 1;
        UPDATE audit_logs SET seq = -n, prev_hash = last_hash,
          hash = audit_log_digest(last_hash, r.id, r.user_id, r.action, r.entity_type, r.entity_id, r.details, r.ip, r.created_at)
        WHERE id = r.id RETURNING hash INTO last_hash;
      END LOOP;
      UPDATE audit_logs SET seq = -seq;
      PERFORM setval(pg_get_serial_sequence('audit_logs', 'seq'), GREATEST(n, 1), n > 0);
    END $$`);
  await sequelize.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_change');
  await sequelize.query('DROP TRIGGER IF EXISTS audit_logs_chain ON audit_logs');
  await sequelize.query('CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_chain()');

  const more = [
    `CREATE TABLE IF NOT EXISTS archive_documents (
      id uuid PRIMARY KEY,
      title varchar(200) NOT NULL,
      category varchar(30) NOT NULL,
      employee_id uuid REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      department_id uuid REFERENCES departments(id) ON UPDATE CASCADE ON DELETE SET NULL,
      doc_date date,
      reference varchar(80),
      tags varchar(300),
      notes varchar(1000),
      storage_key varchar(300) NOT NULL,
      original_name varchar(255) NOT NULL,
      mime_type varchar(120) NOT NULL,
      size_bytes bigint NOT NULL,
      sha256 char(64) NOT NULL,
      confidential boolean NOT NULL DEFAULT false,
      uploaded_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      withdrawn_at timestamptz,
      withdrawn_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      withdraw_reason varchar(300)
    )`,
    'CREATE INDEX IF NOT EXISTS archive_documents_employee_idx ON archive_documents (employee_id) WHERE withdrawn_at IS NULL',
    'CREATE INDEX IF NOT EXISTS archive_documents_created_idx ON archive_documents (created_at DESC)',

    `CREATE TABLE IF NOT EXISTS payroll_archive_months (
      id uuid PRIMARY KEY,
      period char(7) NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      label varchar(120) NOT NULL,
      branch_id uuid REFERENCES branches(id) ON UPDATE CASCADE ON DELETE SET NULL,
      storage_key varchar(300) NOT NULL,
      original_name varchar(255) NOT NULL,
      sha256 char(64) NOT NULL,
      employee_count integer NOT NULL,
      totals jsonb NOT NULL,
      notes varchar(500),
      uploaded_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      withdrawn_at timestamptz,
      withdrawn_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT
    )`,
    // The same file cannot be archived twice for the same month.
    'CREATE UNIQUE INDEX IF NOT EXISTS payroll_archive_months_file_uidx ON payroll_archive_months (period, sha256) WHERE withdrawn_at IS NULL',
    `CREATE TABLE IF NOT EXISTS payroll_archive_lines (
      id bigserial PRIMARY KEY,
      month_id uuid NOT NULL REFERENCES payroll_archive_months(id) ON UPDATE CASCADE ON DELETE CASCADE,
      employee_id uuid REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL,
      employee_no varchar(40) NOT NULL,
      employee_name varchar(200),
      currency char(3) NOT NULL,
      gross numeric(16,2),
      total_earnings numeric(16,2),
      total_deductions numeric(16,2),
      net_pay numeric(16,2) NOT NULL,
      details jsonb
    )`,
    'CREATE INDEX IF NOT EXISTS payroll_archive_lines_month_idx ON payroll_archive_lines (month_id)',
    'CREATE INDEX IF NOT EXISTS payroll_archive_lines_employee_idx ON payroll_archive_lines (employee_id)',

    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS separation_reason varchar(20)
      CHECK (separation_reason IN ('resignation','termination','end_of_contract','retirement','death','absconded','other'))`,
    'ALTER TABLE employees ADD COLUMN IF NOT EXISTS separation_note varchar(1000)',
    'ALTER TABLE employees ADD COLUMN IF NOT EXISTS separated_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    'ALTER TABLE employees ADD COLUMN IF NOT EXISTS separated_at timestamptz',

    `CREATE TABLE IF NOT EXISTS calendar_events (
      id uuid PRIMARY KEY,
      title varchar(200) NOT NULL,
      description varchar(2000),
      category varchar(12) NOT NULL CHECK (category IN ('meeting','training','event','deadline','holiday','visit','other')),
      starts_at timestamp NOT NULL,
      ends_at timestamp NOT NULL,
      all_day boolean NOT NULL DEFAULT false,
      visibility varchar(8) NOT NULL DEFAULT 'company' CHECK (visibility IN ('company','branch','private')),
      branch_id uuid REFERENCES branches(id) ON UPDATE CASCADE ON DELETE SET NULL,
      location varchar(200),
      color varchar(9),
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      cancelled_at timestamptz,
      CHECK (ends_at >= starts_at)
    )`,
    'CREATE INDEX IF NOT EXISTS calendar_events_range_idx ON calendar_events (starts_at, ends_at) WHERE cancelled_at IS NULL',

    // Announcements shown as a full screen to each employee in the audience.
    `CREATE TABLE IF NOT EXISTS announcements (
      id uuid PRIMARY KEY,
      title_ar varchar(200) NOT NULL,
      title_en varchar(200),
      body_ar text NOT NULL,
      body_en text,
      kind varchar(12) NOT NULL CHECK (kind IN ('announcement','alert','notice','invitation','circular')),
      severity varchar(10) NOT NULL DEFAULT 'info' CHECK (severity IN ('info','important','urgent')),
      audience varchar(12) NOT NULL CHECK (audience IN ('all','branch','department','employees')),
      branch_id uuid REFERENCES branches(id) ON UPDATE CASCADE ON DELETE SET NULL,
      department_id uuid REFERENCES departments(id) ON UPDATE CASCADE ON DELETE SET NULL,
      employee_ids uuid[],
      require_ack boolean NOT NULL DEFAULT false,
      starts_at timestamptz NOT NULL DEFAULT now(),
      ends_at timestamptz,
      signed_by_title varchar(120),
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      withdrawn_at timestamptz
    )`,
    `CREATE TABLE IF NOT EXISTS announcement_receipts (
      announcement_id uuid NOT NULL REFERENCES announcements(id) ON UPDATE CASCADE ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      seen_at timestamptz NOT NULL DEFAULT now(),
      acknowledged_at timestamptz,
      PRIMARY KEY (announcement_id, user_id)
    )`,

    // Outside channels. Secrets are encrypted; nothing is sent while a channel is disabled.
    `CREATE TABLE IF NOT EXISTS message_channels (
      channel varchar(10) PRIMARY KEY CHECK (channel IN ('email','whatsapp','sms')),
      enabled boolean NOT NULL DEFAULT false,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      secret_enc text,
      updated_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS outbound_messages (
      id uuid PRIMARY KEY,
      channel varchar(10) NOT NULL CHECK (channel IN ('email','whatsapp','sms')),
      recipient varchar(254) NOT NULL,
      employee_id uuid REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL,
      subject varchar(200),
      body text NOT NULL,
      related_kind varchar(30),
      related_id uuid,
      status varchar(10) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','skipped')),
      attempts integer NOT NULL DEFAULT 0,
      error varchar(500),
      created_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz
    )`,
    'CREATE INDEX IF NOT EXISTS outbound_messages_queue_idx ON outbound_messages (created_at) WHERE status = \'queued\'',

    // Who did what, where and when: every request and every screen visited.
    `CREATE TABLE IF NOT EXISTS activity_log (
      id bigserial PRIMARY KEY,
      at timestamptz NOT NULL DEFAULT now(),
      user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      kind varchar(6) NOT NULL CHECK (kind IN ('visit','read','write')),
      module varchar(30) NOT NULL,
      method varchar(7),
      path varchar(300) NOT NULL,
      status smallint,
      duration_ms integer,
      ip varchar(64)
    )`,
    'CREATE INDEX IF NOT EXISTS activity_log_user_idx ON activity_log (user_id, at DESC)',
    'CREATE INDEX IF NOT EXISTS activity_log_module_idx ON activity_log (module, at DESC)',
    'CREATE INDEX IF NOT EXISTS activity_log_at_idx ON activity_log (at DESC)',

    // Recycle bin: deleted records keep a full copy and can be restored.
    `CREATE TABLE IF NOT EXISTS recycle_bin (
      id uuid PRIMARY KEY,
      entity_type varchar(40) NOT NULL,
      entity_id uuid NOT NULL,
      title varchar(300) NOT NULL,
      module varchar(30) NOT NULL,
      payload jsonb NOT NULL,
      reason varchar(300),
      deleted_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      deleted_at timestamptz NOT NULL DEFAULT now(),
      restored_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      restored_at timestamptz,
      purged_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      purged_at timestamptz
    )`,
    'CREATE INDEX IF NOT EXISTS recycle_bin_open_idx ON recycle_bin (deleted_at DESC) WHERE restored_at IS NULL AND purged_at IS NULL',
  ];
  for (const statement of more) await sequelize.query(statement);
}
