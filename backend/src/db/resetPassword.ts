import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { sequelize } from '../models';
import { execute, selectOne } from './query';

/**
 * Sets a new password for an account from the server console. The password
 * is typed at a hidden prompt, so it never appears on screen, in the shell
 * history or anywhere else. Clears a lockout and signs out existing sessions.
 *
 *   docker compose -f docker-compose.prod.yml exec api node dist/db/resetPassword.js you@company.com
 */
const pending: string[] = [];
let current = '';
let waiting: ((line: string) => void) | null = null;

function feed(chunk: string): void {
  for (const char of chunk) {
    if (char === '\u0003') process.exit(130);
    if (char === '\r' || char === '\n') {
      if (char === '\n' && current === '' && pending.length === 0 && !waiting) continue;
      process.stdout.write('\n');
      const line = current;
      current = '';
      if (waiting) { const done = waiting; waiting = null; done(line); } else pending.push(line);
    } else if (char === '\u007f' || char === '\b') current = current.slice(0, -1);
    else current += char;
  }
}

function askHidden(question: string): Promise<string> {
  process.stdout.write(question);
  if (pending.length) return Promise.resolve(pending.shift()!);
  return new Promise((resolve) => { waiting = resolve; });
}

async function main(): Promise<void> {
  process.stdin.setRawMode?.(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', feed);
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email) throw new Error('Usage: node dist/db/resetPassword.js <email>');
  const user = await selectOne<{ id: string }>('SELECT id FROM users WHERE lower(email) = :email', { email });
  if (!user) throw new Error(`No account with e-mail ${email}`);
  const first = await askHidden('New password (12+ characters): ');
  if (first.length < 12) throw new Error('The password must be at least 12 characters.');
  const second = await askHidden('Repeat it: ');
  if (first !== second) throw new Error('The two entries differ; nothing was changed.');
  await execute(
    `UPDATE users SET password_hash = :hash, failed_logins = 0, locked_until = NULL,
            token_version = token_version + 1, is_active = true, updated_at = now() WHERE id = :id`,
    { hash: await bcrypt.hash(first, 12), id: user.id },
  );
  await execute(
    `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details, created_at)
     VALUES (:id, :userId, 'auth.password_reset_console', 'user', :userId, NULL, now())`,
    { id: randomUUID(), userId: user.id },
  );
  console.log('Password changed. Sign in with the new password.');
}

function finish(code: number): void {
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
  process.exitCode = code;
}

void main().then(async () => { await sequelize.close(); finish(0); }).catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await sequelize.close().catch(() => undefined);
  finish(1);
});
