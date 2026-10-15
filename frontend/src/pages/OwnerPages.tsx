import { ChangeEvent, useState } from 'react';
import {
  Download, EyeOff, Fingerprint, Image, LogOut, MapPin, RefreshCw, RotateCcw, Save, ShieldCheck, Trash2, Upload,
} from 'lucide-react';
import { Bi, refreshBrands, useBrands } from '../components/Brand';
import { Dialog, Empty, Loading, Stat, Tabs, Tone, useReasonPrompt } from '../components/ui';
import { downloadFile } from '../lib/api';
import { APPS, en } from '../lib/apps';
import { formatDateTime, formatNumber } from '../lib/format';
import { useLoad, useSession } from '../lib/session';
import type { SecuritySettings, SystemSettings } from '../SettingsPage';

const SEVERITY: Record<string, { label: string; tone: string }> = {
  critical: { label: 'حرج · Critical', tone: 'bad' }, high: { label: 'عالٍ · High', tone: 'bad' },
  medium: { label: 'متوسط · Medium', tone: 'warn' }, low: { label: 'منخفض · Low', tone: 'info' },
};

interface LoginRow {
  id: string; at: string; channel: string; ip: string | null; userAgent: string | null; latitude: number | null; longitude: number | null;
  accuracy: number | null; locationStatus: string; userId: string; userName: string; username: string | null; role: string; employeeNo: string | null;
}

function exactTime(value: string): string {
  return new Intl.DateTimeFormat('ar-IQ-u-nu-latn', {
    weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: 'Asia/Baghdad',
  }).format(new Date(value));
}

function device(agent: string | null): string {
  if (!agent) return '—';
  const os = /iphone|ipad/i.test(agent) ? 'iOS' : /android/i.test(agent) ? 'Android' : /windows/i.test(agent) ? 'Windows' : /mac os/i.test(agent) ? 'macOS' : /linux/i.test(agent) ? 'Linux' : '';
  const browser = /edg\//i.test(agent) ? 'Edge' : /chrome\//i.test(agent) ? 'Chrome' : /safari\//i.test(agent) ? 'Safari' : /firefox\//i.test(agent) ? 'Firefox' : '';
  return [os, browser].filter(Boolean).join(' · ') || agent.slice(0, 40);
}

