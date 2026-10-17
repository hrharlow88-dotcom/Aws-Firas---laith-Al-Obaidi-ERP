import { NextFunction, Request, Response } from 'express';
import { execute } from '../db/query';
import { recordSecurityEvent } from './security';

/** API path prefix → app id (the same ids as the home-screen apps). */
const MODULES: Array<[RegExp, string]> = [
  [/^\/(me|portal)\b/, 'me'],
  [/^\/employees\/former|^\/archive\b/, 'archive'],
  [/^\/(employees|branches|org|contracts|documents|hr)\b/, 'employees'],
  [/^\/requests\b/, 'requests'],
  [/^\/discipline\b/, 'register'],
  [/^\/recruitment\b/, 'recruitment'],
  [/^\/tickets\b/, 'helpdesk'],
  [/^\/attendance\b/, 'attendance'],
  [/^\/leaves\b/, 'leaves'],
  [/^\/payroll\b/, 'payroll'],
  [/^\/finance\b/, 'finance'],
  [/^\/(audit|activity)\b/, 'audit'],
  [/^\/integrations\b/, 'integrations'],
  [/^\/calendar\b/, 'calendar'],
  [/^\/(announcements|messages|notifications)\b/, 'communication'],
  [/^\/(security|owner|recycle-bin)\b/, 'owner'],
  [/^\/(settings|users|admin)\b/, 'settings'],
  [/^\/approvals\b/, 'approvals'],
  [/^\/auth\b/, 'auth'],
];

export function moduleOf(path: string): string {
  return MODULES.find(([pattern]) => pattern.test(path))?.[1] ?? 'other';
}

/** Paths whose response is a file of people or salaries; the guard counts them. */
const EXPORTS = [/register\.xlsx$/, /bank\.csv$/, /export\.csv$/, /template\.xlsx$/, /\/file$/, /\/cv$/, /\/receipt$/];

/**
 * Records every signed-in API call (who, which module, what, when, how long,
 * the result) after the response is sent. Background polling is left out.
 */
export function trackActivity(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  res.on('finish', () => {
    const user = req.user;
    if (!user || req.header('x-background') === '1' || req.originalUrl.startsWith('/api/activity/visit')) return;
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const path = req.originalUrl.replace(/^\/api/, '').split('?')[0].slice(0, 300);
    void execute(
      `INSERT INTO activity_log (user_id, kind, module, method, path, status, duration_ms, ip)
       VALUES (:userId, :kind, :module, :method, :path, :status, :ms, :ip)`,
      {
        userId: user.id, kind: write ? 'write' : 'read', module: moduleOf(path), method: req.method, path,
        status: res.statusCode, ms: Date.now() - started, ip: (req.ip || '').slice(0, 64) || null,
      },
    ).catch(() => undefined);
    if (res.statusCode < 400 && req.method === 'GET' && EXPORTS.some((pattern) => pattern.test(path))) {
      void recordSecurityEvent('export', req, { path });
    }
  });
  next();
}
