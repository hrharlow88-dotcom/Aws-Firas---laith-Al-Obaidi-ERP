import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { User, sequelize } from './models';
import { runMigrations } from './db/migrator';
import { createApp } from './app';
import { registerJob, startBackgroundJobs } from './jobs';
import { processJournalQueue } from './services/finance';
import { sapConfigured } from './services/sapB1';

function validateEnvironment(): void {
  const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if ((process.env.JWT_SECRET || '').length < 32) {
    throw new Error('JWT_SECRET must contain at least 32 characters.');
  }
  if ((process.env.ADMIN_PASSWORD || '').length < 12) {
    throw new Error('ADMIN_PASSWORD must contain at least 12 characters (wrap values containing # in quotes).');
  }
  if (Buffer.byteLength(process.env.ADMIN_PASSWORD || '', 'utf8') > 72) {
    throw new Error('ADMIN_PASSWORD must not exceed 72 UTF-8 bytes.');
  }
  const placeholders = ['DB_PASSWORD', 'JWT_SECRET', 'ADMIN_PASSWORD']
    .filter((key) => (process.env[key] || '').startsWith('replace-with-'));
  if (placeholders.length) {
    throw new Error(`Replace placeholder values before starting: ${placeholders.join(', ')}`);
  }
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) || adminEmail === 'admin@example.com') {
    throw new Error('Set ADMIN_EMAIL to a valid company administrator address.');
  }
}

async function ensureAdministrator(): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL!.trim().toLowerCase();
  const existingAdmin = await User.findOne({ where: { email: adminEmail } });
  if (!existingAdmin) {
    await User.create({
      name: process.env.ADMIN_NAME || 'System Administrator',
      email: adminEmail,
      passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD!, 12),
      role: 'super_admin',
      branchId: null,
    });
  } else if (existingAdmin.role !== 'super_admin') {
    throw new Error('ADMIN_EMAIL already belongs to a non-administrator account.');
  }
}

async function start(): Promise<void> {
  validateEnvironment();
  await sequelize.authenticate();
  const applied = await runMigrations();
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  await ensureAdministrator();

  const app = createApp();
  const port = Number(process.env.PORT || 5000);
  app.listen(port, '0.0.0.0', () => console.log(`ERP API listening on ${port}`));
  if (sapConfigured()) {
    registerJob({ name: 'sap-journal-queue', everyMs: 30000, run: async () => { await processJournalQueue(); } });
  }
  startBackgroundJobs();
}

void start().catch((error: unknown) => {
  console.error('ERP API could not start:', error instanceof Error ? error.message : 'UnknownError');
  process.exit(1);
});
