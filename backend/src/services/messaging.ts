import nodemailer from 'nodemailer';
import { fetch } from 'undici';
import { decryptField, encryptField } from '../utils/crypto';
import { execute, select, selectOne } from '../db/query';

/**
 * Outside channels: e-mail (SMTP), WhatsApp (Meta WhatsApp Cloud API) and
 * SMS (any HTTP gateway). Every channel is off until the owner fills in the
 * provider's details and switches it on; while off, nothing leaves the
 * server and HR can still send by hand (mailto / sms / wa.me links).
 */
export type Channel = 'email' | 'whatsapp' | 'sms';
export const CHANNELS: Channel[] = ['email', 'whatsapp', 'sms'];

export interface ChannelState {
  channel: Channel;
  enabled: boolean;
  config: Record<string, string | number | boolean>;
  hasSecret: boolean;
}

const CONFIG_KEYS: Record<Channel, string[]> = {
  email: ['host', 'port', 'secure', 'user', 'fromName', 'fromAddress'],
  whatsapp: ['phoneNumberId', 'apiVersion', 'templateName', 'templateLanguage'],
  sms: ['url', 'toField', 'messageField', 'senderField', 'sender', 'authHeader', 'format'],
};

export function channelConfigKeys(channel: Channel): string[] {
  return CONFIG_KEYS[channel];
}

export async function channelStates(): Promise<ChannelState[]> {
  const rows = await select<{ channel: Channel; enabled: boolean; config: Record<string, string>; secret: string | null }>(
    'SELECT channel, enabled, config, secret_enc AS secret FROM message_channels',
  );
  return CHANNELS.map((channel) => {
    const row = rows.find((item) => item.channel === channel);
    return { channel, enabled: row?.enabled ?? false, config: row?.config ?? {}, hasSecret: Boolean(row?.secret) };
  });
}

export async function saveChannel(channel: Channel, enabled: boolean, config: Record<string, unknown>, secret: string | null | undefined, userId: string): Promise<void> {
  const clean: Record<string, string | number | boolean> = {};
  for (const key of CONFIG_KEYS[channel]) {
    const value = config[key];
    if (typeof value === 'string') clean[key] = value.trim().slice(0, 300);
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'boolean') clean[key] = value;
  }
  const secretEnc = secret ? encryptField(secret) : undefined;
  await execute(
    `INSERT INTO message_channels (channel, enabled, config, secret_enc, updated_by, updated_at)
     VALUES (:channel, :enabled, :config, :secret, :userId, now())
     ON CONFLICT (channel) DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config,
       secret_enc = COALESCE(:secretUpdate, message_channels.secret_enc), updated_by = EXCLUDED.updated_by, updated_at = now()`,
    { channel, enabled, config: JSON.stringify(clean), secret: secretEnc ?? null, secretUpdate: secretEnc ?? null, userId },
  );
}

/** Iraqi mobile numbers to international form without the plus (07xx… → 9647xx…). */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, '').replace(/^\+/, '').replace(/^00/, '');
  if (/^07\d{9}$/.test(digits)) digits = `964${digits.slice(1)}`;
  if (/^7\d{9}$/.test(digits)) digits = `964${digits}`;
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

async function loadChannel(channel: Channel): Promise<{ enabled: boolean; config: Record<string, string>; secret: string | null } | null> {
  const row = await selectOne<{ enabled: boolean; config: Record<string, string>; secret: string | null }>(
    'SELECT enabled, config, secret_enc AS secret FROM message_channels WHERE channel = :channel', { channel },
  );
  if (!row) return null;
  return { ...row, secret: row.secret ? decryptField(row.secret) : null };
}

async function deliver(channel: Channel, recipient: string, subject: string | null, text: string): Promise<void> {
  const settings = await loadChannel(channel);
  if (!settings?.enabled) throw new Error('القناة غير مفعّلة');
  const config = settings.config;
  if (channel === 'email') {
    const transport = nodemailer.createTransport({
      host: config.host, port: Number(config.port) || 587, secure: String(config.secure) === 'true',
      auth: config.user ? { user: config.user, pass: settings.secret ?? '' } : undefined,
    });
    await transport.sendMail({
      // The display name goes through nodemailer's own address object, so quotes or brackets in it cannot change the address.
      from: config.fromName ? { name: String(config.fromName).replace(/["<>\r\n]/g, ' ').trim(), address: String(config.fromAddress) } : String(config.fromAddress),
      to: recipient, subject: subject ?? '', text,
      html: `<div dir="auto" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.8;white-space:pre-wrap">${text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`,
    });
    return;
  }
  if (channel === 'whatsapp') {
    const version = config.apiVersion || 'v20.0';
    const payload = config.templateName
      ? { messaging_product: 'whatsapp', to: recipient, type: 'template', template: {
        name: config.templateName, language: { code: config.templateLanguage || 'ar' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: text.slice(0, 1000) }] }],
      } }
      : { messaging_product: 'whatsapp', to: recipient, type: 'text', text: { body: text.slice(0, 4000) } };
    const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(config.phoneNumberId)}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${settings.secret ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`WhatsApp ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return;
  }
  const fields: Record<string, string> = { [config.toField || 'to']: recipient, [config.messageField || 'message']: text };
  if (config.senderField && config.sender) fields[config.senderField] = config.sender;
  const json = config.format !== 'form';
  const headers: Record<string, string> = { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' };
  if (settings.secret) headers[config.authHeader || 'Authorization'] = settings.secret;
  const response = await fetch(config.url, {
    method: 'POST', headers, body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
  });
  if (!response.ok) throw new Error(`SMS ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

/** Sends what is queued on enabled channels; failures are retried up to three times. */
export async function processOutbox(limit = 20): Promise<number> {
  const queued = await select<{ id: string; channel: Channel; recipient: string; subject: string | null; body: string; attempts: number }>(
    `SELECT o.id, o.channel, o.recipient, o.subject, o.body, o.attempts FROM outbound_messages o
     JOIN message_channels c ON c.channel = o.channel AND c.enabled
     WHERE o.status = 'queued' ORDER BY o.created_at LIMIT :limit`,
    { limit },
  );
  let sent = 0;
  for (const message of queued) {
    try {
      await deliver(message.channel, message.recipient, message.subject, message.body);
      await execute(`UPDATE outbound_messages SET status = 'sent', sent_at = now(), attempts = attempts + 1, error = NULL WHERE id = :id`, { id: message.id });
      sent += 1;
    } catch (error) {
      await execute(
        `UPDATE outbound_messages SET attempts = attempts + 1, error = :error, status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'queued' END WHERE id = :id`,
        { id: message.id, error: (error instanceof Error ? error.message : 'خطأ').slice(0, 500) },
      );
    }
  }
  return sent;
}

/** Sends one test message straight away (owner checking the provider settings). */
export async function sendTest(channel: Channel, recipient: string): Promise<void> {
  await deliver(channel, recipient, 'رسالة اختبار · Test message', 'هذه رسالة اختبار من نظام ERP مجموعة الليث العبيدي للسيارات.\nThis is a test message from the Al-Laith Al-Obaidi Automotive Group ERP.');
}
