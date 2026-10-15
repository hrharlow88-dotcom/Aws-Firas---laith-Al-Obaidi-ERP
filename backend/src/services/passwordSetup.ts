import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { execute, selectOne, transaction } from '../db/query';

export const SETUP_LINK_MINUTES = 30;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Creates a one-time token for the account; earlier unused links stop working. */
export async function createSetupToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await transaction(async (tx) => {
    await execute('UPDATE password_setup_tokens SET used_at = now() WHERE user_id = :userId AND used_at IS NULL', { userId }, tx);
    await execute(
      `INSERT INTO password_setup_tokens (id, user_id, token_hash, expires_at)
       VALUES (:id, :userId, :hash, now() + make_interval(mins => :minutes))`,
      { id: randomUUID(), userId, hash: hashToken(token), minutes: SETUP_LINK_MINUTES }, tx,
    );
  });
  return token;
}

/**
 * Sets the password with a one-time token. Returns the account's e-mail, or
 * null when the token is unknown, used or expired.
 */
export async function useSetupToken(token: string, password: string, ip: string | null): Promise<string | null> {
  const passwordHash = await bcrypt.hash(password, 12);
  return transaction(async (tx) => {
    const row = await selectOne<{ id: string; userId: string; email: string }>(
      `SELECT t.id, t.user_id AS "userId", u.email FROM password_setup_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = :hash AND t.used_at IS NULL AND t.expires_at > now() FOR UPDATE OF t`,
      { hash: hashToken(token) }, tx,
    );
    if (!row) return null;
    await execute('UPDATE password_setup_tokens SET used_at = now() WHERE id = :id', { id: row.id }, tx);
    await execute(
      `UPDATE users SET password_hash = :passwordHash, failed_logins = 0, locked_until = NULL,
              token_version = token_version + 1, updated_at = now() WHERE id = :userId`,
      { passwordHash, userId: row.userId }, tx,
    );
    await execute(
      `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details, ip, created_at)
       VALUES (:id, :userId, 'auth.password_set_by_link', 'user', :userId, NULL, :ip, now())`,
      { id: randomUUID(), userId: row.userId, ip }, tx,
    );
    return row.email;
  });
}
