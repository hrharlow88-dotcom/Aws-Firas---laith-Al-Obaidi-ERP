import { randomUUID } from 'node:crypto';
import { Request } from 'express';
import { execute, select, selectOne } from '../db/query';
import { getSettings } from './settings';
import { notifyUsers } from './notify';

/**
 * The security guard: a small rule engine that watches the sign-in trail,
 * refused requests, exports and the audit chain, and raises alerts for the
 * system owner. It works like an employee on duty: it never blocks anyone by
 * itself (account locking is already handled at sign-in); it reports, and the
 * owner decides (sign the person out, lock the account, or mark it handled).
 */

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export function clientIp(req: Request): string | null {
  return (req.ip || '').slice(0, 64) || null;
}

/** Raw events the guard reads. Writing one must never break the request that caused it. */
export async function recordSecurityEvent(kind: string, req: Request | null, details?: Record<string, unknown>, userId?: string | null): Promise<void> {
  try {
    await execute(
      'INSERT INTO security_events (kind, user_id, ip, path, details) VALUES (:kind, :userId, :ip, :path, :details)',
      {
        kind: kind.slice(0, 30),
        userId: userId ?? req?.user?.id ?? null,
        ip: req ? clientIp(req) : null,
        path: req ? `${req.method} ${req.originalUrl}`.slice(0, 300) : null,
        details: details ? JSON.stringify(details) : null,
      },
    );
  } catch (error) {
    console.error('Security event not recorded:', error instanceof Error ? error.message : error);
  }
}

/** Raises an alert unless one with the same fingerprint is still open. Returns true when it is new. */
export async function raiseAlert(input: {
  severity: Severity; kind: string; title: string; fingerprint: string;
  details?: Record<string, unknown>; userId?: string | null; ip?: string | null;
}): Promise<boolean> {
  const rows = await execute<{ id: string }>(
    `INSERT INTO security_alerts (id, severity, kind, title, details, user_id, ip, fingerprint)
     VALUES (:id, :severity, :kind, :title, :details, :userId, :ip, :fingerprint)
     ON CONFLICT (fingerprint) WHERE resolved_at IS NULL DO NOTHING
     RETURNING id`,
    {
      id: randomUUID(), severity: input.severity, kind: input.kind, title: input.title.slice(0, 200),
      details: input.details ? JSON.stringify(input.details) : null, userId: input.userId ?? null, ip: input.ip ?? null,
      fingerprint: input.fingerprint.slice(0, 200),
    },
  );
  if (!rows.length) return false;
  if (input.severity === 'high' || input.severity === 'critical') {
    // Only the system owner hears about security alerts.
    const owners = await select<{ id: string }>("SELECT id FROM users WHERE role = 'super_admin' AND is_active");
    await notifyUsers(owners.map((owner) => owner.id), {
      kind: 'security', title: `تنبيه أمني: ${input.title}`, body: 'افتح «الحارس الأمني» لمراجعة التنبيه.', link: '/security',
    }).catch(() => 0);
  }
  return true;
}

/** Recomputes the audit chain and reports the first broken link, if any. */
export async function verifyAuditChain(): Promise<{ entries: number; broken: number; firstBrokenSeq: string | null; lastHash: string | null }> {
  const row = await selectOne<{ entries: string; broken: string; firstBroken: string | null; lastHash: string | null }>(
    `WITH c AS (
       SELECT seq, hash, prev_hash, lag(hash) OVER (ORDER BY seq) AS expected_prev,
              audit_log_digest(prev_hash, id, user_id, action, entity_type, entity_id, details, ip, created_at) AS recomputed
       FROM audit_logs
     )
     SELECT count(*) AS entries,
            count(*) FILTER (WHERE hash IS DISTINCT FROM recomputed OR prev_hash IS DISTINCT FROM expected_prev) AS broken,
            min(seq) FILTER (WHERE hash IS DISTINCT FROM recomputed OR prev_hash IS DISTINCT FROM expected_prev)::text AS "firstBroken",
            (SELECT hash FROM audit_logs ORDER BY seq DESC LIMIT 1) AS "lastHash"
     FROM c`,
  );
  return {
    entries: Number(row?.entries ?? 0), broken: Number(row?.broken ?? 0),
    firstBrokenSeq: row?.firstBroken ?? null, lastHash: row?.lastHash ?? null,
  };
}

