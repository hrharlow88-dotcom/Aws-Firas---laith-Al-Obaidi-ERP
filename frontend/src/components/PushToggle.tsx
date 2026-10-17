import { useEffect, useState } from 'react';
import { BellOff, BellRing, Send } from 'lucide-react';
import { currentSubscription, disablePush, enablePush, pushBlocker } from '../lib/push';
import { useSession } from '../lib/session';
import { Bi } from './Brand';

/** Remembered so the bell does not also show its own alert for what the push already showed. */
export function pushOnHere(): boolean {
  try { return localStorage.getItem('erp.push') === 'on'; } catch { return false; }
}
function remember(on: boolean) {
  try { if (on) localStorage.setItem('erp.push', 'on'); else localStorage.removeItem('erp.push'); } catch { /* private mode */ }
}

const BLOCKED: Record<NonNullable<ReturnType<typeof pushBlocker>>, string> = {
  'ios-browser': 'على الآيفون والآيباد تصل الإشعارات للتطبيق المثبت فقط: من Safari اضغط زر المشاركة ← «إضافة إلى الشاشة الرئيسية»، ثم افتح النظام من أيقونته وفعّلها.',
  unsupported: 'هذا المتصفح لا يستقبل الإشعارات. استعمل Chrome أو Edge أو Safari حديث.',
  denied: 'الإشعارات مرفوضة لهذا الموقع في إعدادات المتصفح. اسمح بها من إعدادات الموقع ثم ارجع هنا.',
};

/**
 * Notifications on this device: on, off, or why not. `compact` is the line in
 * the bell's menu, shown only when there is something to do.
 */
export function PushToggle({ compact }: { compact?: boolean }) {
  const session = useSession();
  const blocker = pushBlocker();
  const [serverOn, setServerOn] = useState<boolean | null>(null);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [askedLocal, setAskedLocal] = useState(false);

  useEffect(() => {
    let live = true;
    session.call<{ data: { publicKey: string | null } }>('/push/config', { background: true })
      .then((result) => { if (live) setServerOn(Boolean(result.data.publicKey)); })
      .catch(() => { if (live) setServerOn(false); });
    currentSubscription().then((subscription) => { if (live) { setSubscribed(Boolean(subscription)); remember(Boolean(subscription)); } })
      .catch(() => { if (live) setSubscribed(false); });
    return () => { live = false; };
  }, [session]);

  async function turnOn() {
    setBusy(true);
    try {
      const result = await enablePush(session);
      if (result === 'enabled') { setSubscribed(true); remember(true); session.notify('فُعّلت الإشعارات على هذا الجهاز.'); }
      else if (result === 'denied') session.notify('لم يُسمح بالإشعارات. يمكنك السماح بها من إعدادات المتصفح للموقع.', true);
      else if (result === 'off') { setServerOn(false); session.notify('إشعارات التلفون متوقفة. يفعّلها مالك النظام.', true); }
      else session.notify(BLOCKED.unsupported, true);
    } catch (error) {
      session.fail(error, 'تعذر تفعيل الإشعارات.');
    } finally {
      setBusy(false);
    }
  }
  async function turnOff() {
    setBusy(true);
    try { await disablePush(session); setSubscribed(false); remember(false); session.notify('أُوقفت الإشعارات على هذا الجهاز.'); }
    finally { setBusy(false); }
  }
  async function test() {
    try {
      const result = await session.call<{ data: { sent: number } }>('/push/test', { method: 'POST' });
      session.notify(result.data.sent ? 'أُرسل إشعار تجريبي. يصل خلال ثوانٍ.' : 'لم يصل لأي جهاز. أوقف الإشعارات وفعّلها من جديد.', !result.data.sent);
    } catch (error) { session.fail(error, 'تعذر الإرسال.'); }
  }

  if (serverOn === null || subscribed === null) return null;
  if (!serverOn) {
    // Push is off for everyone: the bell still offers alerts while the system is open (as before push existed).
    if (compact) {
      return !askedLocal && typeof Notification !== 'undefined' && Notification.permission === 'default'
        ? <button className="o-bell-enable" onClick={() => { setAskedLocal(true); void Notification.requestPermission(); }}><Bi ar="فعّل التنبيهات والنظام مفتوح" en="Alerts while the system is open" /></button>
        : null;
    }
    return <p className="push-line muted"><BellOff size={15} />إشعارات التلفون متوقفة حالياً؛ يفعّلها مالك النظام.</p>;
  }
  if (subscribed) {
    return compact ? null : <div className="push-line">
      <span><BellRing size={15} /><Bi ar="الإشعارات مفعّلة على هذا الجهاز" en="Notifications on this device" /></span>
      <span className="push-actions"><button className="button button-quiet button-small" onClick={() => void test()}><Send size={13} />تجربة</button>
        <button className="button button-quiet button-small" disabled={busy} onClick={() => void turnOff()}>إيقاف</button></span>
    </div>;
  }
  if (blocker) return compact && blocker !== 'ios-browser' ? null : <p className="push-line push-hint"><BellOff size={15} />{BLOCKED[blocker]}</p>;
  return compact
    ? <button className="o-bell-enable" disabled={busy} onClick={() => void turnOn()}><Bi ar="فعّل الإشعارات على هذا الجهاز" en="Turn on notifications here" /></button>
    : <div className="push-line"><span><BellOff size={15} />الإشعارات غير مفعّلة على هذا الجهاز</span>
      <button className="button button-primary button-small" disabled={busy} onClick={() => void turnOn()}><BellRing size={13} />{busy ? 'جارٍ التفعيل…' : 'تفعيل'}</button></div>;
}
