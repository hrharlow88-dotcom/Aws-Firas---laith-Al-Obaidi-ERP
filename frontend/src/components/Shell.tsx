import { Bi, BiText } from './Brand';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, BellRing, CheckCheck, Download, Megaphone, ShieldAlert, Timer } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { navigate } from '../lib/router';
import { useSession } from '../lib/session';
import { formatDateTime } from '../lib/format';
import { PushToggle, pushOnHere } from './PushToggle';

interface Notice { id: string; kind: string; title: string; body: string | null; link: string | null; createdAt: string; readAt: string | null }

/** The bell in the top bar: in-app notifications, polled in the background. */
export function NotificationBell() {
  const session = useSession();
  const [items, setItems] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  const first = useRef(true);

  const load = useCallback(async () => {
    try {
      const result = await session.call<{ data: { items: Notice[]; unread: number } }>('/notifications', { background: true });
      setItems(result.data.items);
      setUnread(result.data.unread);
      // A desktop notification for anything new, when the person allowed it.
      if (!first.current && !pushOnHere() && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        for (const item of result.data.items.filter((entry) => !entry.readAt && !seen.current.has(entry.id)).slice(0, 3)) {
          new Notification(item.title, { body: item.body ?? '', icon: '/brand/shield-256.png', tag: item.id });
        }
      }
      result.data.items.forEach((item) => seen.current.add(item.id));
      first.current = false;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) session.signOut();
    }
  }, [session]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60000);
    return () => window.clearInterval(timer);
  }, [load]);

  // Closes on a tap elsewhere, Escape, or a new screen.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : event.type === 'hashchange' || !box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('hashchange', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); window.removeEventListener('hashchange', close); };
  }, [open]);

  async function openItem(item: Notice) {
    setOpen(false);
    if (!item.readAt) await session.call('/notifications/read', { method: 'POST', body: { ids: [item.id] } }).catch(() => undefined);
    void load();
    if (item.link) window.location.hash = `#${item.link}`;
  }

  return (
    <div className="o-bell" ref={box}>
      <button className="o-bell-button" onClick={() => setOpen(!open)} aria-label={`الإشعارات (${unread})`} aria-expanded={open}>
        {unread ? <BellRing size={18} /> : <Bell size={18} />}
        {unread > 0 && <span className="o-bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && <div className="o-bell-menu" role="menu">
        <div className="o-bell-head"><strong><Bi ar={"الإشعارات"} en={"Notifications"} /></strong>
          {unread > 0 && <button className="button button-quiet button-small" onClick={async () => { await session.call('/notifications/read', { method: 'POST', body: { all: true } }); void load(); }}><CheckCheck size={14} />قراءة الكل</button>}
        </div>
        <PushToggle compact />
        <div className="o-bell-list">
          {items.length ? items.map((item) => <button key={item.id} className={`o-bell-item ${item.readAt ? '' : 'is-unread'}`} onClick={() => void openItem(item)}>
            <strong>{item.title}</strong>{item.body && <span>{item.body}</span>}<small>{formatDateTime(item.createdAt)}</small>
          </button>) : <p className="muted o-bell-empty">لا توجد إشعارات.</p>}
        </div>
      </div>}
    </div>
  );
}

interface Announcement {
  id: string; titleAr: string; titleEn: string | null; bodyAr: string; bodyEn: string | null; kind: string; severity: string;
  requireAck: boolean; startsAt: string; signedByTitle: string | null; createdByName: string;
}

export const ANNOUNCEMENT_KIND: Record<string, string> = {
  announcement: 'إعلان · Announcement', alert: 'تنبيه · Alert', notice: 'تبليغ · Notice', invitation: 'دعوة · Invitation', circular: 'تعميم · Circular',
};

/** Announcements shown full screen until seen (or acknowledged when required). */
export function AnnouncementGate() {
  const session = useSession();
  const [queue, setQueue] = useState<Announcement[]>([]);
  const load = useCallback(async () => {
    try {
      const result = await session.call<{ data: Announcement[] }>('/me/announcements/pending', { background: true });
      setQueue(result.data);
    } catch { /* the bell handles expired sessions */ }
  }, [session]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 120000);
    return () => window.clearInterval(timer);
  }, [load]);
  const current = queue[0];
  if (!current) return null;
  async function close(acknowledge: boolean) {
    await session.call(`/me/announcements/${current.id}/seen`, { method: 'POST', body: { acknowledge } }).catch(() => undefined);
    setQueue((rows) => rows.slice(1));
  }
  return (
    <div className={`announce-screen announce-${current.severity}`} role="dialog" aria-modal="true" aria-labelledby="announce-title">
      <article className="announce-card">
        <header>
          <span className="announce-kind"><Megaphone size={16} /><BiText text={ANNOUNCEMENT_KIND[current.kind] ?? current.kind} /></span>
          {current.severity !== 'info' && <span className="announce-severity"><ShieldAlert size={15} />{current.severity === 'urgent' ? 'عاجل · Urgent' : 'مهم · Important'}</span>}
        </header>
        <img className="announce-mark" src="/brand/shield-256.png" alt="" />
        <h2 id="announce-title">{current.titleAr}</h2>
        {current.titleEn && <h3 dir="ltr">{current.titleEn}</h3>}
        <div className="announce-body">
          <p>{current.bodyAr}</p>
          {current.bodyEn && <p dir="ltr">{current.bodyEn}</p>}
        </div>
        <footer>
          <span>{current.signedByTitle ?? 'إدارة النظام — الموارد البشرية'} · {formatDateTime(current.startsAt)}</span>
          <div className="announce-actions">
            {current.requireAck
              ? <button className="button button-primary" onClick={() => void close(true)}><CheckCheck size={16} /><Bi ar={"أقرّ بالاطلاع"} en={"I acknowledge"} /></button>
              : <button className="button button-primary" onClick={() => void close(false)}><Bi ar={"اطلعت"} en={"Got it"} /></button>}
            {queue.length > 1 && <small>{queue.length - 1} إعلان آخر · more</small>}
          </div>
        </footer>
      </article>
    </div>
  );
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Signs out after the owner's idle limit (15 minutes by default). A minute
 * before, a warning offers to stay signed in.
 */
