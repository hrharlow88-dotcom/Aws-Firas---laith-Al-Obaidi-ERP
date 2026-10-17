import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { execute, select, selectOne, transaction } from '../db/query';
import { moveToBin, snapshot } from '../services/recycleBin';
import { notifyUsers } from '../services/notify';
import { recordAudit } from '../utils/audit';
import { assertOnlyKeys, badRequest, body, notFound, optionalText, requiredText } from '../utils/http';
import { isUuid } from '../utils/validation';

const KINDS = ['announcement', 'alert', 'notice', 'invitation', 'circular'];
const SEVERITIES = ['info', 'important', 'urgent'];
const AUDIENCES = ['all', 'branch', 'department', 'employees'];

/** Accounts an announcement reaches (active users; employees by their file, staff without a file by their branch). */
const AUDIENCE_USERS = `
  SELECT u.id FROM users u LEFT JOIN employees e ON e.id = u.employee_id
  WHERE u.is_active AND (
    a.audience = 'all'
    OR (a.audience = 'branch' AND COALESCE(e.branch_id, u.branch_id) = a.branch_id)
    OR (a.audience = 'department' AND e.department_id = a.department_id)
    OR (a.audience = 'employees' AND e.id = ANY(a.employee_ids)))`;

/** Full-screen announcements, alerts, notices, invitations and circulars. */
export class AnnouncementController {
  static async list(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT a.id, a.title_ar AS "titleAr", a.title_en AS "titleEn", a.body_ar AS "bodyAr", a.body_en AS "bodyEn", a.kind, a.severity,
              a.audience, b.name AS "branchName", d.name AS "departmentName", cardinality(a.employee_ids) AS "employeeCount",
              a.require_ack AS "requireAck", a.starts_at AS "startsAt", a.ends_at AS "endsAt", a.signed_by_title AS "signedByTitle",
              a.created_at AS "createdAt", u.name AS "createdByName",
              (SELECT count(*) FROM (${AUDIENCE_USERS}) x) AS audience_size,
              (SELECT count(*) FROM announcement_receipts r WHERE r.announcement_id = a.id) AS seen,
              (SELECT count(*) FROM announcement_receipts r WHERE r.announcement_id = a.id AND r.acknowledged_at IS NOT NULL) AS acknowledged
       FROM announcements a JOIN users u ON u.id = a.created_by
       LEFT JOIN branches b ON b.id = a.branch_id LEFT JOIN departments d ON d.id = a.department_id
       WHERE a.withdrawn_at IS NULL ORDER BY a.created_at DESC LIMIT 200`,
    );
    res.json({ data: rows });
  }

  static async receipts(req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT u.name, e.employee_no AS "employeeNo", r.seen_at AS "seenAt", r.acknowledged_at AS "acknowledgedAt"
       FROM announcements a CROSS JOIN LATERAL (${AUDIENCE_USERS}) x JOIN users u ON u.id = x.id LEFT JOIN employees e ON e.id = u.employee_id
       LEFT JOIN announcement_receipts r ON r.announcement_id = a.id AND r.user_id = u.id
       WHERE a.id = :id ORDER BY r.seen_at NULLS FIRST, u.name LIMIT 2000`,
      { id: req.params.id },
    );
    res.json({ data: rows });
  }

  static async create(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['titleAr', 'titleEn', 'bodyAr', 'bodyEn', 'kind', 'severity', 'audience', 'branchId', 'departmentId',
      'employeeIds', 'requireAck', 'startsAt', 'endsAt', 'signedByTitle']);
    const kind = String(input.kind || 'announcement');
    const severity = String(input.severity || 'info');
    const audience = String(input.audience || 'all');
    if (!KINDS.includes(kind) || !SEVERITIES.includes(severity) || !AUDIENCES.includes(audience)) throw badRequest('تحقق من النوع والأهمية والجمهور.');
    const branchId = audience === 'branch' ? (isUuid(input.branchId) ? String(input.branchId) : null) : null;
    const departmentId = audience === 'department' ? (isUuid(input.departmentId) ? String(input.departmentId) : null) : null;
    const employeeIds = audience === 'employees' && Array.isArray(input.employeeIds) ? input.employeeIds.filter(isUuid).slice(0, 2000) : [];
    if (audience === 'branch' && !branchId) throw badRequest('اختر الفرع.');
    if (audience === 'department' && !departmentId) throw badRequest('اختر القسم.');
    if (audience === 'employees' && !employeeIds.length) throw badRequest('اختر الموظفين.');
    const startsAt = typeof input.startsAt === 'string' && input.startsAt ? new Date(input.startsAt) : new Date();
    const endsAt = typeof input.endsAt === 'string' && input.endsAt ? new Date(input.endsAt) : null;
    if (Number.isNaN(startsAt.getTime()) || (endsAt && (Number.isNaN(endsAt.getTime()) || endsAt <= startsAt))) throw badRequest('تحقق من مدة العرض.');
    const id = randomUUID();
    const titleAr = requiredText(input, 'titleAr', 200, 'العنوان بالعربي');
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO announcements (id, title_ar, title_en, body_ar, body_en, kind, severity, audience, branch_id, department_id, employee_ids,
           require_ack, starts_at, ends_at, signed_by_title, created_by)
         VALUES (:id, :titleAr, :titleEn, :bodyAr, :bodyEn, :kind, :severity, :audience, :branchId, :departmentId, :employeeIds::uuid[],
           :requireAck, :startsAt, :endsAt, :signedByTitle, :userId)`,
        {
          id, titleAr, titleEn: optionalText(input, 'titleEn', 200) ?? null,
          bodyAr: requiredText(input, 'bodyAr', 20000, 'النص بالعربي'), bodyEn: optionalText(input, 'bodyEn', 20000) ?? null,
          kind, severity, audience, branchId, departmentId, employeeIds: employeeIds.length ? `{${employeeIds.join(',')}}` : null,
          requireAck: input.requireAck === true, startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null,
          signedByTitle: optionalText(input, 'signedByTitle', 120) ?? 'إدارة النظام — الموارد البشرية', userId: req.user!.id,
        },
        tx,
      );
      const reach = await select<{ id: string }>(`SELECT x.id FROM announcements a CROSS JOIN LATERAL (${AUDIENCE_USERS}) x WHERE a.id = :id`, { id }, tx);
      await notifyUsers(reach.map((row) => row.id), { kind: 'announcement', title: titleAr, body: 'إعلان جديد من الموارد البشرية', link: '/announcements' }, tx);
      await recordAudit(req, tx, 'announcement.published', 'announcement', id, { kind, audience, reach: reach.length });
    });
    res.status(201).json({ data: { id } });
  }

  static async withdraw(req: Request, res: Response): Promise<void> {
    await transaction(async (tx) => {
      const copy = await snapshot('announcements', req.params.id, tx);
      if (!copy || copy.withdrawn_at) throw notFound('الإعلان غير موجود.');
      await execute('UPDATE announcements SET withdrawn_at = now() WHERE id = :id', { id: req.params.id }, tx);
      await moveToBin(req, tx, { entityType: 'announcement', entityId: req.params.id, module: 'communication', title: `إعلان: ${String(copy.title_ar)}`, payload: copy });
      await recordAudit(req, tx, 'announcement.withdrawn', 'announcement', req.params.id);
    });
    res.json({ data: { ok: true } });
  }

  /** What the signed-in person still has to see (shown full screen on opening the system). */
  static async pending(req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT a.id, a.title_ar AS "titleAr", a.title_en AS "titleEn", a.body_ar AS "bodyAr", a.body_en AS "bodyEn", a.kind, a.severity,
              a.require_ack AS "requireAck", a.starts_at AS "startsAt", a.signed_by_title AS "signedByTitle", u.name AS "createdByName"
       FROM announcements a JOIN users u ON u.id = a.created_by
       LEFT JOIN announcement_receipts r ON r.announcement_id = a.id AND r.user_id = :userId
       WHERE a.withdrawn_at IS NULL AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
         AND :userId::uuid IN (${AUDIENCE_USERS})
         AND (r.user_id IS NULL OR (a.require_ack AND r.acknowledged_at IS NULL))
       ORDER BY CASE a.severity WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, a.starts_at DESC LIMIT 10`,
      { userId: req.user!.id },
    );
    res.json({ data: rows });
  }

  /** Every announcement that reached the person (their notice board). */
  static async mine(req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT a.id, a.title_ar AS "titleAr", a.title_en AS "titleEn", a.body_ar AS "bodyAr", a.body_en AS "bodyEn", a.kind, a.severity,
              a.require_ack AS "requireAck", a.starts_at AS "startsAt", a.signed_by_title AS "signedByTitle",
              r.seen_at AS "seenAt", r.acknowledged_at AS "acknowledgedAt"
       FROM announcements a LEFT JOIN announcement_receipts r ON r.announcement_id = a.id AND r.user_id = :userId
       WHERE a.withdrawn_at IS NULL AND a.starts_at <= now() AND :userId::uuid IN (${AUDIENCE_USERS})
       ORDER BY a.starts_at DESC LIMIT 100`,
      { userId: req.user!.id },
    );
    res.json({ data: rows });
  }

  static async seen(req: Request, res: Response): Promise<void> {
    const ack = req.body?.acknowledge === true;
    const found = await selectOne(
      `SELECT 1 FROM announcements a WHERE a.id = :id AND a.withdrawn_at IS NULL AND :userId::uuid IN (${AUDIENCE_USERS})`,
      { id: req.params.id, userId: req.user!.id },
    );
    if (!found) throw notFound('الإعلان غير موجود.');
    await execute(
      `INSERT INTO announcement_receipts (announcement_id, user_id, acknowledged_at) VALUES (:id, :userId, CASE WHEN :ack THEN now() END)
       ON CONFLICT (announcement_id, user_id) DO UPDATE SET acknowledged_at = COALESCE(announcement_receipts.acknowledged_at, EXCLUDED.acknowledged_at)`,
      { id: req.params.id, userId: req.user!.id, ack },
    );
    res.json({ data: { ok: true } });
  }
}

export default AnnouncementController;
