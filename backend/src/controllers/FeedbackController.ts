import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { execute, select, selectOne, transaction } from '../db/query';
import { notifyUsers } from '../services/notify';
import { openStoredFile, sniffFile, storedFileExists, storeFile } from '../services/storage';
import { recordAudit } from '../utils/audit';
import { assertOnlyKeys, badRequest, body, notFound, optionalText } from '../utils/http';
import { isUuid } from '../utils/validation';

const KINDS = ['bug', 'idea', 'question'] as const;
const STATUSES = ['new', 'in_progress', 'done', 'declined'] as const;
const STATUS_LABEL: Record<(typeof STATUSES)[number], string> = {
  new: 'جديدة', in_progress: 'قيد المعالجة', done: 'تمت', declined: 'لن تُنفّذ',
};

async function owners(): Promise<string[]> {
  return (await select<{ id: string }>("SELECT id FROM users WHERE role = 'super_admin' AND is_active AND NOT is_demo")).map((row) => row.id);
}

/**
 * Notes on the system from anyone who uses it — a fault, an idea, a question —
 * with the screen, version and device they came from, for the owner to work through.
 */
export class FeedbackController {
  static async create(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['kind', 'message', 'page', 'appVersion', 'viewport']);
    const kind = KINDS.find((item) => item === input.kind);
    if (!kind) throw badRequest('اختر نوع الملاحظة.');
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (message.length < 3 || message.length > 2000) throw badRequest('اكتب الملاحظة (حتى 2000 حرف).');
    const page = optionalText(input, 'page', 200) ?? null;
    const appVersion = optionalText(input, 'appVersion', 20) ?? null;
    const viewport = optionalText(input, 'viewport', 20) ?? null;
    let storageKey: string | null = null;
    let mimeType: string | null = null;
    if (req.file) {
      if (req.file.size > 3 * 1024 * 1024) throw badRequest('الصورة المرفقة حتى 3 ميغابايت.');
      const sniffed = sniffFile(req.file.buffer, ['image/jpeg', 'image/png', 'image/webp']);
      storageKey = await storeFile('feedback', req.file.buffer, sniffed.ext);
      mimeType = sniffed.mime;
    }
    const id = randomUUID();
    const refNo = await transaction(async (tx) => {
      const [row] = await execute<{ refNo: string }>(
        `INSERT INTO feedback (id, ref_no, user_id, kind, message, page, app_version, device, viewport, storage_key, mime_type)
         VALUES (:id, 'FB-' || lpad(nextval('feedback_ref_seq')::text, 4, '0'), :userId, :kind, :message, :page, :appVersion,
                 :device, :viewport, :storageKey, :mimeType)
         RETURNING ref_no AS "refNo"`,
        {
          id, userId: req.user!.id, kind, message, page, appVersion, device: (req.header('user-agent') ?? '').slice(0, 300) || null,
          viewport, storageKey, mimeType,
        },
        tx,
      );
      await notifyUsers((await owners()).filter((owner) => owner !== req.user!.id), {
        kind: 'feedback', title: `ملاحظة جديدة على النظام ${row.refNo}`, body: `${req.user!.name}: ${message.slice(0, 160)}`, link: '/feedback',
      }, tx);
      await recordAudit(req, tx, 'feedback.created', 'feedback', id, { refNo: row.refNo, kind });
      return row.refNo;
    });
    res.status(201).json({ data: { id, refNo } });
  }

  static async mine(req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT id, ref_no AS "refNo", kind, message, status, owner_note AS "ownerNote", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM feedback WHERE user_id = :userId ORDER BY created_at DESC LIMIT 50`,
      { userId: req.user!.id },
    );
    res.json({ data: rows });
  }

  static async list(req: Request, res: Response): Promise<void> {
    const status = typeof req.query.status === 'string' && (STATUSES as readonly string[]).includes(req.query.status) ? req.query.status : null;
    const rows = await select(
      `SELECT f.id, f.ref_no AS "refNo", f.kind, f.message, f.page, f.app_version AS "appVersion", f.device, f.viewport,
              f.storage_key IS NOT NULL AS "hasImage", f.status, f.owner_note AS "ownerNote", f.created_at AS "createdAt",
              f.updated_at AS "updatedAt", u.name AS "userName", u.role AS "userRole"
       FROM feedback f JOIN users u ON u.id = f.user_id
       ${status ? 'WHERE f.status = :status' : ''}
       ORDER BY CASE f.status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, f.created_at DESC
       LIMIT 300`,
      status ? { status } : {},
    );
    const counts = await select<{ status: string; count: number }>('SELECT status, count(*)::int AS count FROM feedback GROUP BY status');
    res.json({ data: { rows, counts: Object.fromEntries(counts.map((row) => [row.status, row.count])) } });
  }

  static async image(req: Request, res: Response): Promise<void> {
    if (!isUuid(req.params.id)) throw notFound('الصورة غير موجودة.');
    const row = await selectOne<{ storageKey: string | null; mimeType: string | null; userId: string }>(
      'SELECT storage_key AS "storageKey", mime_type AS "mimeType", user_id AS "userId" FROM feedback WHERE id = :id', { id: req.params.id },
    );
    if (!row?.storageKey || (req.user!.role !== 'super_admin' && row.userId !== req.user!.id) || !(await storedFileExists(row.storageKey))) {
      throw notFound('الصورة غير موجودة.');
    }
    res.setHeader('Content-Type', row.mimeType ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    openStoredFile(row.storageKey).pipe(res);
  }

  static async update(req: Request, res: Response): Promise<void> {
    if (!isUuid(req.params.id)) throw notFound('الملاحظة غير موجودة.');
    const input = body(req);
    assertOnlyKeys(input, ['status', 'ownerNote']);
    const status = STATUSES.find((item) => item === input.status);
    if (!status) throw badRequest('اختر الحالة.');
    const ownerNote = optionalText(input, 'ownerNote', 1000) ?? null;
    await transaction(async (tx) => {
      const [row] = await execute<{ userId: string; refNo: string }>(
        `UPDATE feedback SET status = :status, owner_note = :ownerNote, handled_by = :userId, updated_at = now()
         WHERE id = :id RETURNING user_id AS "userId", ref_no AS "refNo"`,
        { id: req.params.id, status, ownerNote, userId: req.user!.id },
        tx,
      );
      if (!row) throw notFound('الملاحظة غير موجودة.');
      if (row.userId !== req.user!.id) {
        await notifyUsers([row.userId], {
          kind: 'feedback', title: `ملاحظتك ${row.refNo}: ${STATUS_LABEL[status]}`, body: ownerNote, link: '/home',
        }, tx);
      }
      await recordAudit(req, tx, 'feedback.updated', 'feedback', req.params.id, { status });
    });
    res.json({ data: { id: req.params.id, status } });
  }
}
