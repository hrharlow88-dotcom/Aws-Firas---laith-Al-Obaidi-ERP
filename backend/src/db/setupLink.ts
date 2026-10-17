import 'dotenv/config';
import { sequelize } from '../models';
import { SETUP_LINK_MINUTES, createSetupToken } from '../services/passwordSetup';
import { runMigrations } from './migrator';
import { selectOne } from './query';

/**
 * Prints a one-time link that lets the account holder choose their own
 * password in the browser (valid for 30 minutes, works once).
 *
 *   docker compose -f docker-compose.prod.yml exec api node dist/db/setupLink.js you@company.com
 */
async function main(): Promise<void> {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email) throw new Error('Usage: node dist/db/setupLink.js <email>');
  await runMigrations();
  const user = await selectOne<{ id: string }>('SELECT id FROM users WHERE lower(email) = :email AND is_active', { email });
  if (!user) throw new Error(`No active account with e-mail ${email}`);
  const token = await createSetupToken(user.id);
  const base = process.env.PUBLIC_URL || (process.env.ERP_DOMAIN ? `https://${process.env.ERP_DOMAIN}` : '');
  console.log(`\n${base}/#/set-password/${token}\n\nValid for ${SETUP_LINK_MINUTES} minutes, once.`);
}

void main().then(() => sequelize.close()).catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await sequelize.close().catch(() => undefined);
  process.exitCode = 1;
});
