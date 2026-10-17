import express, { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import helmet from 'helmet';
import routes from './routes';
import { asyncRoute, HttpError } from './utils/http';
import DevicePushController from './controllers/DevicePushController';
import { trackActivity } from './services/activity';
import { firewall } from './services/firewall';

/** The release this server runs (package.json), so open tabs can offer a reload after an update. */
export const APP_VERSION: string = (() => {
  try { return String(JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version); } catch { return '0.0.0'; }
})();

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
  app.use(helmet({
    // The same policy nginx sends with the pages in production (frontend/nginx.conf; a test keeps
    // the two equal), so a page that breaks it fails the screen check here too, not only in production.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'connect-src': ["'self'"],
        // Employee photos are served by the API as blobs and QR codes are drawn
        // into data URLs, so both need to be allowed as image sources.
        'img-src': ["'self'", 'data:', 'blob:'],
        'font-src': ["'self'"],
        'frame-src': ['blob:', 'https://www.openstreetmap.org'],
        'worker-src': ["'self'"],
        'manifest-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'self'"],
      },
    },
  }));
  // Fingerprint devices (ZKTeco ADMS) push plain-text logs to fixed /iclock paths.
  const deviceText = express.text({ type: '*/*', limit: '5mb' });
  app.get('/iclock/cdata', asyncRoute(DevicePushController.handshake));
  app.post('/iclock/cdata', deviceText, asyncRoute(DevicePushController.upload));
  app.get('/iclock/getrequest', asyncRoute(DevicePushController.poll));
  app.post('/iclock/devicecmd', deviceText, asyncRoute(DevicePushController.poll));

  // The job description export from the performance portal is the largest body (~0.5 MB for 60 jobs).
  app.use(express.json({ limit: '5mb' }));
  // Application firewall (blocked addresses, attack patterns, rate per address).
  app.use('/api', firewall);
  // Who did what and when, for every signed-in request.
  app.use('/api', trackActivity);
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: APP_VERSION }));
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
    if (error instanceof HttpError) {
      res.status(error.status).json({ message: error.message, ...(error.details ? { details: error.details } : {}) });
      return;
    }
    const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
    if (name === 'SequelizeUniqueConstraintError') {
      res.status(409).json({ message: 'هذا الرمز أو الرقم مستخدم مسبقاً.' });
      return;
    }
    if (name === 'SequelizeValidationError') {
      res.status(400).json({ message: 'تحقق من الحقول المدخلة ثم حاول مجدداً.' });
      return;
    }
    if (name === 'SequelizeForeignKeyConstraintError') {
      res.status(409).json({ message: 'لا يمكن تنفيذ العملية لأن السجل مرتبط ببيانات أخرى.' });
      return;
    }
    if (name === 'MulterError') {
      res.status(400).json({ message: 'الملف المرفوع غير مقبول أو يتجاوز الحجم المسموح.' });
      return;
    }
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.parse.failed') {
      res.status(400).json({ message: 'صيغة البيانات المرسلة غير صحيحة.' });
      return;
    }
    console.error('Request failed:', error instanceof Error ? `${error.name}: ${error.message}` : 'UnknownError');
    res.status(500).json({ message: 'حدث خطأ داخلي. حاول مجدداً أو تواصل مع مسؤول النظام.' });
  });
  return app;
}
