import type { MigrationContext } from '../migrator';

/**
 * One-time links for setting a password. Only a hash of the token is kept;
 * a link works once and expires after a short time.
 */
export async function up({ sequelize }: MigrationContext): Promise<void> {
  await sequelize.query(`CREATE TABLE IF NOT EXISTS password_setup_tokens (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    token_hash char(64) NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
}
