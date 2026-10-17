import { Request, Response } from 'express';
import { execute, select, selectOne } from '../db/query';
import { isUuid } from '../utils/validation';
import { badRequest } from '../utils/http';

export class NotificationController {
  /** The signed-in person's latest notifications and the unread count. */
  static async mine(req: Request, res: Response): Promise<void> {
    const onlyUnread = req.query.unread === '1';
    const [items, count] = await Promise.all([
      select(
        `SELECT id, kind, title, body, link, created_at AS "createdAt", read_at AS "readAt"
         FROM notifications WHERE user_id = :userId ${onlyUnread ? 'AND read_at IS NULL' : ''}
         ORDER BY created_at DESC LIMIT 60`,
        { userId: req.user!.id },
      ),
      selectOne<{ unread: string }>('SELECT count(*) AS unread FROM notifications WHERE user_id = :userId AND read_at IS NULL', { userId: req.user!.id }),
    ]);
    res.json({ data: { items, unread: Number(count?.unread ?? 0) } });
  }

  static async markRead(req: Request, res: Response): Promise<void> {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : req.body?.all === true ? null : undefined;
    if (ids === undefined || (ids && (!ids.length || ids.length > 200 || !ids.every(isUuid)))) throw badRequest('حدد الإشعارات.');
    await execute(
      `UPDATE notifications SET read_at = now() WHERE user_id = :userId AND read_at IS NULL ${ids ? 'AND id IN (:ids)' : ''}`,
      { userId: req.user!.id, ids },
    );
    res.json({ data: { ok: true } });
  }
}

export default NotificationController;
