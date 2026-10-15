import { Request, Response } from 'express';
import { execute, select, selectOne } from '../db/query';
import { badRequest } from '../utils/http';
import { isDateOnly, isUuid } from '../utils/validation';

const FROM_TO = `(:from::date IS NULL OR a.at >= (:from::date)::timestamp AT TIME ZONE 'Asia/Baghdad')
  AND (:to::date IS NULL OR a.at < ((:to::date + 1)::timestamp AT TIME ZONE 'Asia/Baghdad'))`;

/** Every visit and action, per person and per app (audit.view). */
export class ActivityController {
  /** The front end reports the screen the person opened. */
  static async visit(req: Request, res: Response): Promise<void> {
    const route = typeof req.body?.route === 'string' ? req.body.route.trim().slice(0, 200) : '';
    const module = typeof req.body?.module === 'string' && /^[a-z-]{2,30}$/.test(req.body.module) ? req.body.module : 'other';
    if (!route.startsWith('/')) throw badRequest('المسار غير صالح.');
    await execute(
      `INSERT INTO activity_log (user_id, kind, module, path, ip) VALUES (:userId, 'visit', :module, :route, :ip)`,
      { userId: req.user!.id, module, route, ip: (req.ip || '').slice(0, 64) || null },
    );
    res.json({ data: { ok: true } });
  }

  static async list(req: Request, res: Response): Promise<void> {
    const from = isDateOnly(req.query.from) ? String(req.query.from) : null;
    const to = isDateOnly(req.query.to) ? String(req.query.to) : null;
    const userId = isUuid(req.query.userId) ? String(req.query.userId) : null;
    const module = typeof req.query.module === 'string' && /^[a-z-]{2,30}$/.test(req.query.module) ? req.query.module : null;
    const kind = ['visit', 'read', 'write'].includes(String(req.query.kind)) ? String(req.query.kind) : null;
    const params = { from, to, userId, module, kind };
    const where = `${FROM_TO} AND (:userId::uuid IS NULL OR a.user_id = :userId::uuid)
      AND (:module::text IS NULL OR a.module = :module::text) AND (:kind::text IS NULL OR a.kind = :kind::text)`;
    const [rows, byUser, byModule, totals] = await Promise.all([
      select(
        `SELECT a.id, a.at, a.kind, a.module, a.method, a.path, a.status, a.duration_ms AS "durationMs", a.ip,
                u.id AS "userId", u.name AS "userName", u.role::text AS role
         FROM activity_log a JOIN users u ON u.id = a.user_id WHERE ${where} ORDER BY a.at DESC LIMIT 500`,
        params,
      ),
      select(
        `SELECT u.id AS "userId", u.name AS "userName", u.role::text AS role,
                count(*) FILTER (WHERE a.kind = 'visit') AS visits, count(*) FILTER (WHERE a.kind = 'write') AS writes,
                count(*) FILTER (WHERE a.status >= 400) AS refused, min(a.at) AS "firstAt", max(a.at) AS "lastAt"
         FROM activity_log a JOIN users u ON u.id = a.user_id WHERE ${where}
         GROUP BY u.id, u.name, u.role ORDER BY max(a.at) DESC LIMIT 200`,
        params,
      ),
      select(
        `SELECT a.module, count(*) FILTER (WHERE a.kind = 'visit') AS visits, count(*) FILTER (WHERE a.kind = 'write') AS writes,
                count(DISTINCT a.user_id) AS people
         FROM activity_log a WHERE ${where} GROUP BY a.module ORDER BY count(*) DESC`,
        params,
      ),
      selectOne(
        `SELECT count(*) FILTER (WHERE a.kind = 'visit') AS visits, count(*) FILTER (WHERE a.kind = 'write') AS writes,
                count(DISTINCT a.user_id) AS people FROM activity_log a WHERE ${where}`,
        params,
      ),
    ]);
    res.json({ data: { rows, byUser, byModule, totals } });
  }
}

export default ActivityController;
