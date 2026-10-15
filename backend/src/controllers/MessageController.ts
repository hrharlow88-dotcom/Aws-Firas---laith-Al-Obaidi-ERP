import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { execute, select, transaction } from '../db/query';
import { employeeScopeSql } from '../services/access';
import { Channel, CHANNELS, channelStates, normalizePhone, saveChannel, sendTest } from '../services/messaging';
import { fillTemplate, MESSAGE_TEMPLATES } from '../services/messageTemplates';
import { recordAudit } from '../utils/audit';
import { badRequest, body } from '../utils/http';
import { isUuid } from '../utils/validation';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** E-mail / WhatsApp / SMS to employees with the bilingual templates. */
export class MessageController {
  static async templates(_req: Request, res: Response): Promise<void> {
    res.json({ data: MESSAGE_TEMPLATES });
  }

  static async channels(_req: Request, res: Response): Promise<void> {
    res.json({ data: await channelStates() });
  }

  /** Owner only: provider settings. The secret is stored encrypted and never returned. */
  static async saveChannel(req: Request, res: Response): Promise<void> {
    const channel = req.params.channel as Channel;
    if (!CHANNELS.includes(channel)) throw badRequest('القناة غير معروفة.');
    const input = body(req);
    const config = input.config && typeof input.config === 'object' ? input.config as Record<string, unknown> : {};
    const enabled = input.enabled === true;
    if (enabled) {
      const need: Record<Channel, string[]> = { email: ['host', 'fromAddress'], whatsapp: ['phoneNumberId'], sms: ['url'] };
      const missing = need[channel].filter((key) => typeof config[key] !== 'string' || !String(config[key]).trim());
      if (missing.length) throw badRequest(`أكمل إعدادات القناة قبل تفعيلها: ${missing.join('، ')}`);
      if (channel === 'sms' && !/^https:\/\//.test(String(config.url))) throw badRequest('عنوان بوابة الرسائل يجب أن يبدأ بـ https://');
    }
    const secret = typeof input.secret === 'string' && input.secret ? input.secret.slice(0, 500) : undefined;
    await saveChannel(channel, enabled, config, secret, req.user!.id);
    await recordAudit(req, null, 'messages.channel_saved', 'message_channel', null, { channel, enabled, secretChanged: Boolean(secret) });
    res.json({ data: await channelStates() });
  }

  static async test(req: Request, res: Response): Promise<void> {
    const channel = req.params.channel as Channel;
    if (!CHANNELS.includes(channel)) throw badRequest('القناة غير معروفة.');
    const raw = String(req.body?.recipient || '');
    const recipient = channel === 'email' ? (EMAIL.test(raw) ? raw : null) : normalizePhone(raw);
    if (!recipient) throw badRequest('أدخل عنواناً أو رقماً صحيحاً للاختبار.');
    try {
      await sendTest(channel, recipient);
    } catch (error) {
      throw badRequest(`فشل الإرسال: ${error instanceof Error ? error.message : 'خطأ غير معروف'}`);
    }
    await recordAudit(req, null, 'messages.channel_tested', 'message_channel', null, { channel });
    res.json({ data: { ok: true } });
  }

  /**
   * Prepares one message per employee from a template. Each recipient gets
   * hand-send links (mailto/sms/wa.me); on enabled channels the message is
   * also queued and sent by the server.
   */
  static async send(req: Request, res: Response): Promise<void> {
    const input = body(req);
    const template = MESSAGE_TEMPLATES.find((item) => item.id === input.templateId);
    if (!template) throw badRequest('اختر نموذج الرسالة.');
    const ids = Array.isArray(input.employeeIds) ? input.employeeIds.filter(isUuid) : [];
    if (!ids.length || ids.length > 500) throw badRequest('اختر الموظفين (حتى 500).');
    const channels = (Array.isArray(input.channels) ? input.channels : []).filter((item): item is Channel => CHANNELS.includes(item as Channel));
    const values = input.values && typeof input.values === 'object' ? input.values as Record<string, unknown> : {};
    const subjectOverride = typeof input.subject === 'string' ? input.subject.slice(0, 200) : null;
    const bodyOverride = typeof input.body === 'string' ? input.body.slice(0, 8000) : null;
    const scope = employeeScopeSql(req);
    const people = await select<{ id: string; name: string; employeeNo: string; email: string | null; phone: string | null }>(
      `SELECT e.id, e.full_name AS name, e.employee_no AS "employeeNo", e.email, e.phone FROM employees e WHERE e.id IN (:ids)${scope.sql}`,
      { ids, ...scope.params },
    );
    const enabled = new Set((await channelStates()).filter((state) => state.enabled).map((state) => state.channel));
    const queued: Array<Record<string, unknown>> = [];
    const prepared = people.map((person) => {
      const fill = (text: string) => fillTemplate(text, {
        ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 2000) : ''])),
        name: person.name, employeeNo: person.employeeNo,
      });
      const subject = fill(subjectOverride ?? template.subject);
      const text = fill(bodyOverride ?? template.body);
      const phone = normalizePhone(person.phone);
      const email = person.email && EMAIL.test(person.email) ? person.email : null;
      const targets: Record<Channel, string | null> = { email, whatsapp: phone, sms: phone };
      for (const channel of channels) {
        if (enabled.has(channel) && targets[channel]) {
          queued.push({ id: randomUUID(), channel, recipient: targets[channel], employeeId: person.id, subject, body: text });
        }
      }
      return {
        employeeId: person.id, name: person.name, email, phone, subject, body: text,
        links: {
          email: email ? `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}` : null,
          whatsapp: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : null,
          sms: phone ? `sms:+${phone}?body=${encodeURIComponent(text)}` : null,
        },
      };
    });
    if (queued.length) {
      await transaction(async (tx) => {
        await execute(
          `INSERT INTO outbound_messages (id, channel, recipient, employee_id, subject, body, related_kind, created_by)
           SELECT x.id, x.channel, x.recipient, x."employeeId", x.subject, x.body, :kind, :userId
           FROM jsonb_to_recordset(:rows::jsonb) AS x(id uuid, channel varchar, recipient varchar, "employeeId" uuid, subject varchar, body text)`,
          { rows: JSON.stringify(queued), kind: template.id, userId: req.user!.id },
          tx,
        );
        await recordAudit(req, tx, 'messages.queued', 'outbound_message', null, { template: template.id, count: queued.length, channels });
      });
    }
    res.json({
      data: {
        prepared, queued: queued.length,
        disabledChannels: channels.filter((channel) => !enabled.has(channel)),
      },
    });
  }

  static async outbox(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT o.id, o.channel, o.recipient, o.subject, o.status, o.attempts, o.error, o.created_at AS "createdAt", o.sent_at AS "sentAt",
              e.full_name AS "employeeName", u.name AS "createdByName", o.related_kind AS "relatedKind"
       FROM outbound_messages o LEFT JOIN employees e ON e.id = o.employee_id LEFT JOIN users u ON u.id = o.created_by
       ORDER BY o.created_at DESC LIMIT 300`,
    );
    res.json({ data: rows });
  }
}

export default MessageController;
