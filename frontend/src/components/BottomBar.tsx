import { ReactNode, useState } from 'react';
import {
  CalendarDays, CircleUserRound, ClipboardCheck, Download, KeyRound, LayoutGrid, LogOut, Menu, MessageSquarePlus, MessagesSquare,
} from 'lucide-react';
import { useChatUnread } from '../lib/chatUnread';
import { isIos, isStandalone } from '../lib/push';
import { navigate } from '../lib/router';
import { Bi } from './Brand';
import { PushToggle } from './PushToggle';
import { canPromptInstall, promptInstall } from './Shell';
import { Dialog } from './ui';

interface Item { page: string; label: string; en: string; icon: typeof LayoutGrid; badge?: number }

/**
 * The phone's tab bar, like an installed app: the screens people open most,
 * one thumb away. Shown only on phones (responsive.css); computers keep the top bar.
 */
export function BottomBar({ page, staff, onFeedback, onSignOut, appearance }: {
  page: string; staff: boolean; onFeedback: () => void; onSignOut: () => void; appearance: ReactNode;
}) {
  const unread = useChatUnread();
  const [more, setMore] = useState(false);
  const items: Item[] = staff
    ? [
      { page: 'home', label: 'الرئيسية', en: 'Home', icon: LayoutGrid },
      { page: 'approvals', label: 'اعتماداتي', en: 'Approvals', icon: ClipboardCheck },
      { page: 'chat', label: 'المحادثات', en: 'Chat', icon: MessagesSquare, badge: unread },
      { page: 'my', label: 'خدمتي', en: 'Me', icon: CircleUserRound },
    ]
    : [
      { page: 'home', label: 'الرئيسية', en: 'Home', icon: LayoutGrid },
      { page: 'my', label: 'خدمتي', en: 'Me', icon: CircleUserRound },
      { page: 'chat', label: 'المحادثات', en: 'Chat', icon: MessagesSquare, badge: unread },
      { page: 'calendar', label: 'التقويم', en: 'Calendar', icon: CalendarDays },
    ];
  return (
    <>
      <nav className="o-bottom-bar no-print" aria-label="التنقل السريع">
        {items.map((item) => {
          const Icon = item.icon;
          const active = page === item.page || (item.page === 'my' && page === 'my-payslip');
          return <button key={item.page} className={active ? 'is-active' : ''} aria-current={active ? 'page' : undefined} onClick={() => navigate(item.page)}>
            <span className="o-bottom-icon"><Icon size={21} />{item.badge ? <span className="o-bottom-badge">{item.badge > 99 ? '99+' : item.badge}</span> : null}</span>
            <Bi ar={item.label} en={item.en} block />
          </button>;
        })}
        <button className={more ? 'is-active' : ''} onClick={() => setMore(true)} aria-haspopup="dialog">
          <span className="o-bottom-icon"><Menu size={21} /></span><Bi ar="المزيد" en="More" block />
        </button>
      </nav>
      <MoreSheet open={more} onClose={() => setMore(false)} onFeedback={() => { setMore(false); onFeedback(); }} onSignOut={onSignOut} appearance={appearance} />
    </>
  );
}

function MoreSheet({ open, onClose, onFeedback, onSignOut, appearance }: {
  open: boolean; onClose: () => void; onFeedback: () => void; onSignOut: () => void; appearance: ReactNode;
}) {
  const [installHelp, setInstallHelp] = useState(false);
  const go = (page: string) => { onClose(); navigate(page); };
  return (
    <Dialog open={open} title="المزيد · More" onClose={onClose} sheet>
      <div className="more-sheet">
        <section><h4>الإشعارات</h4><PushToggle /></section>
        {!isStandalone() && <section>
          <button className="more-row" onClick={async () => { if (!(await promptInstall())) setInstallHelp(!installHelp); }}><Download size={18} /><Bi ar="تثبيت التطبيق على الشاشة الرئيسية" en="Install the app" /></button>
          {installHelp && <InstallSteps />}
        </section>}
        <section>
          <button className="more-row" onClick={onFeedback}><MessageSquarePlus size={18} /><Bi ar="ملاحظة على النظام" en="Send feedback" /></button>
          <button className="more-row" onClick={() => go('security')}><KeyRound size={18} /><Bi ar="أمان الحساب والتوقيع" en="Account security" /></button>
        </section>
        <section className="more-appearance">{appearance}</section>
        <section><button className="more-row more-danger" onClick={onSignOut}><LogOut size={18} /><Bi ar="تسجيل الخروج" en="Sign out" /></button></section>
      </div>
    </Dialog>
  );
}

/** The two ways to put the system on the home screen: iPhone's Share sheet, or the browser menu elsewhere. */
export function InstallSteps() {
  return isIos()
    ? <ol className="install-steps">
      <li>افتح النظام في <strong>Safari</strong>.</li>
      <li>اضغط زر <strong>المشاركة</strong> (المربع والسهم للأعلى) أسفل الشاشة.</li>
      <li>اختر <strong>«إضافة إلى الشاشة الرئيسية»</strong> ثم «إضافة».</li>
      <li>افتح النظام من أيقونته الجديدة، وفعّل الإشعارات من «المزيد».</li>
    </ol>
    : <ol className="install-steps">
      <li>افتح قائمة المتصفح <strong>⋮</strong> أعلى الشاشة.</li>
      <li>اختر <strong>«تثبيت التطبيق»</strong> أو <strong>«إضافة إلى الشاشة الرئيسية»</strong>.</li>
      <li>افتح النظام من أيقونته؛ يعمل بملء الشاشة مثل التطبيقات.</li>
    </ol>;
}

/** «ثبّت النظام»: a one-time card on the phone's home screen until installed or put off. */
export function InstallBanner() {
  const [hidden, setHidden] = useState(() => {
    try { return Number(localStorage.getItem('erp.installLater') ?? 0) > Date.now(); } catch { return false; }
  });
  const [help, setHelp] = useState(false);
  const phone = window.matchMedia('(max-width: 760px)').matches || window.matchMedia('(pointer: coarse)').matches;
  if (hidden || isStandalone() || !phone) return null;
  const later = () => {
    try { localStorage.setItem('erp.installLater', String(Date.now() + 14 * 86400000)); } catch { /* private mode */ }
    setHidden(true);
  };
  return (
    <aside className="install-banner" aria-label="تثبيت التطبيق">
      <img src="/brand/icon-192.png" alt="" width={48} height={48} />
      <div>
        <strong>ثبّت النظام على شاشتك الرئيسية</strong>
        <p>يفتح بملء الشاشة مثل التطبيقات، وتصلك الإشعارات على التلفون.</p>
        {help && <InstallSteps />}
      </div>
      <div className="install-banner-actions">
        <button className="button button-primary button-small" onClick={async () => { if (!canPromptInstall() || !(await promptInstall())) setHelp(true); }}><Download size={14} />تثبيت</button>
        <button className="button button-quiet button-small" onClick={later}>لاحقاً</button>
      </div>
    </aside>
  );
}
