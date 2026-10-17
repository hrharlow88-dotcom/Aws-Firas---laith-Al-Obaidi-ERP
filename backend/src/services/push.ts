import webpush from 'web-push';
import { randomUUID } from 'node:crypto';
import { Transaction } from 'sequelize';
import { execute, select, selectOne } from '../db/query';
import { decryptField, encryptField } from '../utils/crypto';

/**
 * Notifications pushed to phones and computers (Web Push), even when the
 * system is closed. A channel like e-mail and WhatsApp: off until the owner
 * switches it on. The keys (VAPID) are made here on first use; the private
 * one is stored encrypted. Each person turns notifications on per device.
 */

export interface PushNotice { title: string; body?: string | null; link?: string | null; tag?: string | null }

interface Channel { enabled: boolean; publicKey: string | null; privateKey: string | null }

/** Browsers' push services; a subscription pointing anywhere else is refused (the server posts to it). */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
];

export function pushEndpointAllowed(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some((host) => host.test(url.hostname));
  } catch {
    return false;
  }
}

function subject(): string {
  const base = process.env.PUBLIC_URL || (process.env.ERP_DOMAIN ? `https://${process.env.ERP_DOMAIN}` : '');
  return /^https:\/\//.test(base) ? base : 'mailto:admin@example.com';
}

let cached: { at: number; value: Channel } | null = null;

async function channel(): Promise<Channel> {
  // Every in-app notice asks whether to push; the answer is kept for half a minute.
  if (cached && Date.now() - cached.at < 30000) return cached.value;
  const row = await selectOne<{ enabled: boolean; config: { publicKey?: string }; secret: string | null }>(
    "SELECT enabled, config, secret_enc AS secret FROM message_channels WHERE channel = 'push'",
  );
  const value = {
    enabled: Boolean(row?.enabled),
    publicKey: row?.config?.publicKey ?? null,
    privateKey: row?.secret ? decryptField(row.secret) : null,
  };
  cached = { at: Date.now(), value };
  return value;
}

/** What the owner console shows. */
export async function pushStatus(): Promise<{ enabled: boolean; devices: number; people: number }> {
  const state = await channel();
  const counts = await selectOne<{ devices: number; people: number }>(
    'SELECT count(*)::int AS devices, count(DISTINCT user_id)::int AS people FROM push_subscriptions',
  );
  return { enabled: state.enabled, devices: counts?.devices ?? 0, people: counts?.people ?? 0 };
}

/** The public key the browser needs to subscribe; null while the owner has push off. */
export async function pushPublicKey(): Promise<string | null> {
  const state = await channel();
  return state.enabled && state.publicKey ? state.publicKey : null;
}

/** Switches push on or off; the keys are made the first time it is switched on and then kept. */
export async function setPushEnabled(enabled: boolean, userId: string): Promise<void> {
  const state = await channel();
  let { publicKey, privateKey } = state;
  if (enabled && (!publicKey || !privateKey)) {
    const keys = webpush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
  }
  await execute(
    `INSERT INTO message_channels (channel, enabled, config, secret_enc, updated_by, updated_at)
     VALUES ('push', :enabled, :config, :secret, :userId, now())
     ON CONFLICT (channel) DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config,
       secret_enc = COALESCE(EXCLUDED.secret_enc, message_channels.secret_enc), updated_by = EXCLUDED.updated_by, updated_at = now()`,
    {
      enabled, config: JSON.stringify(publicKey ? { publicKey } : {}),
      secret: privateKey ? encryptField(privateKey) : null, userId,
    },
  );
  cached = null;
}

export async function saveSubscription(
  userId: string, input: { endpoint: string; p256dh: string; auth: string }, device: string | null,
): Promise<void> {
  // A device that changes hands (another account signs in on it) belongs to the newer account.
  await execute(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, device)
     VALUES (:id, :userId, :endpoint, :p256dh, :auth, :device)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
       device = EXCLUDED.device, failures = 0`,
    { id: randomUUID(), userId, ...input, device: device ? device.slice(0, 200) : null },
  );
}

export async function removeSubscription(userId: string, endpoint: string): Promise<number> {
  const rows = await execute<{ id: string }>(
    'DELETE FROM push_subscriptions WHERE user_id = :userId AND endpoint = :endpoint RETURNING id', { userId, endpoint },
  );
  return rows.length;
}

export async function deviceCount(userId: string): Promise<number> {
  const row = await selectOne<{ count: number }>('SELECT count(*)::int AS count FROM push_subscriptions WHERE user_id = :userId', { userId });
  return row?.count ?? 0;
}

/**
 * Sends to every device of these people. Never throws: a failed device is
 * counted, and one the push service no longer knows (404/410) is removed.
 */
export async function sendPush(userIds: string[], notice: PushNotice): Promise<{ sent: number; failed: number }> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  try {
    const state = await channel();
    if (!state.enabled || !state.publicKey || !state.privateKey) return { sent, failed };
    const devices = await select<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s JOIN users u ON u.id = s.user_id AND u.is_active
       WHERE s.user_id IN (:ids)`,
      { ids },
    );
    const payload = JSON.stringify({
      title: notice.title.slice(0, 120),
      body: (notice.body ?? '').slice(0, 300),
      link: notice.link ? notice.link.slice(0, 300) : null,
      tag: notice.tag ?? null,
    });
    await Promise.all(devices.map(async (device) => {
      if (!pushEndpointAllowed(device.endpoint)) return;
      try {
        await webpush.sendNotification(
          { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
          payload,
          { vapidDetails: { subject: subject(), publicKey: state.publicKey!, privateKey: state.privateKey! }, TTL: 24 * 3600, timeout: 10000 },
        );
        sent += 1;
        await execute('UPDATE push_subscriptions SET last_success_at = now(), failures = 0 WHERE id = :id', { id: device.id });
      } catch (error) {
        failed += 1;
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await execute('DELETE FROM push_subscriptions WHERE id = :id', { id: device.id });
        else await execute('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = :id', { id: device.id });
      }
    }));
    await execute('DELETE FROM push_subscriptions WHERE failures >= 20');
  } catch (error) {
    console.error('push failed', error instanceof Error ? error.message : error);
  }
  return { sent, failed };
}

/** Pushes once the surrounding transaction commits (nothing is pushed for a change that rolled back). */
export function pushAfterCommit(userIds: string[], notice: PushNotice, tx?: Transaction | null): void {
  if (!userIds.length) return;
  const send = () => { void sendPush(userIds, notice); };
  if (tx && typeof (tx as Transaction & { afterCommit?: unknown }).afterCommit === 'function') tx.afterCommit(send);
  else setImmediate(send);
}
