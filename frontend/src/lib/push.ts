import type { Session } from './session';

/**
 * Notifications on this device (Web Push). The server holds one subscription
 * per browser or installed app; the owner switches the channel on.
 * iPhone and iPad receive them only in the app added to the home screen.
 */

export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches
  || (navigator as Navigator & { standalone?: boolean }).standalone === true;
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function pushSupported(): boolean {
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Why push cannot be turned on here, or null when it can. */
export function pushBlocker(): 'ios-browser' | 'unsupported' | 'denied' | null {
  if (isIos() && !isStandalone()) return 'ios-browser';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return null;
}

function keyBytes(base64: string): ArrayBuffer {
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes.buffer;
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const device = /iphone/i.test(ua) ? 'iPhone' : /ipad/i.test(ua) ? 'iPad' : /android/i.test(ua) ? 'Android' : /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'Mac' : 'جهاز';
  const browser = /edg\//i.test(ua) ? 'Edge' : /chrome|crios/i.test(ua) ? 'Chrome' : /firefox|fxios/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : '';
  return `${device}${browser ? ` · ${browser}` : ''}${isStandalone() ? ' · التطبيق' : ''}`;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

export type EnableResult = 'enabled' | 'off' | 'denied' | 'unsupported';

/** Asks this device for permission and registers it with the server. */
export async function enablePush(session: Session): Promise<EnableResult> {
  if (!pushSupported()) return 'unsupported';
  const config = await session.call<{ data: { publicKey: string | null } }>('/push/config');
  if (!config.data.publicKey) return 'off';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.data.publicKey) });
  }
  await session.call('/push/subscriptions', { body: { ...subscription.toJSON(), device: deviceLabel() } });
  return 'enabled';
}

export async function disablePush(session: Session): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await session.call('/push/subscriptions', { method: 'DELETE', body: { endpoint: subscription.endpoint } }).catch(() => undefined);
  await subscription.unsubscribe().catch(() => undefined);
}
