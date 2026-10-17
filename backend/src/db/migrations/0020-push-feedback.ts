import type { MigrationContext } from '../migrator';

/**
 * v2.0: notifications pushed to phones and computers (Web Push), and notes
 * on the system that any user sends to the owner.
 */
export async function up({ sequelize }: MigrationContext): Promise<void> {
  const run = (sql: string) => sequelize.query(sql);

  // Push is one more outside channel, off until the owner switches it on.
  await run('ALTER TABLE message_channels DROP CONSTRAINT IF EXISTS message_channels_channel_check');
  await run(`ALTER TABLE message_channels ADD CONSTRAINT message_channels_channel_check
    CHECK (channel IN ('email','whatsapp','sms','push'))`);

  // One row per browser or installed app that agreed to receive notifications.
  await run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    endpoint text NOT NULL UNIQUE,
    p256dh varchar(200) NOT NULL,
    auth varchar(100) NOT NULL,
    device varchar(200),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_success_at timestamptz,
    failures integer NOT NULL DEFAULT 0
  )`);
  await run('CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx ON push_subscriptions (user_id)');

  // Notes on the system: a fault, an idea or a question, with the screen it came from.
  await run('CREATE SEQUENCE IF NOT EXISTS feedback_ref_seq');
  await run(`CREATE TABLE IF NOT EXISTS feedback (
    id uuid PRIMARY KEY,
    ref_no varchar(20) NOT NULL UNIQUE,
    user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    kind varchar(10) NOT NULL CHECK (kind IN ('bug','idea','question')),
    message varchar(2000) NOT NULL,
    page varchar(200),
    app_version varchar(20),
    device varchar(300),
    viewport varchar(20),
    storage_key varchar(300),
    mime_type varchar(60),
    status varchar(12) NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','done','declined')),
    owner_note varchar(1000),
    handled_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await run('CREATE INDEX IF NOT EXISTS feedback_status_idx ON feedback (status, created_at DESC)');
  await run('CREATE INDEX IF NOT EXISTS feedback_user_id_idx ON feedback (user_id)');
}
