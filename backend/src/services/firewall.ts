import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { execute, select } from '../db/query';
import { getSettings } from './settings';
import { recordSecurityEvent } from './security';

/**
 * Application firewall in front of the API:
 *  1. blocked addresses (by the owner, or automatically by the security guard) get 403;
 *  2. requests carrying attack patterns (SQL injection, path traversal, script
 *     injection, JNDI lookups) are refused and logged;
 *  3. one address may send at most N requests a minute.
 */
const ATTACKS: Array<[string, RegExp]> = [
  ['path_traversal', /(\.\.[/\\])|(%2e%2e(%2f|%5c|\/))|\/etc\/passwd|win\.ini/i],
  ['script_injection', /<\s*script\b|javascript:\s*[a-z]|on(error|load)\s*=\s*['"]?\w/i],
  ['sql_injection', /\bunion\b[\s(]+(all\s+)?select\b|;\s*(drop|alter|truncate)\s+table\b|\b(or|and)\s+['"]?1['"]?\s*=\s*['"]?1\b|\bsleep\s*\(\s*\d+\s*\)|pg_sleep\s*\(/i],
  ['jndi', /\$\{\s*jndi\s*:/i],
];

let blocked = new Map<string, number | null>();
let loadedAt = 0;

export async function refreshBlocks(): Promise<void> {
  const rows = await select<{ ip: string; until: Date | null }>(
    'SELECT ip, blocked_until AS until FROM ip_blocks WHERE lifted_at IS NULL AND (blocked_until IS NULL OR blocked_until > now())',
  );
  blocked = new Map(rows.map((row) => [row.ip, row.until ? new Date(row.until).getTime() : null]));
  loadedAt = Date.now();
}

export async function blockIp(ip: string, reason: string, minutes: number | null, userId: string | null, automatic: boolean): Promise<boolean> {
  const rows = await execute<{ id: string }>(
    `INSERT INTO ip_blocks (id, ip, reason, automatic, blocked_until, created_by)
     VALUES (:id, :ip, :reason, :automatic, CASE WHEN :minutes::int IS NULL THEN NULL ELSE now() + make_interval(mins => :minutes::int) END, :userId)
     ON CONFLICT (ip) WHERE lifted_at IS NULL DO NOTHING RETURNING id`,
    { id: randomUUID(), ip: ip.slice(0, 64), reason: reason.slice(0, 300), automatic, minutes, userId },
  );
  await refreshBlocks();
  return rows.length > 0;
}

export function attackIn(text: string): string | null {
  for (const [kind, pattern] of ATTACKS) if (pattern.test(text)) return kind;
  return null;
}

const windows = new Map<string, { minute: number; count: number; warned: boolean }>();

function decoded(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function firewall(req: Request, res: Response, next: NextFunction): void {
  void (async () => {
    if (Date.now() - loadedAt > 30000) await refreshBlocks().catch(() => undefined);
    const ip = (req.ip || '').slice(0, 64);
    const until = blocked.get(ip);
    if (until !== undefined && (until === null || until > Date.now())) {
      void execute('UPDATE ip_blocks SET hits = hits + 1 WHERE ip = :ip AND lifted_at IS NULL', { ip }).catch(() => undefined);
      res.status(403).json({ message: 'تم حظر هذا العنوان من جدار الحماية. تواصل مع مالك النظام.' });
      return;
    }
    const settings = await getSettings();
    if (settings.security.wafEnabled) {
      const body = req.body && typeof req.body === 'object' ? JSON.stringify(req.body).slice(0, 20000) : '';
      const kind = attackIn(decoded(req.originalUrl)) ?? (body ? attackIn(body) : null);
      if (kind) {
        void recordSecurityEvent('waf_blocked', req, { kind, path: req.originalUrl.slice(0, 200) });
        res.status(403).json({ message: 'رُفض الطلب لأنه يحتوي نمطاً خطراً.' });
        return;
      }
    }
    if (!process.env.VITEST) {
      const minute = Math.floor(Date.now() / 60000);
      const entry = windows.get(ip);
      if (!entry || entry.minute !== minute) windows.set(ip, { minute, count: 1, warned: false });
      else if (++entry.count > settings.security.requestsPerMinute) {
        if (!entry.warned) { entry.warned = true; void recordSecurityEvent('rate_limited', req, { count: entry.count }); }
        res.status(429).json({ message: 'طلبات كثيرة من هذا العنوان. انتظر دقيقة.' });
        return;
      }
      if (windows.size > 20000) windows.clear();
    }
    next();
  })().catch(next);
}