export function IdleGuard({ minutes }: { minutes: number }) {
  const session = useSession();
  const last = useRef(Date.now());
  const pinged = useRef(Date.now());
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const mark = () => { last.current = Date.now(); };
    ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, mark, { passive: true }));
    const timer = window.setInterval(() => {
      const remaining = minutes * 60 - Math.floor((Date.now() - last.current) / 1000);
      // Reading or typing without saving still counts: tell the server every few minutes.
      if (last.current > pinged.current && Date.now() - pinged.current > 180000) {
        pinged.current = Date.now();
        void session.call('/auth/me').catch(() => undefined);
      }
      if (remaining <= 0) {
        session.notify(`انتهت الجلسة بعد ${minutes} دقيقة بلا نشاط.`, true);
        session.signOut();
      } else setLeft(remaining <= 60 ? remaining : null);
    }, 1000);
    return () => {
      window.clearInterval(timer);
      ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, mark));
    };
  }, [minutes, session]);
  if (left === null) return null;
  return (
    <div className="idle-warning" role="alertdialog" aria-live="assertive">
      <Timer size={20} />
      <div><strong>ستنتهي الجلسة خلال {left} ثانية</strong><span>Your session ends in {left}s because of inactivity.</span></div>
      <button className="button button-primary" onClick={() => {
        last.current = Date.now();
        setLeft(null);
        void session.call('/auth/me').catch(() => undefined);
      }}><Bi ar={"البقاء متصلاً"} en={"Stay signed in"} /></button>
    </div>
  );
}

/** Records each screen the person opens (who visited what, and when). */
export function useVisitTracking(page: string, params: string[], module: string | undefined) {
  const session = useSession();
  useEffect(() => {
    const route = `/${[page, ...params].join('/')}`;
    void session.call('/activity/visit', { method: 'POST', body: { route: route.slice(0, 200), module: module ?? 'other' } }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, params.join('/')]);
}

/** After sign-in, asks the browser for the location (the person can refuse) and records it with the sign-in. */
export function reportLoginLocation(token: string, eventId: string): void {
  const send = (body: Record<string, unknown>) => void api('/auth/login-location', token, { method: 'POST', body: { eventId, ...body } }).catch(() => undefined);
  if (!('geolocation' in navigator)) { send({ status: 'unavailable' }); return; }
  navigator.geolocation.getCurrentPosition(
    (position) => send({ status: 'shared', latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy }),
    (error) => send({ status: error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable' }),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
}

interface InstallPrompt extends Event { prompt: () => Promise<void> }
let deferredInstall: InstallPrompt | null = null;
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstall = event as InstallPrompt; });

/** Android, Windows and macOS browsers offer their own install dialog; null elsewhere (iPhone uses the Share sheet). */
export function canPromptInstall(): boolean {
  return Boolean(deferredInstall);
}

export async function promptInstall(): Promise<boolean> {
  if (!deferredInstall) return false;
  const prompt = deferredInstall;
  deferredInstall = null;
  await prompt.prompt();
  return true;
}

/** "Install the app" for Android, Windows and macOS (Chrome/Edge); iPhone and iPad get the Share-sheet steps. */
export function InstallAppButton() {
  const [help, setHelp] = useState(false);
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  if (standalone) return null;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return (
    <>
      <button onClick={async () => {
        if (!(await promptInstall())) setHelp(!help);
      }}><Download size={15} /><Bi ar={"تثبيت التطبيق"} en={"Install app"} /></button>
      {help && <p className="install-help">{ios
        ? 'على آيفون وآيباد: افتح النظام في Safari ← زر المشاركة ← «إضافة إلى الشاشة الرئيسية».'
        : 'في Chrome أو Edge: من القائمة ⋮ اختر «تثبيت التطبيق» أو «Install». على أندرويد: «إضافة إلى الشاشة الرئيسية».'}</p>}
    </>
  );
}

export function goTo(link: string) {
  const [page, ...params] = link.replace(/^\//, '').split('/');
  navigate(page, ...params);
}