function MapView({ latitude, longitude }: { latitude: number; longitude: number }) {
  const d = 0.004;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${longitude - d},${latitude - d},${longitude + d},${latitude + d}&layer=mapnik&marker=${latitude},${longitude}`;
  return <div className="map-frame">
    <iframe title="موقع تسجيل الدخول" src={src} loading="lazy" referrerPolicy="no-referrer" />
    <a href={`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`} target="_blank" rel="noreferrer">فتح الخريطة · Open map</a>
  </div>;
}

/** The security guard: alerts, the sign-in trail with time and place, who is online, and the audit chain check. */
export function GuardPage() {
  const session = useSession();
  const [tab, setTab] = useState<'alerts' | 'logins' | 'online' | 'events'>('alerts');
  const overview = useLoad<{ openAlerts: number; critical: number; high: number; chain: { entries: number; broken: number; lastHash: string | null };
    online: Array<{ id: string; name: string; role: string; lastSeenAt: string; ip: string | null }>; loginsToday: number; failedLogins24h: number; refused24h: number }
    | null>('/security/overview', null);
  const [allAlerts, setAllAlerts] = useState(false);
  const alerts = useLoad<Array<{ id: string; at: string; severity: string; kind: string; title: string; details: Record<string, unknown> | null; ip: string | null; userName: string | null; resolvedAt: string | null; resolvedByName: string | null; resolution: string | null; userId: string | null }>>(`/security/alerts${allAlerts ? '?status=all' : ''}`, []);
  const [filter, setFilter] = useState({ from: '', to: '', channel: '' });
  const logins = useLoad<LoginRow[]>(tab === 'logins' ? `/security/logins?from=${filter.from}&to=${filter.to}&channel=${filter.channel}` : null, []);
  const events = useLoad<Array<{ id: string; at: string; kind: string; ip: string | null; path: string | null; userName: string | null }>>(tab === 'events' ? '/security/events' : null, []);
  const [map, setMap] = useState<LoginRow | null>(null);
  const reason = useReasonPrompt();
  const o = overview.data;

  async function resolve(id: string) {
    const resolution = await reason.ask('ما الذي اتُّخذ بشأن التنبيه؟');
    if (!resolution) return;
    try { await session.call(`/security/alerts/${id}/resolve`, { method: 'POST', body: { resolution } }); alerts.reload(); overview.reload(); }
    catch (error) { session.fail(error, 'تعذر الحفظ.'); }
  }
  async function signOut(userId: string, name: string) {
    if (!window.confirm(`إنهاء كل جلسات ${name} الآن؟`)) return;
    try { await session.call(`/security/users/${userId}/sign-out`, { method: 'POST' }); session.notify('أُنهيت جلساته.'); overview.reload(); }
    catch (error) { session.fail(error, 'تعذر الإنهاء.'); }
  }
  async function scan() {
    try { const result = await session.call<{ data: { raised: number } }>('/security/scan', { method: 'POST' }); session.notify(`اكتملت الجولة: ${result.data.raised} تنبيه جديد.`); alerts.reload(); overview.reload(); }
    catch (error) { session.fail(error, 'تعذرت الجولة.'); }
  }

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="الحارس الأمني" en="Security guard" /></h2>
        <p>موظف إلكتروني يجول على النظام كل دقيقتين: محاولات الاختراق وتخمين كلمات المرور، الطلبات المرفوضة المتكررة، التنزيل الكثيف، التعديلات الحساسة خارج الدوام، الدخول من عناوين جديدة، وأي تلاعب بسجل التدقيق المتسلسل. يبلّغك فوراً ولا يقرر بدلاً عنك.</p></div>
        <button className="button button-primary" onClick={() => void scan()}><ShieldCheck size={16} />جولة الآن · Scan now</button></div>
      {!o ? <Loading /> : <div className="stat-row">
        <Stat label="تنبيهات مفتوحة · Open alerts" value={formatNumber(o.openAlerts)} tone={o.critical + o.high ? 'bad' : o.openAlerts ? 'warn' : 'good'} foot={o.critical ? `${o.critical} حرج` : undefined} />
        <Stat label="سلامة سجل التدقيق · Audit chain" value={o.chain.broken ? 'تلاعب!' : 'سليم'} tone={o.chain.broken ? 'bad' : 'good'} foot={`${formatNumber(o.chain.entries)} عملية مسلسلة`} />
        <Stat label="متصلون الآن · Online" value={formatNumber(o.online.length)} />
        <Stat label="دخول اليوم · Sign-ins today" value={formatNumber(o.loginsToday)} foot={`${o.failedLogins24h} محاولة فاشلة · ${o.refused24h} مرفوض (24س)`} />
      </div>}
      <Tabs value={tab} onChange={setTab} items={[
        { id: 'alerts', label: 'التنبيهات · Alerts', badge: o?.openAlerts }, { id: 'logins', label: 'سجل الدخول والمواقع · Sign-ins' },
        { id: 'online', label: 'المتصلون · Online', badge: o?.online.length }, { id: 'events', label: 'الأحداث الخام · Events' },
      ]} />
      {tab === 'alerts' && <section className="panel">
        <label className="settings-check"><input type="checkbox" checked={allAlerts} onChange={(event) => setAllAlerts(event.target.checked)} />إظهار المعالجة أيضاً</label>
        {alerts.loading ? <Loading /> : !alerts.data.length ? <Empty icon={<ShieldCheck size={22} />} title="لا توجد تنبيهات" text="النظام هادئ. · All quiet." />
          : <div className="table-scroll"><table className="dense"><thead><tr><th>الوقت</th><th>الخطورة</th><th>التنبيه</th><th>الشخص / العنوان</th><th /></tr></thead>
            <tbody>{alerts.data.map((row) => <tr key={row.id} className={row.resolvedAt ? 'row-muted' : ''}>
              <td>{formatDateTime(row.at)}</td><td><Tone tone={SEVERITY[row.severity].tone}>{SEVERITY[row.severity].label}</Tone></td>
              <td><strong>{row.title}</strong>{row.details && <small className="table-sub" dir="ltr">{JSON.stringify(row.details).slice(0, 140)}</small>}
                {row.resolvedAt && <small className="table-sub">عولج: {row.resolution} — {row.resolvedByName}</small>}</td>
              <td>{row.userName ?? '—'}<small className="table-sub" dir="ltr">{row.ip}</small></td>
              <td className="row-actions">{!row.resolvedAt && <button className="button button-quiet button-small" onClick={() => void resolve(row.id)}>معالجة</button>}
                {!row.resolvedAt && row.userId && <button className="button button-quiet button-small" onClick={() => void signOut(row.userId!, row.userName ?? '')}><LogOut size={13} />إنهاء جلساته</button>}</td>
            </tr>)}</tbody></table></div>}
      </section>}
      {tab === 'logins' && <section className="panel">
        <div className="filter-bar">
          <label className="field"><span>من</span><input type="date" value={filter.from} onChange={(event) => setFilter({ ...filter, from: event.target.value })} /></label>
          <label className="field"><span>إلى</span><input type="date" value={filter.to} onChange={(event) => setFilter({ ...filter, to: event.target.value })} /></label>
          <label className="field"><span>القناة</span><select value={filter.channel} onChange={(event) => setFilter({ ...filter, channel: event.target.value })}>
            <option value="">الكل</option><option value="portal">بوابة الموظفين</option><option value="staff">الإدارة</option></select></label>
        </div>
        {logins.loading ? <Loading /> : <div className="table-scroll"><table className="dense"><thead><tr><th>اليوم والوقت (حتى الثانية)</th><th>الشخص</th><th>القناة</th><th>الجهاز</th><th>العنوان</th><th>الموقع</th></tr></thead>
          <tbody>{logins.data.map((row) => <tr key={row.id}>
            <td><strong>{exactTime(row.at)}</strong></td>
            <td>{row.userName}<small className="table-sub">{row.employeeNo ?? row.username ?? row.role}</small></td>
            <td>{row.channel === 'portal' ? 'البوابة' : 'الإدارة'}</td><td>{device(row.userAgent)}</td><td dir="ltr">{row.ip}</td>
            <td>{row.latitude !== null && row.longitude !== null
              ? <button className="button button-quiet button-small" onClick={() => setMap(row)}><MapPin size={13} />خريطة ±{row.accuracy ?? '?'}م</button>
              : <Tone tone={row.locationStatus === 'denied' ? 'warn' : 'muted'}>{row.locationStatus === 'denied' ? 'رفض المشاركة' : row.locationStatus === 'pending' ? 'لم يُرسل' : 'غير متاح'}</Tone>}</td>
          </tr>)}</tbody></table></div>}
      </section>}
      {tab === 'online' && <section className="panel">{!o?.online.length ? <Empty icon={<Fingerprint size={22} />} title="لا أحد متصل" text="—" />
        : <div className="table-scroll"><table className="dense"><thead><tr><th>الشخص</th><th>آخر نشاط</th><th>العنوان</th><th /></tr></thead>
          <tbody>{o.online.map((row) => <tr key={row.id}><td>{row.name}<small className="table-sub">{row.role}</small></td><td>{exactTime(row.lastSeenAt)}</td><td dir="ltr">{row.ip}</td>
            <td>{row.id !== session.user.id && <button className="button button-quiet button-small" onClick={() => void signOut(row.id, row.name)}><LogOut size={13} />إنهاء الجلسة</button>}</td></tr>)}</tbody></table></div>}
      </section>}
      {tab === 'events' && <section className="panel">{events.loading ? <Loading /> : <div className="table-scroll"><table className="dense">
        <thead><tr><th>الوقت</th><th>النوع</th><th>الشخص</th><th>العنوان</th><th>المسار</th></tr></thead>
        <tbody>{events.data.map((row) => <tr key={row.id}><td>{formatDateTime(row.at)}</td><td>{row.kind}</td><td>{row.userName ?? '—'}</td><td dir="ltr">{row.ip}</td><td dir="ltr">{row.path}</td></tr>)}</tbody></table></div>}
      </section>}
      <Dialog wide open={Boolean(map)} title={map ? `${map.userName} — ${exactTime(map.at)}` : ''} subtitle={map ? `${map.latitude?.toFixed(5)}, ${map.longitude?.toFixed(5)} · ±${map.accuracy ?? '?'} م` : ''} onClose={() => setMap(null)}>
        {map?.latitude !== null && map?.longitude !== null && map && <MapView latitude={map.latitude!} longitude={map.longitude!} />}
      </Dialog>
      {reason.element}
    </section>
  );
}

const MODULE_LABEL: Record<string, string> = Object.fromEntries([
  ...APPS.map((app) => [app.id, app.label]),
  ['archive', 'الأرشيف'], ['communication', 'التواصل'], ['owner', 'لوحة المالك'], ['approvals', 'الاعتمادات'], ['auth', 'الدخول'], ['other', 'أخرى'],
]);

/** Who did what, where and when: visits, reads and changes per person and per app. */
export function ActivityPage() {
  const users = useLoad<Array<{ id: string; name: string; role: string }>>('/users', []);
  const [filter, setFilter] = useState({ from: '', to: '', userId: '', module: '', kind: '' });
  const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value)).toString();
  const data = useLoad<{ rows: Array<{ id: string; at: string; kind: string; module: string; method: string | null; path: string; status: number | null; durationMs: number | null; ip: string | null; userId: string; userName: string; role: string }>;
    byUser: Array<{ userId: string; userName: string; role: string; visits: string; writes: string; refused: string; firstAt: string; lastAt: string }>;
    byModule: Array<{ module: string; visits: string; writes: string; people: string }>; totals: { visits: string; writes: string; people: string } | null }>(
    `/activity?${query}`, { rows: [], byUser: [], byModule: [], totals: null });
  const [tab, setTab] = useState<'people' | 'modules' | 'log'>('people');
  const t = data.data.totals;
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="حركات النظام وزياراته" en="System activity" /></h2><p>تتبع كامل لكل مستخدم ومدير: كل شاشة فتحها، وكل أمر نفّذه، ومتى ومن أي عنوان، ونتيجته — موزعة على التطبيقات.</p></div></div>
      <section className="panel"><div className="filter-bar">
        <label className="field"><span>من</span><input type="date" value={filter.from} onChange={(event) => setFilter({ ...filter, from: event.target.value })} /></label>
        <label className="field"><span>إلى</span><input type="date" value={filter.to} onChange={(event) => setFilter({ ...filter, to: event.target.value })} /></label>
        <label className="field"><span>المستخدم</span><select value={filter.userId} onChange={(event) => setFilter({ ...filter, userId: event.target.value })}><option value="">الكل</option>{users.data.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
        <label className="field"><span>التطبيق</span><select value={filter.module} onChange={(event) => setFilter({ ...filter, module: event.target.value })}><option value="">الكل</option>{Object.entries(MODULE_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label className="field"><span>النوع</span><select value={filter.kind} onChange={(event) => setFilter({ ...filter, kind: event.target.value })}><option value="">الكل</option><option value="visit">زيارة شاشة</option><option value="write">تعديل / أمر</option><option value="read">قراءة</option></select></label>
      </div></section>
      <div className="stat-row"><Stat label="زيارات · Visits" value={formatNumber(Number(t?.visits ?? 0))} /><Stat label="أوامر وتعديلات · Changes" value={formatNumber(Number(t?.writes ?? 0))} /><Stat label="أشخاص · People" value={formatNumber(Number(t?.people ?? 0))} /></div>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'people', label: 'حسب الشخص · People' }, { id: 'modules', label: 'حسب التطبيق · Apps' }, { id: 'log', label: 'السجل التفصيلي · Log' }]} />
      <section className="panel">{data.loading ? <Loading /> : tab === 'people' ? <div className="table-scroll"><table className="dense">
        <thead><tr><th>المستخدم</th><th>زيارات</th><th>تعديلات</th><th>مرفوض</th><th>أول نشاط</th><th>آخر نشاط</th></tr></thead>
        <tbody>{data.data.byUser.map((row) => <tr key={row.userId} className="row-link" onClick={() => { setFilter({ ...filter, userId: row.userId }); setTab('log'); }}>
          <td><strong>{row.userName}</strong><small className="table-sub">{row.role}</small></td><td>{row.visits}</td><td>{row.writes}</td><td>{Number(row.refused) ? <Tone tone="warn">{row.refused}</Tone> : 0}</td>
          <td>{formatDateTime(row.firstAt)}</td><td>{formatDateTime(row.lastAt)}</td></tr>)}</tbody></table></div>
        : tab === 'modules' ? <div className="module-bars">{data.data.byModule.map((row) => {
          const max = Math.max(...data.data.byModule.map((item) => Number(item.visits) + Number(item.writes)), 1);
          const total = Number(row.visits) + Number(row.writes);
          return <button key={row.module} className="module-bar" onClick={() => { setFilter({ ...filter, module: row.module }); setTab('log'); }}>
            <span>{MODULE_LABEL[row.module] ?? row.module}<small> {en(MODULE_LABEL[row.module] ?? '')}</small></span>
            <i style={{ width: `${(total / max) * 100}%` }} /><b>{row.visits} زيارة · {row.writes} تعديل · {row.people} شخص</b>
          </button>;
        })}</div>
        : <div className="table-scroll"><table className="dense"><thead><tr><th>الوقت</th><th>المستخدم</th><th>التطبيق</th><th>العملية</th><th>النتيجة</th></tr></thead>
          <tbody>{data.data.rows.map((row) => <tr key={row.id}><td>{formatDateTime(row.at)}</td><td>{row.userName}</td><td>{MODULE_LABEL[row.module] ?? row.module}</td>
            <td dir="ltr"><span className={`activity-kind kind-${row.kind}`}>{row.kind === 'visit' ? 'VISIT' : row.method}</span> {row.path}</td>
            <td>{row.status ? <Tone tone={row.status >= 400 ? 'bad' : 'good'}>{row.status}</Tone> : '—'}{row.durationMs !== null && <small className="table-sub">{row.durationMs}ms</small>}</td></tr>)}</tbody></table></div>}
      </section>
    </section>
  );
}

/** Recycle bin: everything deleted, with who and when, restorable by the owner. */
export function RecycleBinPage() {
  const session = useSession();
  const [state, setState] = useState<'open' | 'restored' | 'purged'>('open');
  const items = useLoad<Array<{ id: string; entityType: string; title: string; module: string; reason: string | null; deletedAt: string; deletedByName: string; restoredAt: string | null; restoredByName: string | null; purgedAt: string | null }>>(`/recycle-bin?state=${state}`, []);
  async function act(id: string, action: 'restore' | 'purge') {
    if (action === 'purge' && !window.confirm('إزالة نهائية من السلة؟ لا يمكن التراجع، ويبقى أثر الحذف في سجل التدقيق.')) return;
    try { await session.call(`/recycle-bin/${id}/${action}`, { method: 'POST' }); items.reload(); session.notify(action === 'restore' ? 'استُرجع العنصر.' : 'أُزيل نهائياً.'); }
    catch (error) { session.fail(error, 'تعذر التنفيذ.'); }
  }
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="سلة المحذوفات" en="Recycle bin" /></h2><p>كل ما يُحذف في النظام (مستمسكات، وثائق الأرشيف، مبالغ الرواتب، المواعيد، الإعلانات، أشهر الأرشيف) يأتي هنا بنسخة كاملة، ويمكن استرجاعه.</p></div></div>
      <Tabs value={state} onChange={setState} items={[{ id: 'open', label: 'في السلة · In bin' }, { id: 'restored', label: 'مسترجعة · Restored' }, { id: 'purged', label: 'أزيلت نهائياً · Purged' }]} />
      <section className="panel">{items.loading ? <Loading /> : !items.data.length ? <Empty icon={<Trash2 size={22} />} title="السلة فارغة" text="لا توجد عناصر." />
        : <div className="table-scroll"><table className="dense"><thead><tr><th>العنصر</th><th>التطبيق</th><th>حذفه</th><th>السبب</th><th /></tr></thead>
          <tbody>{items.data.map((row) => <tr key={row.id}><td><strong>{row.title}</strong><small className="table-sub">{row.entityType}</small></td><td>{MODULE_LABEL[row.module] ?? row.module}</td>
            <td>{row.deletedByName}<small className="table-sub">{formatDateTime(row.deletedAt)}</small></td><td>{row.reason ?? '—'}{row.restoredAt && <small className="table-sub">استرجعه {row.restoredByName} {formatDateTime(row.restoredAt)}</small>}</td>
            <td className="row-actions">{state === 'open' && <><button className="button button-quiet button-small" onClick={() => void act(row.id, 'restore')}><RotateCcw size={13} />استرجاع</button>
              <button className="button button-quiet button-small" onClick={() => void act(row.id, 'purge')}><Trash2 size={13} />إزالة نهائية</button></>}</td></tr>)}</tbody></table></div>}
      </section>
    </section>
  );
}

const CHANNEL_FIELDS: Record<string, Array<{ key: string; label: string; type?: string }>> = {
  email: [{ key: 'host', label: 'خادم SMTP (مثل smtp.office365.com)' }, { key: 'port', label: 'المنفذ (587)' }, { key: 'secure', label: 'SSL مباشر (true/false)' },
    { key: 'user', label: 'اسم المستخدم' }, { key: 'fromName', label: 'اسم المرسل' }, { key: 'fromAddress', label: 'عنوان المرسل' }],
  whatsapp: [{ key: 'phoneNumberId', label: 'Phone number ID (Meta)' }, { key: 'apiVersion', label: 'إصدار الواجهة (v20.0)' },
    { key: 'templateName', label: 'اسم القالب المعتمد (للرسائل الأولى)' }, { key: 'templateLanguage', label: 'لغة القالب (ar)' }],
  sms: [{ key: 'url', label: 'رابط بوابة الرسائل https://' }, { key: 'toField', label: 'اسم حقل الرقم (to)' }, { key: 'messageField', label: 'اسم حقل النص (message)' },
    { key: 'senderField', label: 'اسم حقل المرسل' }, { key: 'sender', label: 'اسم المرسل' }, { key: 'authHeader', label: 'ترويسة المفتاح (Authorization)' }, { key: 'format', label: 'json أو form' }],
};
const SECRET_LABEL: Record<string, string> = { email: 'كلمة مرور البريد', whatsapp: 'رمز الوصول (Access token)', sms: 'مفتاح البوابة (API key)' };

/** Owner console: what the interface shows, the brands, sign-in and guard settings, outside channels, module managers, and the company template. */
export function OwnerPage() {
  const session = useSession();
  const [tab, setTab] = useState<'interface' | 'brands' | 'security' | 'channels' | 'managers' | 'clone'>('interface');
  const [draft, setDraft] = useState<SystemSettings>(() => JSON.parse(JSON.stringify(session.settings)));
  const [busy, setBusy] = useState(false);
  const brands = useBrands();
  const channels = useLoad<Array<{ channel: string; enabled: boolean; config: Record<string, string>; hasSecret: boolean }>>('/messages/channels', []);
  const users = useLoad<Array<{ id: string; name: string; role: string; isActive: boolean }>>('/users', []);
  const [editing, setEditing] = useState<string | null>(null);
  const [channelDraft, setChannelDraft] = useState<{ enabled: boolean; config: Record<string, string>; secret: string }>({ enabled: false, config: {}, secret: '' });
  const [testTo, setTestTo] = useState('');
  const security: SecuritySettings = draft.security ?? { idleMinutes: 15, askLocationOnLogin: true, workdayStart: '07:00', workdayEnd: '21:00', failedLoginAlertThreshold: 8, exportAlertThreshold: 15 };
  const ui = draft.ui ?? { hiddenApps: [], brands: [], moduleManagers: {} };

  async function saveSettings() {
    setBusy(true);
    try {
      await session.call('/settings', { method: 'PUT', body: draft });
      session.notify('حُفظت إعدادات المالك.');
      session.refreshSettings();
    } catch (error) { session.fail(error, 'تعذر الحفظ.'); } finally { setBusy(false); }
  }
  async function uploadLogo(brandId: string, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.set('file', file);
    try { await session.call(`/owner/brands/${brandId}/logo`, { form }); refreshBrands(); session.notify('رُفع الشعار.'); session.refreshSettings(); }
    catch (error) { session.fail(error, 'تعذر رفع الشعار.'); }
  }
  async function removeLogo(brandId: string) {
    try { await session.call(`/owner/brands/${brandId}/logo`, { method: 'DELETE' }); refreshBrands(); session.refreshSettings(); }
    catch (error) { session.fail(error, 'تعذر الإزالة.'); }
  }
  async function saveChannel() {
    if (!editing) return;
    try {
      await session.call(`/messages/channels/${editing}`, { method: 'PUT', body: { enabled: channelDraft.enabled, config: channelDraft.config, secret: channelDraft.secret || undefined } });
      session.notify('حُفظت القناة.');
      setEditing(null);
      channels.reload();
    } catch (error) { session.fail(error, 'تعذر حفظ القناة.'); }
  }
  async function importTemplate(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const body = JSON.parse(await file.text());
      const result = await session.call<{ data: Record<string, number> }>('/owner/template', { method: 'POST', body });
      session.notify(`طُبّق القالب: ${result.data.branches} فرع، ${result.data.departments} قسم، ${result.data.jobTitles} مسمى، ${result.data.shifts} دوام.`);
      session.refreshSettings();
    } catch (error) { session.fail(error, 'تعذر تطبيق القالب.'); }
  }
  const setSecurity = (patch: Partial<SecuritySettings>) => setDraft({ ...draft, security: { ...security, ...patch } });
  const toggleApp = (id: string) => setDraft({ ...draft, ui: { ...ui, hiddenApps: ui.hiddenApps.includes(id) ? ui.hiddenApps.filter((app) => app !== id) : [...ui.hiddenApps, id] } });

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="لوحة مالك النظام" en="System owner console" /></h2><p>تحكم مالك النظام وحده: ما يظهر في الواجهة، العلامات وشعاراتها، مدة الجلسة والحارس الأمني، قنوات الإرسال، مسؤولو التطبيقات، واستنساخ النظام لشركة أخرى.</p></div>
        {['interface', 'security', 'managers'].includes(tab) && <button className="button button-primary" disabled={busy} onClick={() => void saveSettings()}><Save size={16} />حفظ · Save</button>}</div>
      <Tabs value={tab} onChange={setTab} items={[
        { id: 'interface', label: 'الواجهة · Interface' }, { id: 'brands', label: 'العلامات · Brands' }, { id: 'security', label: 'الجلسة والأمان · Security' },
        { id: 'channels', label: 'القنوات · Channels' }, { id: 'managers', label: 'مسؤولو التطبيقات · App owners' }, { id: 'clone', label: 'استنساخ لشركة · Clone' },
      ]} />
      {tab === 'interface' && <section className="panel">
        <div className="panel-head"><div><h3>التطبيقات الظاهرة للمستخدمين</h3><p>المخفي لا يظهر لأحد غيرك (ويبقى يعمل في الخلفية). الصلاحيات ما زالت تُطبق على الخادم.</p></div></div>
        <div className="app-toggles">{APPS.map((app) => { const Icon = app.icon; const hiddenNow = ui.hiddenApps.includes(app.id); return <label key={app.id} className={`app-toggle ${hiddenNow ? 'is-hidden' : ''}`}>
          <input type="checkbox" checked={!hiddenNow} onChange={() => toggleApp(app.id)} />
          <span className="o-app-icon small" style={{ background: `linear-gradient(145deg, ${app.colors[0]}, ${app.colors[1]})` }}><Icon size={20} /></span>
          <span><strong>{app.label}</strong><small>{en(app.label)}</small></span>{hiddenNow && <EyeOff size={15} />}
        </label>; })}</div>
      </section>}
      {tab === 'brands' && <section className="panel">
        <div className="panel-head"><div><h3>علامات المجموعة وشعاراتها</h3><p>بالترتيب: روكس أولاً وملتي براند آخراً. ارفع شعار كل علامة من ملفاتكم الرسمية (PNG أو JPG، خلفية شفافة أفضل). تظهر تحت اسم النظام في الدخول والرئيسية.</p></div></div>
        <div className="brand-admin">{brands.map((brand) => <div key={brand.id} className="brand-admin-card">
          <div className="brand-admin-logo">{brand.logo ? <img src={brand.logo} alt={brand.name} /> : <Image size={28} />}</div>
          <strong>{brand.name}</strong>
          <div className="row-actions">
            <label className="button button-quiet button-small"><Upload size={13} />رفع<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => void uploadLogo(brand.id, event)} /></label>
            {brand.logo && <button className="button button-quiet button-small" onClick={() => void removeLogo(brand.id)}><Trash2 size={13} /></button>}
          </div>
        </div>)}</div>
      </section>}
      {tab === 'security' && <section className="panel"><div className="form-grid">
        <label className="field"><span>إنهاء الجلسة بعد عدم النشاط (دقيقة) · Idle sign-out</span><input type="number" min={5} max={480} value={security.idleMinutes} onChange={(event) => setSecurity({ idleMinutes: Number(event.target.value) })} /><small>الافتراضي 15 دقيقة. يظهر تنبيه قبلها بدقيقة.</small></label>
        <label className="settings-check"><input type="checkbox" checked={security.askLocationOnLogin} onChange={(event) => setSecurity({ askLocationOnLogin: event.target.checked })} />طلب الموقع عند الدخول (يظهر على الخريطة في الحارس الأمني)</label>
        <label className="field"><span>بداية الدوام</span><input type="time" value={security.workdayStart} onChange={(event) => setSecurity({ workdayStart: event.target.value })} /></label>
        <label className="field"><span>نهاية الدوام</span><input type="time" value={security.workdayEnd} onChange={(event) => setSecurity({ workdayEnd: event.target.value })} /><small>التعديلات الحساسة خارج هذا الوقت تُنبَّه.</small></label>
        <label className="field"><span>محاولات دخول خاطئة من عنوان واحد خلال 15 دقيقة</span><input type="number" min={3} max={100} value={security.failedLoginAlertThreshold} onChange={(event) => setSecurity({ failedLoginAlertThreshold: Number(event.target.value) })} /></label>
        <label className="field"><span>تنزيلات ملفات من شخص خلال ساعة</span><input type="number" min={3} max={500} value={security.exportAlertThreshold} onChange={(event) => setSecurity({ exportAlertThreshold: Number(event.target.value) })} /></label>
      </div></section>}
      {tab === 'channels' && <section className="panel">
        <div className="panel-head"><div><h3>قنوات الإرسال الخارجية</h3><p>لا يُرسل شيء خارج النظام حتى تفعّل القناة هنا بإعدادات مزوّدك. الأسرار تُحفظ مشفّرة ولا تُعرض مرة أخرى. واتساب يحتاج حساب WhatsApp Business على منصة Meta.</p></div></div>
        <div className="channel-cards">{['email', 'whatsapp', 'sms'].map((id) => { const state = channels.data.find((item) => item.channel === id); return <div key={id} className="channel-card">
          <strong>{id === 'email' ? 'البريد الإلكتروني · E-mail' : id === 'whatsapp' ? 'واتساب · WhatsApp' : 'رسائل نصية · SMS'}</strong>
          <Tone tone={state?.enabled ? 'good' : 'muted'}>{state?.enabled ? 'مفعّلة' : 'متوقفة (إرسال يدوي)'}</Tone>
          <button className="button button-quiet button-small" onClick={() => { setEditing(id); setChannelDraft({ enabled: state?.enabled ?? false, config: { ...(state?.config ?? {}) }, secret: '' }); }}>إعداد</button>
        </div>; })}</div>
      </section>}
      {tab === 'managers' && <section className="panel">
        <div className="panel-head"><div><h3>مسؤول كل تطبيق</h3><p>حدد المدير المسؤول عن كل تطبيق؛ يظهر اسمه في التطبيق، وتجد نشاطه في «حركات النظام».</p></div></div>
        <div className="settings-list">{APPS.filter((app) => !app.href).map((app) => <div key={app.id} className="approval-row">
          <span className="approval-number" style={{ background: app.colors[1] }}><app.icon size={15} /></span>
          <strong style={{ minWidth: 160 }}>{app.label}</strong>
          <select multiple value={ui.moduleManagers[app.id] ?? []} onChange={(event) => setDraft({ ...draft, ui: { ...ui, moduleManagers: { ...ui.moduleManagers, [app.id]: Array.from(event.target.selectedOptions).map((option) => option.value).slice(0, 10) } } })}>
            {users.data.filter((user) => user.isActive !== false && user.role !== 'employee').map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </div>)}</div>
      </section>}
      {tab === 'clone' && <section className="panel">
        <div className="panel-head"><div><h3>استنساخ النظام لشركة أخرى · Clone for another company</h3>
          <p>١) نزّل قالب الشركة: الإعدادات والأدوار وقواعد الرواتب والإجازات والفروع والأقسام والمسميات والدوامات — بلا موظفين أو رواتب أو ملفات أو كلمات مرور.<br />
            ٢) شغّل نسخة جديدة مستقلة على السيرفر (قاعدة بيانات ونطاق منفصلان) بالأمر <code dir="ltr">./new-company.sh &lt;name&gt; &lt;domain&gt;</code> من مجلد deploy.<br />
            ٣) ادخل للنسخة الجديدة كمالك وارفع القالب هنا.</p></div></div>
        <div className="row-actions">
          <button className="button button-primary" onClick={() => void downloadFile('/owner/template', session.token, 'company-template.json').catch((error) => session.fail(error, 'تعذر التنزيل.'))}><Download size={15} />تنزيل قالب هذه الشركة</button>
          <label className="button button-quiet"><Upload size={15} />تطبيق قالب على نسخة جديدة<input type="file" accept="application/json,.json" hidden onChange={(event) => void importTemplate(event)} /></label>
        </div>
      </section>}
      <Dialog open={Boolean(editing)} title={`إعداد القناة: ${editing ?? ''}`} onClose={() => setEditing(null)}>
        {editing && <div className="form-grid">
          {CHANNEL_FIELDS[editing].map((field) => <label key={field.key} className="field"><span>{field.label}</span><input dir="ltr" value={channelDraft.config[field.key] ?? ''} onChange={(event) => setChannelDraft({ ...channelDraft, config: { ...channelDraft.config, [field.key]: event.target.value } })} /></label>)}
          <label className="field"><span>{SECRET_LABEL[editing]}</span><input type="password" dir="ltr" autoComplete="new-password" value={channelDraft.secret} placeholder={channels.data.find((item) => item.channel === editing)?.hasSecret ? '•••••• (محفوظ؛ اتركه فارغاً للإبقاء)' : ''} onChange={(event) => setChannelDraft({ ...channelDraft, secret: event.target.value })} /></label>
          <label className="settings-check settings-wide"><input type="checkbox" checked={channelDraft.enabled} onChange={(event) => setChannelDraft({ ...channelDraft, enabled: event.target.checked })} />تفعيل الإرسال التلقائي عبر هذه القناة</label>
          <div className="dialog-actions settings-wide"><button className="button button-primary" onClick={() => void saveChannel()}><Save size={15} />حفظ</button></div>
          <div className="settings-wide filter-bar"><input dir="ltr" placeholder={editing === 'email' ? 'you@company.com' : '07xxxxxxxxx'} value={testTo} onChange={(event) => setTestTo(event.target.value)} />
            <button className="button button-quiet" onClick={async () => { try { await session.call(`/messages/channels/${editing}/test`, { method: 'POST', body: { recipient: testTo } }); session.notify('أُرسلت رسالة الاختبار.'); } catch (error) { session.fail(error, 'فشل الاختبار.'); } }}><RefreshCw size={14} />رسالة اختبار</button></div>
        </div>}
      </Dialog>
    </section>
  );
}

