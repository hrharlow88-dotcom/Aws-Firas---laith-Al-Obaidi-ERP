import { createHash, randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { execute, select, selectOne, transaction } from '../db/query';
import { getSettings } from '../services/settings';
import { notifyUsers } from '../services/notify';
import { contentDisposition, inlineSafeType, openStoredFile, safeExtension, storeFile, storedFileExists, uploadedName } from '../services/storage';
import { badRequest, body, forbidden, notFound, optionalText } from '../utils/http';
import { isUuid } from '../utils/validation';

const GENERAL = 'general';
const REACTIONS = ['👍', '❤️', '😂', '🎉', '👏', '✅', '👀', '🙏'];

async function ensureGeneral(userId: string): Promise<void> {
  let general = await selectOne<{ id: string }>("SELECT id FROM chat_channels WHERE direct_key = :key", { key: GENERAL });
  if (!general) {
    const id = randomUUID();
    await execute(
      `INSERT INTO chat_channels (id, kind, name, description, direct_key, created_by) VALUES (:id, 'channel', 'عام · General', 'قناة كل الشركة', :key, :userId)
       ON CONFLICT (direct_key) DO NOTHING`,
      { id, key: GENERAL, userId },
    );
    general = await selectOne<{ id: string }>("SELECT id FROM chat_channels WHERE direct_key = :key", { key: GENERAL });
  }
  await execute('INSERT INTO chat_members (channel_id, user_id) VALUES (:channel, :userId) ON CONFLICT DO NOTHING', { channel: general!.id, userId });
}

async function membership(channelId: string, userId: string): Promise<{ role: string } | null> {
  if (!isUuid(channelId)) return null;
  return selectOne<{ role: string }>('SELECT role FROM chat_members WHERE channel_id = :channelId AND user_id = :userId', { channelId, userId });
}

const MESSAGE_COLUMNS = `m.id, m.channel_id AS "channelId", m.user_id AS "userId", u.name AS "userName", u.role::text AS "userRole",
  CASE WHEN m.deleted_at IS NULL THEN m.body END AS body, m.reply_to AS "replyTo",
  (SELECT left(r.body, 120) FROM chat_messages r WHERE r.id = m.reply_to) AS "replyBody",
  (SELECT ru.name FROM chat_messages r JOIN users ru ON ru.id = r.user_id WHERE r.id = m.reply_to) AS "replyName",
  CASE WHEN m.deleted_at IS NULL THEN m.attachment_name END AS "attachmentName", m.attachment_mime AS "attachmentMime", m.attachment_size AS "attachmentSize",
  m.reactions, m.created_at AS "createdAt", m.edited_at AS "editedAt", m.deleted_at AS "deletedAt"`;

/** Internal chat like Odoo Discuss: company channels, private groups and direct messages. */
export class ChatController {
  static async channels(req: Request, res: Response): Promise<void> {
    const userId = req.user!.id;
    await ensureGeneral(userId);
    const settings = await getSettings();
    const rows = await select(
      `SELECT c.id, c.kind, c.description, c.is_private AS "isPrivate", c.last_message_at AS "lastMessageAt",
              CASE WHEN c.kind = 'direct' THEN (SELECT u.name FROM chat_members o JOIN users u ON u.id = o.user_id WHERE o.channel_id = c.id AND o.user_id <> :userId LIMIT 1) ELSE c.name END AS name,
              CASE WHEN c.kind = 'direct' THEN (SELECT o.user_id FROM chat_members o WHERE o.channel_id = c.id AND o.user_id <> :userId LIMIT 1) END AS "otherUserId",
              CASE WHEN c.kind = 'direct' THEN (SELECT u.last_seen_at > now() - make_interval(mins => :idle) FROM chat_members o JOIN users u ON u.id = o.user_id WHERE o.channel_id = c.id AND o.user_id <> :userId LIMIT 1) END AS online,
              (SELECT count(*) FROM chat_messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL AND m.user_id <> :userId AND m.created_at > COALESCE(me.last_read_at, 'epoch'))::int AS unread,
              (SELECT left(m.body, 90) FROM chat_messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS preview,
              (SELECT count(*) FROM chat_members x WHERE x.channel_id = c.id)::int AS members, me.muted
       FROM chat_channels c JOIN chat_members me ON me.channel_id = c.id AND me.user_id = :userId
       WHERE c.archived_at IS NULL
       ORDER BY c.kind, COALESCE(c.last_message_at, c.created_at) DESC`,
      { userId, idle: settings.security.idleMinutes },
    );
    const discover = await select(
      `SELECT c.id, c.name, c.description, (SELECT count(*) FROM chat_members x WHERE x.channel_id = c.id)::int AS members
       FROM chat_channels c WHERE c.kind = 'channel' AND NOT c.is_private AND c.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM chat_members m WHERE m.channel_id = c.id AND m.user_id = :userId) ORDER BY c.name`,
      { userId },
    );
    res.json({ data: { channels: rows, discover } });
  }

  static async people(req: Request, res: Response): Promise<void> {
    const settings = await getSettings();
    const rows = await select(
      `SELECT u.id, u.name, u.role::text AS role, e.position, b.name AS "branchName",
              (u.last_seen_at > now() - make_interval(mins => :idle)) AS online
       FROM users u LEFT JOIN employees e ON e.id = u.employee_id LEFT JOIN branches b ON b.id = e.branch_id
       WHERE u.is_active AND u.id <> :userId ORDER BY online DESC NULLS LAST, u.name LIMIT 1000`,
      { userId: req.user!.id, idle: settings.security.idleMinutes },
    );
    res.json({ data: rows });
  }

  static async unread(req: Request, res: Response): Promise<void> {
    const row = await selectOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM chat_messages m JOIN chat_members me ON me.channel_id = m.channel_id AND me.user_id = :userId
       WHERE m.deleted_at IS NULL AND m.user_id <> :userId AND NOT me.muted AND m.created_at > COALESCE(me.last_read_at, 'epoch')`,
      { userId: req.user!.id },
    );
    res.json({ data: { unread: row?.count ?? 0 } });
  }

  static async createChannel(req: Request, res: Response): Promise<void> {
    const input = body(req);
    const name = optionalText(input, 'name', 80);
    if (!name) throw badRequest('اكتب اسم القناة.');
    const members = (Array.isArray(input.memberIds) ? input.memberIds : []).filter(isUuid).slice(0, 500) as string[];
    const id = randomUUID();
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO chat_channels (id, kind, name, description, is_private, created_by) VALUES (:id, 'channel', :name, :description, :isPrivate, :userId)`,
        { id, name, description: optionalText(input, 'description', 300) ?? null, isPrivate: input.isPrivate === true, userId: req.user!.id }, tx,
      );
      await execute(`INSERT INTO chat_members (channel_id, user_id, role) VALUES (:id, :userId, 'owner')`, { id, userId: req.user!.id }, tx);
      for (const member of members) {
        await execute('INSERT INTO chat_members (channel_id, user_id) SELECT :id, u.id FROM users u WHERE u.id = :member AND u.is_active ON CONFLICT DO NOTHING', { id, member }, tx);
      }
    });
    res.status(201).json({ data: { id } });
  }

  static async direct(req: Request, res: Response): Promise<void> {
    const other = String(body(req).userId || '');
    if (!isUuid(other) || other === req.user!.id) throw badRequest('اختر الشخص.');
    const person = await selectOne('SELECT 1 FROM users WHERE id = :other AND is_active', { other });
    if (!person) throw notFound('الشخص غير موجود.');
    const key = [req.user!.id, other].sort().join(':');
    const existing = await selectOne<{ id: string }>('SELECT id FROM chat_channels WHERE direct_key = :key', { key });
    if (existing) { res.json({ data: { id: existing.id } }); return; }
    const id = randomUUID();
    await transaction(async (tx) => {
      await execute(`INSERT INTO chat_channels (id, kind, is_private, direct_key, created_by) VALUES (:id, 'direct', true, :key, :userId)`, { id, key, userId: req.user!.id }, tx);
      await execute('INSERT INTO chat_members (channel_id, user_id) VALUES (:id, :a), (:id, :b)', { id, a: req.user!.id, b: other }, tx);
    });
    res.status(201).json({ data: { id } });
  }

  static async join(req: Request, res: Response): Promise<void> {
    const channel = await selectOne<{ isPrivate: boolean; kind: string }>(
      'SELECT is_private AS "isPrivate", kind FROM chat_channels WHERE id = :id AND archived_at IS NULL', { id: req.params.id },
    );
    if (!channel || channel.kind !== 'channel' || channel.isPrivate) throw notFound('القناة غير موجودة.');
    await execute('INSERT INTO chat_members (channel_id, user_id) VALUES (:id, :userId) ON CONFLICT DO NOTHING', { id: req.params.id, userId: req.user!.id });
    res.json({ data: { ok: true } });
  }

  static async leave(req: Request, res: Response): Promise<void> {
    const general = await selectOne('SELECT 1 FROM chat_channels WHERE id = :id AND direct_key = :key', { id: req.params.id, key: GENERAL });
    if (general) throw badRequest('القناة العامة تبقى لكل الموظفين.');
    await execute('DELETE FROM chat_members WHERE channel_id = :id AND user_id = :userId', { id: req.params.id, userId: req.user!.id });
    res.json({ data: { ok: true } });
  }

  static async addMembers(req: Request, res: Response): Promise<void> {
    const mine = await membership(req.params.id, req.user!.id);
    if (!mine) throw notFound('القناة غير موجودة.');
    const ids = (Array.isArray(body(req).userIds) ? body(req).userIds as unknown[] : []).filter(isUuid) as string[];
    for (const member of ids.slice(0, 500)) {
      await execute('INSERT INTO chat_members (channel_id, user_id) SELECT :id, u.id FROM users u WHERE u.id = :member AND u.is_active ON CONFLICT DO NOTHING', { id: req.params.id, member });
    }
    res.json({ data: { ok: true } });
  }

  static async members(req: Request, res: Response): Promise<void> {
    if (!(await membership(req.params.id, req.user!.id))) throw notFound('القناة غير موجودة.');
    const rows = await select(
      `SELECT u.id, u.name, u.role::text AS role, m.role AS "memberRole" FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = :id ORDER BY u.name`,
      { id: req.params.id },
    );
    res.json({ data: rows });
  }

  static async messages(req: Request, res: Response): Promise<void> {
    if (!(await membership(req.params.id, req.user!.id))) throw notFound('القناة غير موجودة.');
    const after = typeof req.query.after === 'string' && !Number.isNaN(Date.parse(req.query.after)) ? req.query.after : null;
    const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : null;
    const rows = await select(
      `SELECT * FROM (SELECT ${MESSAGE_COLUMNS} FROM chat_messages m JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = :id AND (:after::timestamptz IS NULL OR m.created_at > :after::timestamptz OR m.edited_at > :after::timestamptz OR m.deleted_at > :after::timestamptz)
           AND (:before::timestamptz IS NULL OR m.created_at < :before::timestamptz)
         ORDER BY m.created_at DESC LIMIT 80) x ORDER BY "createdAt"`,
      { id: req.params.id, after, before },
    );
    res.json({ data: rows });
  }

  static async post(req: Request, res: Response): Promise<void> {
    if (!(await membership(req.params.id, req.user!.id))) throw notFound('القناة غير موجودة.');
    const input = body(req);
    const text = typeof input.body === 'string' ? input.body.trim().slice(0, 8000) : '';
    const file = req.file;
    if (!text && !file) throw badRequest('اكتب رسالة أو أرفق ملفاً.');
    const replyTo = isUuid(input.replyTo) ? String(input.replyTo) : null;
    const id = randomUUID();
    let attachment: { key: string; name: string; mime: string; size: number } | null = null;
    if (file) {
      const name = uploadedName(file, 'file');
      attachment = {
        key: await storeFile('chat', file.buffer, safeExtension(name)), name,
        mime: inlineSafeType(file.buffer)?.mime ?? 'application/octet-stream', size: file.size,
      };
    }
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO chat_messages (id, channel_id, user_id, body, reply_to, attachment_key, attachment_name, attachment_mime, attachment_size)
         VALUES (:id, :channel, :userId, :body, :replyTo, :key, :name, :mime, :size)`,
        { id, channel: req.params.id, userId: req.user!.id, body: text || null, replyTo, key: attachment?.key ?? null, name: attachment?.name ?? null, mime: attachment?.mime ?? null, size: attachment?.size ?? null },
        tx,
      );
      await execute('UPDATE chat_channels SET last_message_at = now() WHERE id = :id', { id: req.params.id }, tx);
      await execute('UPDATE chat_members SET last_read_at = now() WHERE channel_id = :id AND user_id = :userId', { id: req.params.id, userId: req.user!.id }, tx);
      // @mentions notify the people named (members of the channel).
      if (text.includes('@')) {
        const members = await select<{ id: string; name: string }>(
          'SELECT u.id, u.name FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = :id AND u.id <> :userId', { id: req.params.id, userId: req.user!.id }, tx,
        );
        const mentioned = members.filter((member) => text.includes(`@${member.name}`) || text.includes(`@${member.name.split(' ')[0]}`)).map((member) => member.id);
        if (text.includes('@الكل') || text.includes('@all')) mentioned.push(...members.map((member) => member.id));
        await notifyUsers(mentioned, { kind: 'chat', title: `${req.user!.name} أشار إليك في المحادثة`, body: text.slice(0, 200), link: `/chat/${req.params.id}` }, tx);
      }
    });
    res.status(201).json({ data: { id, hash: createHash('sha1').update(id).digest('hex').slice(0, 6) } });
  }

  static async edit(req: Request, res: Response): Promise<void> {
    const text = typeof body(req).body === 'string' ? String(body(req).body).trim().slice(0, 8000) : '';
    if (!text) throw badRequest('الرسالة فارغة.');
    const rows = await execute<{ id: string }>(
      'UPDATE chat_messages SET body = :text, edited_at = now() WHERE id = :id AND user_id = :userId AND deleted_at IS NULL RETURNING id',
      { id: req.params.id, userId: req.user!.id, text },
    );
    if (!rows.length) throw forbidden('تعدّل رسائلك فقط.');
    res.json({ data: { ok: true } });
  }

  static async remove(req: Request, res: Response): Promise<void> {
    const rows = await execute<{ id: string }>(
      `UPDATE chat_messages SET deleted_at = now() WHERE id = :id AND deleted_at IS NULL
         AND (user_id = :userId OR :owner) RETURNING id`,
      { id: req.params.id, userId: req.user!.id, owner: req.user!.role === 'super_admin' },
    );
    if (!rows.length) throw forbidden('تحذف رسائلك فقط.');
    res.json({ data: { ok: true } });
  }

  static async react(req: Request, res: Response): Promise<void> {
    const emoji = String(body(req).emoji || '');
    if (!REACTIONS.includes(emoji)) throw badRequest('تفاعل غير معروف.');
    const message = await selectOne<{ channelId: string }>('SELECT channel_id AS "channelId" FROM chat_messages WHERE id = :id', { id: req.params.id });
    if (!message || !(await membership(message.channelId, req.user!.id))) throw notFound('الرسالة غير موجودة.');
    // Toggle the person's reaction.
    await execute(
      `UPDATE chat_messages SET reactions = CASE
         WHEN jsonb_exists(COALESCE(reactions -> :emoji, '[]'::jsonb), :userId) THEN jsonb_set(reactions, ARRAY[:emoji], (reactions -> :emoji) - :userId)
         ELSE jsonb_set(reactions, ARRAY[:emoji], COALESCE(reactions -> :emoji, '[]'::jsonb) || to_jsonb(:userId::text)) END
       WHERE id = :id`,
      { id: req.params.id, emoji, userId: req.user!.id },
    );
    res.json({ data: { ok: true } });
  }

  static async read(req: Request, res: Response): Promise<void> {
    await execute('UPDATE chat_members SET last_read_at = now() WHERE channel_id = :id AND user_id = :userId', { id: req.params.id, userId: req.user!.id });
    res.json({ data: { ok: true } });
  }

  static async file(req: Request, res: Response): Promise<void> {
    const message = await selectOne<{ channelId: string; key: string; name: string; mime: string }>(
      `SELECT channel_id AS "channelId", attachment_key AS key, attachment_name AS name, attachment_mime AS mime
       FROM chat_messages WHERE id = :id AND deleted_at IS NULL AND attachment_key IS NOT NULL`, { id: req.params.id },
    );
    if (!message || !(await membership(message.channelId, req.user!.id)) || !(await storedFileExists(message.key))) throw notFound('الملف غير موجود.');
    const inline = req.query.inline === '1' && ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(message.mime);
    res.setHeader('Content-Type', inline ? message.mime : 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(message.name, inline));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    openStoredFile(message.key).pipe(res);
  }
}

export default ChatController;
