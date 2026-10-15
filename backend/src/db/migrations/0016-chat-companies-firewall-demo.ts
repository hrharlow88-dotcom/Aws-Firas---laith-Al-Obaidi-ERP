import type { MigrationContext } from '../migrator';

/**
 * Internal chat, the group's companies, the firewall (blocked addresses),
 * and demo accounts.
 */
export async function up({ sequelize }: MigrationContext): Promise<void> {
  const statements = [
    // Companies of the group; branches belong to one.
    `CREATE TABLE IF NOT EXISTS companies (
      id uuid PRIMARY KEY,
      code varchar(24) NOT NULL UNIQUE,
      name_ar varchar(160) NOT NULL,
      name_en varchar(160),
      legal_name varchar(200),
      registration_no varchar(80),
      tax_no varchar(80),
      address varchar(240),
      phone varchar(40),
      email varchar(254),
      logo_key varchar(300),
      brand_ids text[] NOT NULL DEFAULT '{}',
      sort_order integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    'ALTER TABLE branches ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON UPDATE CASCADE ON DELETE SET NULL',
    'CREATE INDEX IF NOT EXISTS branches_company_idx ON branches (company_id)',

    // Chat.
    `CREATE TABLE IF NOT EXISTS chat_channels (
      id uuid PRIMARY KEY,
      kind varchar(8) NOT NULL CHECK (kind IN ('channel','direct')),
      name varchar(80),
      description varchar(300),
      is_private boolean NOT NULL DEFAULT false,
      direct_key varchar(80) UNIQUE,
      created_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz,
      last_message_at timestamptz
    )`,
    `CREATE TABLE IF NOT EXISTS chat_members (
      channel_id uuid NOT NULL REFERENCES chat_channels(id) ON UPDATE CASCADE ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      role varchar(8) NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
      joined_at timestamptz NOT NULL DEFAULT now(),
      last_read_at timestamptz,
      muted boolean NOT NULL DEFAULT false,
      PRIMARY KEY (channel_id, user_id)
    )`,
    'CREATE INDEX IF NOT EXISTS chat_members_user_idx ON chat_members (user_id)',
    `CREATE TABLE IF NOT EXISTS chat_messages (
      id uuid PRIMARY KEY,
      channel_id uuid NOT NULL REFERENCES chat_channels(id) ON UPDATE CASCADE ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      body text,
      reply_to uuid REFERENCES chat_messages(id) ON UPDATE CASCADE ON DELETE SET NULL,
      attachment_key varchar(300),
      attachment_name varchar(255),
      attachment_mime varchar(120),
      attachment_size bigint,
      reactions jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      edited_at timestamptz,
      deleted_at timestamptz
    )`,
    'CREATE INDEX IF NOT EXISTS chat_messages_channel_idx ON chat_messages (channel_id, created_at DESC)',

    // Firewall: blocked addresses (manual or automatic).
    `CREATE TABLE IF NOT EXISTS ip_blocks (
      id uuid PRIMARY KEY,
      ip varchar(64) NOT NULL,
      reason varchar(300) NOT NULL,
      automatic boolean NOT NULL DEFAULT false,
      blocked_until timestamptz,
      created_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      lifted_at timestamptz,
      lifted_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
      hits integer NOT NULL DEFAULT 0
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS ip_blocks_live_uidx ON ip_blocks (ip) WHERE lifted_at IS NULL',

    // Demo accounts: switched on and off by the owner, optionally expiring.
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_expires_at timestamptz',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS phone varchar(40)',
  ];
  for (const statement of statements) await sequelize.query(statement);
}
