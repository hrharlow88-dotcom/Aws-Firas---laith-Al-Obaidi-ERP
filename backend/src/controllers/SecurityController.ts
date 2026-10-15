import { Request, Response } from 'express';
import { execute, select, selectOne, transaction } from '../db/query';
import { recordAudit } from '../utils/audit';
import { badRequest, body, notFound, optionalText } from '../utils/http';
import { isDateOnly, isUuid } from '../utils/validation';
import { getSettings } from '../services/settings';
import { runSecurityGuard, verifyAuditChain } from '../services/security';

/** The security guard's console. Owner (super_admin) only. */
export class SecurityController {
  static async overview(_req: Request, res: Response): Promise<void> {
    const settings = await getSettings();
    const [counts, chain, online, today] = await Promise.all([
      selectOne<{ open: string; critical: string; high: string }>(
        `SELECT count(*) FILTER (WHERE resolved_at IS NULL) AS open,
                count(*) FILTER (WHERE resolved_at IS NULL AND severity = 'critical') AS critical,
                count(*) FILTER (WHERE resolved_at IS NULL AND severity = 'high') AS high
         FROM security_alerts`,
      ),
      verifyAuditChain(),
      select(
        `SELECT u.id, u.name, u.role::text AS role, u.last_seen_at AS "lastSeenAt",
                (SELECT l.ip FROM login_events l WHERE l.user_id = u.id ORDER BY l.at DESC LIMIT 1) AS ip
         FROM users u WHERE u.is_active AND u.last_seen_at > now() - make_interval(mins => :idle)
         ORDER BY u.last_seen_at DESC LIMIT 100`,
        { idle: settings.security.idleMinutes },
      ),
      selectOne<{ logins: string; failed: string; refused: string }>(
        `SELECT (SELECT count(*) FROM login_events WHERE at > date_trunc('day', now() AT TIME ZONE 'Asia/Baghdad') AT TIME ZONE 'Asia/Baghdad') AS logins,
                (SELECT count(*) FROM security_events WHERE kind = 'login_failed' AND at > now() - interval '24 hours') AS failed,
                (SELECT count(*) FROM security_events WHERE kind = 'forbidden' AND at > now() - interval '24 hours') AS refused`,
      ),
    ]);
    res.json({
      data: {
        openAlerts: Number(counts?.open ?? 0), critical: Number(counts?.critical ?? 0), high: Number(counts?.high ?? 0),
        chain, online, loginsToday: Number(today?.logins ?? 0), failedLogins24h: Number(today?.failed ?? 0),
        refused24h: Number(today?.refused ?? 0), security: settings.security,
      },
    });
  }

  static async alerts(req: Request, res: Response): Promise<void> {
    const open = req.query.status !== 'all';
    const rows = await select(
      `SELECT a.id, a.at, a.severity, a.kind, a.title, a.details, a.ip, a.user_id AS "userId", u.name AS "userName",
              a.resolved_at AS "resolvedAt", r.name AS "resolvedByName", a.resolution
       FROM security_alerts a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users r ON r.id = a.resolved_by
       ${open ? 'WHERE a.resolved_at IS NULL' : ''}
       ORDER BY a.resolved_at IS NULL DESC, CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, a.at DESC
       LIMIT 300`,
    );
    res.json({ data: rows });
  }

  static async resolve(req: Request, res: Response): Promise<void> {
    const input = body(req);
    const resolution = optionalText(input, 'resolution', 500);
    if (!resolution) throw badRequest('اكتب ما اتُّخذ بشأن التنبيه.');
    await transaction(async (tx) => {
      const rows = await execute<{ id: string }>(
        `UPDATE security_alerts SET resolved_at = now(), resolved_by = :userId, resolution = :resolution
         WHERE id = :id AND resolved_at IS NULL RETURNING id`,
        { id: req.params.id, userId: req.user!.id, resolution },
        tx,
      );
      if (!rows.length) throw notFound('التنبيه غير موجود أو عولج سابقاً.');
      await recordAudit(req, tx, 'security.alert_resolved', 'security_alert', req.params.id, { resolution });
    });
    res.json({ data: { ok: true } });
  }

  /** Sign-in trail with time to the second and the place on the map. */
  static async logins(req: Request, res: Response): Promise<void> {
    const from = isDateOnly(req.query.from) ? String(req.query.from) : null;
    const to = isDateOnly(req.query.to) ? String(req.query.to) : null;
    const userId = isUuid(req.query.userId) ? String(req.query.userId) : null;
    const channel = req.query.channel === 'portal' || req.query.channel === 'staff' ? String(req.query.channel) : null;
    const rows = await select(
      `SELECT l.id, l.at, l.channel, l.ip, l.user_agent AS "userAgent", l.latitude::float AS latitude, l.longitude::float AS longitude,
              l.accuracy_m AS accuracy, l.location_status AS "locationStatus", u.id AS "userId", u.name AS "userName",
              u.username, u.role::text AS role, e.employee_no AS "employeeNo"
       FROM login_events l JOIN users u ON u.id = l.user_id LEFT JOIN employees e ON e.id = u.employee_id
       WHERE (:from::date IS NULL OR l.at >= (:from::date)::timestamp AT TIME ZONE 'Asia/Baghdad')
         AND (:to::date IS NULL OR l.at < ((:to::date + 1)::timestamp AT TIME ZONE 'Asia/Baghdad'))
         AND (:userId::uuid IS NULL OR l.user_id = :userId::uuid)
         AND (:channel::text IS NULL OR l.channel = :channel::text)
       ORDER BY l.at DESC LIMIT 500`,
      { from, to, userId, channel },
    );
    res.json({ data: rows });
  }

  static async events(req: Request, res: Response): Promise<void> {
    const kind = typeof req.query.kind === 'string' && /^[a-z_]{2,30}$/.test(req.query.kind) ? req.query.kind : null;
    const rows = await select(
      `SELECT e.id, e.at, e.kind, e.ip, e.path, e.details, u.name AS "userName"
       FROM security_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE (:kind::text IS NULL OR e.kind = :kind::text) ORDER BY e.at DESC LIMIT 300`,
      { kind },
    );
    res.json({ data: rows });
  }

  static async chain(_req: Request, res: Response): Promise<void> {
    res.json({ data: await verifyAuditChain() });
  }

  /** Runs the guard now instead of waiting for its next round. */
  static async scan(_req: Request, res: Response): Promise<void> {
    res.json({ data: { raised: await runSecurityGuard() } });
  }

  /** Ends every session of an account at once (its tokens stop working). */
  static async signOutUser(req: Request, res: Response): Promise<void> {
    const id = req.params.id;
    if (id === req.user!.id) throw badRequest('لإنهاء جلستك استخدم تسجيل الخروج.');
    await transaction(async (tx) => {
      const rows = await execute<{ id: string }>(
        'UPDATE users SET token_version = token_version + 1, last_seen_at = NULL WHERE id = :id RETURNING id', { id }, tx,
      );
      if (!rows.length) throw notFound('الحساب غير موجود.');
      await recordAudit(req, tx, 'security.user_signed_out', 'user', id);
    });
    res.json({ data: { ok: true } });
  }
}

export default SecurityController;
