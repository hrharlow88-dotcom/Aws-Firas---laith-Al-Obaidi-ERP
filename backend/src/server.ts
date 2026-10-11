import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import { User, sequelize } from './models';
import routes from './routes';

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
    throw new Error('ADMIN_PASSWORD must contain at least 12 characters.');
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

async function start(): Promise<void> {
  validateEnvironment();
  await sequelize.authenticate();
  await sequelize.sync();
  await sequelize.query(
    "ALTER TABLE employees ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb",
  );
  await sequelize.query(
    'ALTER TABLE IF EXISTS leave_requests ADD COLUMN IF NOT EXISTS medical_certificate_reference VARCHAR(180)',
  );

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

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api', routes);
  const frontendDist = path.resolve(__dirname, '../../frontend/dist');
  app.use(express.static(frontendDist, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ message: 'المسار المطلوب غير موجود.' });
      return;
    }
    res.sendFile(path.join(frontendDist, 'index.html'), (error) => {
      if (error) next(error);
    });
  });
  app.use((_req, res) => res.status(404).json({ message: 'المسار المطلوب غير موجود.' }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'SequelizeUniqueConstraintError') {
      res.status(409).json({ message: 'هذا الرمز أو الرقم مستخدم مسبقاً.' });
      return;
    }
    if (error && typeof error === 'object' && 'name' in error && error.name === 'SequelizeValidationError') {
      res.status(400).json({ message: 'تحقق من الحقول المدخلة ثم حاول مجدداً.' });
      return;
    }
    console.error('Request failed:', error instanceof Error ? error.name : 'UnknownError');
    res.status(500).json({ message: 'حدث خطأ داخلي. حاول مجدداً أو تواصل مع مسؤول النظام.' });
  });

  const port = Number(process.env.PORT || 5000);
  app.listen(port, '0.0.0.0', () => console.log(`ERP API listening on ${port}`));
}

void start().catch((error: unknown) => {
  console.error('ERP API could not start:', error instanceof Error ? error.message : 'UnknownError');
  process.exit(1);
});
