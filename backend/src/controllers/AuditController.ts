import { Request, Response } from 'express';
import { select } from '../db/query';
import { pageParams, queryText } from '../utils/http';
import { isDateOnly, isUuid } from '../utils/validation';

export class AuditController {
  /** Searchable view of the append-only audit trail. */
  static async list(req: Request, res: Response): Promise<void> {
    const { page, pageSize, offset } = pageParams(req, 50, 200);
    const filters: string[] = [];
    const params: Record<string, unknown> = { limit: pageSize + 1, offset };
    const from = queryText(req, 'from');
    const to = queryText(req, 'to');
    if (isDateOnly(from)) {
      filters.push('a.created_at >= :from::date');
      params.from = from;
    }
    if (isDateOnly(to)) {
      filters.push("a.created_at < :to::date + INTERVAL '1 day'");
      params.to = to;
    }
    const action = queryText(req, 'action');
    if (action && /^[a-z_.]{2,80}$/.test(action)) {
      filters.push('a.action LIKE :action');
      params.action = `${action}%`;
    }
    for (const [key, column] of [['userId', 'a.user_id'], ['entityId', 'a.entity_id']] as const) {
      const value = queryText(req, key);
      if (value && isUuid(value)) {
        filters.push(`${column} = :${key}`);
        params[key] = value;
      }
    }
    const rows = await select<Record<string, unknown>>(
      `SELECT a.id, a.created_at AS "createdAt", a.action, a.entity_type AS "entityType", a.entity_id AS "entityId",
              a.details, a.ip, u.name AS "userName", u.email AS "userEmail",
              CASE WHEN a.entity_type = 'employee' THEN e.full_name END AS "employeeName"
       FROM audit_logs a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN employees e ON a.entity_type = 'employee' AND e.id = a.entity_id
       ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
       ORDER BY a.created_at DESC LIMIT :limit OFFSET :offset`,
      params,
    );
    res.json({ data: rows.slice(0, pageSize), pagination: { page, pageSize, hasMore: rows.length > pageSize } });
  }
}

export default AuditController;
