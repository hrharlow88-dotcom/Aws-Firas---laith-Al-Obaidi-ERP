import { Request, Response } from 'express';
import {
  deviceCount, pushEndpointAllowed, pushPublicKey, pushStatus, removeSubscription, saveSubscription, sendPush, setPushEnabled,
} from '../services/push';
import { recordAudit } from '../utils/audit';
import { assertOnlyKeys, badRequest, body, conflict } from '../utils/http';

function subscription(input: Record<string, unknown>): { endpoint: string; p256dh: string; auth: string } {
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  const keys = input.keys && typeof input.keys === 'object' ? input.keys as Record<string, unknown> : {};
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
  const auth = typeof keys.auth === 'string' ? keys.auth : '';
  if (!endpoint || endpoint.length > 1000 || !pushEndpointAllowed(endpoint)) throw badRequest('عنوان الإشعارات من المتصفح غير صالح.');
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,100}$/.test(auth)) throw badRequest('مفاتيح الإشعارات من المتصفح غير صالحة.');
  return { endpoint, p256dh, auth };
}

/** Notifications on phones and computers: each person turns them on per device; the owner switches the channel. */
export class PushController {
  static async config(req: Request, res: Response): Promise<void> {
    res.json({ data: { publicKey: await pushPublicKey(), devices: await deviceCount(req.user!.id) } });
  }

  static async subscribe(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['endpoint', 'keys', 'expirationTime', 'device']);
    if (!(await pushPublicKey())) throw conflict('إشعارات التلفون غير مفعّلة. يفعّلها مالك النظام من لوحة المالك ← القنوات.');
    const device = typeof input.device === 'string' ? input.device : (req.header('user-agent') ?? null);
    await saveSubscription(req.user!.id, subscription(input), device);
    res.status(201).json({ data: { devices: await deviceCount(req.user!.id) } });
  }

  static async unsubscribe(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['endpoint']);
    if (typeof input.endpoint !== 'string') throw badRequest('حدد الجهاز.');
    await removeSubscription(req.user!.id, input.endpoint);
    res.json({ data: { devices: await deviceCount(req.user!.id) } });
  }

  /** A test notice to my own devices. */
  static async test(req: Request, res: Response): Promise<void> {
    const result = await sendPush([req.user!.id], {
      title: 'إشعار تجريبي من النظام', body: 'تصلك الإشعارات على هذا الجهاز حتى والنظام مغلق.', link: '/home', tag: 'test',
    });
    res.json({ data: result });
  }

  static async status(_req: Request, res: Response): Promise<void> {
    res.json({ data: await pushStatus() });
  }

  static async setChannel(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['enabled']);
    if (typeof input.enabled !== 'boolean') throw badRequest('حدد التفعيل أو الإيقاف.');
    await setPushEnabled(input.enabled, req.user!.id);
    await recordAudit(req, null, input.enabled ? 'push.enabled' : 'push.disabled', 'message_channel', null);
    res.json({ data: await pushStatus() });
  }
}