function minutesOf(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Baghdad wall-clock minutes of a timestamp. */
function baghdadMinutes(date: Date): number {
  const shifted = new Date(date.getTime() + 3 * 3600000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

export function outsideWorkday(date: Date, start: string, end: string): boolean {
  const now = baghdadMinutes(date);
  const from = minutesOf(start);
  const to = minutesOf(end);
  return from <= to ? now < from || now >= to : now < from && now >= to;
}

const SENSITIVE_ACTIONS = [
  'settings.updated', 'user.created', 'user.updated', 'payroll.run_approved', 'payroll.signed', 'finance.journal_posted',
  'compensation.added', 'employee.separated', 'archive.withdrawn', 'payroll_archive.withdrawn', 'security.user_signed_out',
];

/**
 * One pass of the guard over the last few minutes. Each rule raises at most
 * one open alert per subject (fingerprint), so it can run every minute.
 */
export async function runSecurityGuard(now = new Date()): Promise<number> {
  const settings = await getSettings();
  const rules = settings.security;
  let raised = 0;

  // 1. Many failed sign-ins from one address (password guessing).
  const guessing = await select<{ ip: string; failures: string; accounts: string }>(
    `SELECT ip, count(*) AS failures, count(DISTINCT user_id) AS accounts FROM security_events
     WHERE kind = 'login_failed' AND at > :now::timestamptz - interval '15 minutes' AND ip IS NOT NULL
     GROUP BY ip HAVING count(*) >= :limit`,
    { now: now.toISOString(), limit: rules.failedLoginAlertThreshold },
  );
  for (const item of guessing) {
    if (await raiseAlert({
      severity: Number(item.accounts) > 2 ? 'critical' : 'high', kind: 'brute_force',
      title: `محاولات دخول خاطئة متكررة من العنوان ${item.ip}`, ip: item.ip,
      fingerprint: `brute_force:${item.ip}`, details: { failures: Number(item.failures), accounts: Number(item.accounts) },
    })) raised += 1;
  }

  // 2. Repeated refused requests by one signed-in person (probing for data they may not see).
  const probing = await select<{ userId: string; refused: string; name: string }>(
    `SELECT e.user_id AS "userId", count(*) AS refused, u.name FROM security_events e JOIN users u ON u.id = e.user_id
     WHERE e.kind = 'forbidden' AND e.at > :now::timestamptz - interval '30 minutes'
     GROUP BY e.user_id, u.name HAVING count(*) >= 10`,
    { now: now.toISOString() },
  );
  for (const item of probing) {
    if (await raiseAlert({
      severity: 'medium', kind: 'probing', title: `${item.name}: طلبات مرفوضة متكررة لبيانات خارج صلاحياته`,
      userId: item.userId, fingerprint: `probing:${item.userId}`, details: { refused: Number(item.refused) },
    })) raised += 1;
  }

  // 3. Bulk exports (payroll registers, bank files, employee lists).
  const exports = await select<{ userId: string; exports: string; name: string }>(
    `SELECT e.user_id AS "userId", count(*) AS exports, u.name FROM security_events e JOIN users u ON u.id = e.user_id
     WHERE e.kind = 'export' AND e.at > :now::timestamptz - interval '1 hour'
     GROUP BY e.user_id, u.name HAVING count(*) >= :limit`,
    { now: now.toISOString(), limit: rules.exportAlertThreshold },
  );
  for (const item of exports) {
    if (await raiseAlert({
      severity: 'high', kind: 'bulk_export', title: `${item.name}: تنزيل كمية كبيرة من الملفات خلال ساعة`,
      userId: item.userId, fingerprint: `bulk_export:${item.userId}`, details: { exports: Number(item.exports) },
    })) raised += 1;
  }

  // 4. Sensitive changes outside working hours.
  const late = await select<{ id: string; userId: string; action: string; at: Date; name: string }>(
    `SELECT a.id, a.user_id AS "userId", a.action, a.created_at AS at, u.name FROM audit_logs a JOIN users u ON u.id = a.user_id
     WHERE a.created_at > :now::timestamptz - interval '10 minutes' AND a.action IN (:actions)`,
    { now: now.toISOString(), actions: SENSITIVE_ACTIONS },
  );
  for (const item of late) {
    if (!outsideWorkday(new Date(item.at), rules.workdayStart, rules.workdayEnd)) continue;
    if (await raiseAlert({
      severity: 'medium', kind: 'off_hours', title: `${item.name}: تعديل حساس خارج أوقات الدوام (${item.action})`,
      userId: item.userId, fingerprint: `off_hours:${item.id}`, details: { action: item.action, at: item.at },
    })) raised += 1;
  }

  // 5. Sign-in from an address the account has never used, for accounts with wide access.
  const fresh = await select<{ id: string; userId: string; ip: string; name: string; role: string }>(
    `SELECT l.id, l.user_id AS "userId", l.ip, u.name, u.role::text AS role FROM login_events l JOIN users u ON u.id = l.user_id
     WHERE l.at > :now::timestamptz - interval '10 minutes' AND l.ip IS NOT NULL
       AND u.role::text NOT IN ('employee','viewer')
       AND EXISTS (SELECT 1 FROM login_events o WHERE o.user_id = l.user_id AND o.at < l.at)
       AND NOT EXISTS (SELECT 1 FROM login_events o WHERE o.user_id = l.user_id AND o.at < l.at AND o.ip = l.ip)`,
    { now: now.toISOString() },
  );
  for (const item of fresh) {
    if (await raiseAlert({
      severity: item.role === 'super_admin' ? 'high' : 'low', kind: 'new_address',
      title: `${item.name}: دخول من عنوان جديد ${item.ip}`, userId: item.userId, ip: item.ip,
      fingerprint: `new_address:${item.userId}:${item.ip}`,
    })) raised += 1;
  }

  // 6. The audit chain: any edited or removed entry breaks it.
  const chain = await verifyAuditChain();
  if (chain.broken > 0) {
    if (await raiseAlert({
      severity: 'critical', kind: 'audit_tamper', title: 'سجل التدقيق تعرّض لتعديل أو حذف خارج النظام',
      fingerprint: `audit_tamper:${chain.firstBrokenSeq}`, details: chain,
    })) raised += 1;
  }
  return raised;
}
