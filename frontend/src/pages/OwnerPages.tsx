import { ChangeEvent, useState } from 'react';
import {
  Download, EyeOff, Plus, Fingerprint, Image, LogOut, MapPin, RefreshCw, RotateCcw, Save, ShieldCheck, Trash2, Upload,
} from 'lucide-react';
import { Bi, refreshBrands, useBrands, BiText } from '../components/Brand';
import { EDITABLE_TEXTS } from '../lib/texts';
import { DemoAccounts } from './DemoAccounts';
import { Dialog, Empty, Loading, Stat, Tabs, Tone, useReasonPrompt } from '../components/ui';
import { downloadFile } from '../lib/api';
import { APPS, en, orderedApps } from '../lib/apps';
import { formatDateTime, formatNumber } from '../lib/format';
import { useLoad, useSession } from '../lib/session';
import { FirewallPanel, RadarPanel, ScanPanel } from './SecurityRadar';
import { DEFAULT_PORTAL, PortalSettings } from '../lib/portal';
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
    <a href={`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`} target="_blank" rel="noreferrer"><Bi ar={"فتح الخريطة"} en={"Open map"} /></a>
  </div>;
}

/** The security guard: alerts, the sign-in trail with time and place, who is online, and the audit chain check. */
export function GuardPage() {
  const session = useSession();
  const [tab, setTab] = useState<'radar' | 'scan' | 'firewall' | 'alerts' | 'logins' | 'online' | 'events'>('radar');
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
        <button className="button button-primary" onClick={() => void scan()}><ShieldCheck size={16} /><Bi ar={"جولة الآن"} en={"Scan now"} /></button></div>
      {!o ? <Loading /> : <div className="stat-row">
        <Stat label="تنبيهات مفتوحة · Open alerts" value={formatNumber(o.openAlerts)} tone={o.critical + o.high ? 'bad' : o.openAlerts ? 'warn' : 'good'} foot={o.critical ? `${o.critical} حرج` : undefined} />
        <Stat label="سلامة سجل التدقيق · Audit chain" value={o.chain.broken ? 'تلاعب!' : 'سليم'} tone={o.chain.broken ? 'bad' : 'good'} foot={`${formatNumber(o.chain.entries)} عملية مسلسلة`} />
        <Stat label="متصلون الآن · Online" value={formatNumber(o.online.length)} />
        <Stat label="دخول اليوم · Sign-ins today" value={formatNumber(o.loginsToday)} foot={`${o.failedLogins24h} محاولة فاشلة · ${o.refused24h} مرفوض (24س)`} />
      </div>}
      <Tabs value={tab} onChange={setTab} items={[
        { id: 'radar', label: 'الرادار · Radar' }, { id: 'scan', label: 'فحص الثغرات · Scan' }, { id: 'firewall', label: 'جدار الحماية · Firewall' },
        { id: 'alerts', label: 'التنبيهات · Alerts', badge: o?.openAlerts }, { id: 'logins', label: 'سجل الدخول والمواقع · Sign-ins' },
        { id: 'online', label: 'المتصلون · Online', badge: o?.online.length }, { id: 'events', label: 'الأحداث الخام · Events' },
      ]} />
      {tab === 'radar' && <section className="panel"><RadarPanel /></section>}
      {tab === 'scan' && <section className="panel"><ScanPanel /></section>}
      {tab === 'firewall' && <section className="panel"><FirewallPanel /></section>}
      {tab === 'alerts' && <section className="panel">
        <label className="settings-check"><input type="checkbox" checked={allAlerts} onChange={(event) => setAllAlerts(event.target.checked)} />إظهار المعالجة أيضاً</label>
        {alerts.loading ? <Loading /> : !alerts.data.length ? <Empty icon={<ShieldCheck size={22} />} title="لا توجد تنبيهات" text="النظام هادئ. · All quiet." />
          : <div className="table-scroll"><table className="dense"><thead><tr><th>الوقت</th><th>الخطورة</th><th>التنبيه</th><th>الشخص / العنوان</th><th /></tr></thead>
            <tbody>{alerts.data.map((row) => <tr key={row.id} className={row.resolvedAt ? 'row-muted' : ''}>
              <td>{formatDateTime(row.at)}</td><td><Tone tone={SEVERITY[row.severity].tone}><BiText text={SEVERITY[row.severity].label} /></Tone></td>
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

type PortalSwitch = Exclude<keyof PortalSettings, 'welcome'>;
/** The parts of «خدمتي» the owner opens or closes, grouped as the employee sees them. */
const PORTAL_GROUPS: Array<{ title: string; items: Array<{ key: PortalSwitch; label: string; hint?: string }> }> = [
  { title: 'بطاقة الموظف', items: [
    { key: 'card', label: 'البطاقة أعلى البوابة', hint: 'الصورة، المنصب، الفرع، المباشرة' },
    { key: 'showManager', label: 'اسم المدير المباشر' },
    { key: 'showShift', label: 'الدوام' },
    { key: 'photoUpload', label: 'إرسال الصورة الشخصية', hint: 'تصل الموارد البشرية لتعتمدها' },
  ] },
  { title: 'الحضور والإجازات', items: [
    { key: 'attendance', label: 'البصمة والحضور والتأخير' },
    { key: 'leaveBalances', label: 'أرصدة الإجازات' },
    { key: 'leaveRequests', label: 'طلب إجازة' },
    { key: 'hourlyLeave', label: 'إجازة زمنية' },
  ] },
  { title: 'الرواتب والطلبات', items: [
    { key: 'payslips', label: 'قسائم الراتب وآخر صافي', hint: 'بعد اعتماد المسير فقط' },
    { key: 'loanRequests', label: 'طلب سلفة' },
    { key: 'expenseRequests', label: 'تكاليف العمل' },
  ] },
  { title: 'أخرى', items: [
    { key: 'tickets', label: 'التذاكر', hint: 'تقنية، صيانة، سيارة، نقل' },
    { key: 'notices', label: 'الإنذارات والملاحظات', hint: 'من سجل الموارد البشرية' },
  ] },
];

/** Owner console: what the interface shows, the brands, sign-in and guard settings, outside channels, module managers, and the company template. */
export function OwnerPage() {
  const session = useSession();
  const [tab, setTab] = useState<'interface' | 'portal' | 'texts' | 'brands' | 'security' | 'channels' | 'managers' | 'demo' | 'clone'>('interface');
  const [draft, setDraft] = useState<SystemSettings>(() => JSON.parse(JSON.stringify(session.settings)));
  const [busy, setBusy] = useState(false);
  const brands = useBrands();
  const channels = useLoad<Array<{ channel: string; enabled: boolean; config: Record<string, string>; hasSecret: boolean }>>('/messages/channels', []);
  const users = useLoad<Array<{ id: string; name: string; role: string; isActive: boolean }>>('/users', []);
  const [editing, setEditing] = useState<string | null>(null);
  const [channelDraft, setChannelDraft] = useState<{ enabled: boolean; config: Record<string, string>; secret: string }>({ enabled: false, config: {}, secret: '' });
  const [testTo, setTestTo] = useState('');
  const security: SecuritySettings = draft.security ?? { idleMinutes: 15, askLocationOnLogin: true, workdayStart: '07:00', workdayEnd: '21:00', failedLoginAlertThreshold: 8, exportAlertThreshold: 15 };
  const ui = { hiddenApps: [], brands: [], moduleManagers: {}, texts: {}, ...(draft.ui ?? {}) } as NonNullable<SystemSettings['ui']> & { texts: Record<string, { ar: string; en?: string }> };
  const setText = (key: string, part: 'ar' | 'en', value: string) => setDraft({ ...draft, ui: { ...ui, texts: { ...ui.texts, [key]: { ar: part === 'ar' ? value : ui.texts[key]?.ar ?? '', en: part === 'en' ? value : ui.texts[key]?.en } } } });

  async function saveSettings() {
    setBusy(true);
    try {
      // Logos uploaded meanwhile live on the server; keep them.
      const latest = await session.call<{ data: SystemSettings }>('/settings');
      const brandsNow = (draft.ui?.brands ?? []).map((brand) => ({ ...brand, logoKey: latest.data.ui?.brands.find((item) => item.id === brand.id)?.logoKey ?? brand.logoKey ?? null }));
      const texts = Object.fromEntries(Object.entries(ui.texts).filter(([, value]) => value.ar?.trim()).map(([key, value]) => [key, { ar: value.ar.trim(), ...(value.en?.trim() ? { en: value.en.trim() } : {}) }]));
      await session.call('/settings', { method: 'PUT', body: { ...draft, ui: { ...ui, brands: brandsNow, texts } } });
      refreshBrands();
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
  const portal: PortalSettings = { ...DEFAULT_PORTAL, ...draft.portal };
  const setPortal = (patch: Partial<PortalSettings>) => setDraft({ ...draft, portal: { ...portal, ...patch } });
  const appList = orderedApps(ui.appOrder);
  const moveApp = (index: number, step: number) => {
    const ids = appList.map((app) => app.id);
    const target = index + step;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setDraft({ ...draft, ui: { ...ui, appOrder: ids } });
  };
  const toggleApp = (id: string) => setDraft({ ...draft, ui: { ...ui, hiddenApps: ui.hiddenApps.includes(id) ? ui.hiddenApps.filter((app) => app !== id) : [...ui.hiddenApps, id] } });

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="لوحة مالك النظام" en="System owner console" /></h2><p>تحكم مالك النظام وحده: ما يظهر في الواجهة، العلامات وشعاراتها، مدة الجلسة والحارس الأمني، قنوات الإرسال، مسؤولو التطبيقات، واستنساخ النظام لشركة أخرى.</p></div>
        {['interface', 'portal', 'texts', 'brands', 'security', 'managers'].includes(tab) && <button className="button button-primary" disabled={busy} onClick={() => void saveSettings()}><Save size={16} /><Bi ar={"حفظ"} en={"Save"} /></button>}</div>
      <Tabs value={tab} onChange={setTab} items={[
        { id: 'interface', label: 'الواجهة · Interface' }, { id: 'portal', label: 'بوابة الموظف · Employee portal' }, { id: 'texts', label: 'النصوص والتسميات · Texts' }, { id: 'brands', label: 'العلامات · Brands' }, { id: 'security', label: 'الجلسة والأمان · Security' },
        { id: 'demo', label: 'الحسابات التجريبية · Demo' },
        { id: 'channels', label: 'القنوات · Channels' }, { id: 'managers', label: 'مسؤولو التطبيقات · App owners' }, { id: 'clone', label: 'استنساخ لشركة · Clone' },
      ]} />
      {tab === 'interface' && <section className="panel">
        <div className="panel-head"><div><h3><Bi ar={"التطبيقات وترتيبها"} en={"Apps and their order"} /></h3><p>رتّب التطبيقات بالأسهم كما تريدها في الشاشة الرئيسية للجميع، وأخفِ ما لا تحتاجه (المخفي لا يظهر لأحد غيرك). لتحديد تطبيقات مستخدم بعينه: الإعدادات ← المستخدمون ← «التطبيقات».</p></div>
          {ui.appOrder?.length ? <button className="button button-quiet" onClick={() => setDraft({ ...draft, ui: { ...ui, appOrder: [] } })}>الترتيب الافتراضي</button> : null}</div>
        <div className="app-toggles">{appList.map((app, index) => { const Icon = app.icon; const hiddenNow = ui.hiddenApps.includes(app.id); return <label key={app.id} className={`app-toggle ${hiddenNow ? 'is-hidden' : ''}`}>
          <input type="checkbox" checked={!hiddenNow} onChange={() => toggleApp(app.id)} />
          <span className="o-app-icon small" style={{ background: `linear-gradient(145deg, ${app.colors[0]}, ${app.colors[1]})` }}><Icon size={20} /></span>
          <span><strong>{app.label}</strong><small className="bi-en">{en(app.label)}</small></span>{hiddenNow && <EyeOff size={15} />}
          <span className="app-order-buttons">
            <button type="button" className="icon-button" title="إلى الأمام" disabled={index === 0} onClick={(event) => { event.preventDefault(); moveApp(index, -1); }}>→</button>
            <button type="button" className="icon-button" title="إلى الخلف" disabled={index === appList.length - 1} onClick={(event) => { event.preventDefault(); moveApp(index, 1); }}>←</button>
          </span>
        </label>; })}</div>
      </section>}
      {tab === 'portal' && <section className="panel">
        <div className="panel-head"><div><h3><Bi ar={"ما يظهر في بوابة الموظف"} en={"What employees see in their portal"} /></h3><p>يسري على «خدمتي» لكل الموظفين. المغلق يختفي من البوابة ويرفضه الخادم، والموارد البشرية تبقى تعمل عليه من تطبيقاتها. اضغط «حفظ» بعد التغيير.</p></div>
          <button className="button button-quiet" onClick={() => setDraft({ ...draft, portal: { ...DEFAULT_PORTAL, welcome: portal.welcome } })}>فتح الكل</button></div>
        <div className="portal-switches">{PORTAL_GROUPS.map((group) => <div key={group.title} className="portal-switch-group">
          <h4>{group.title}</h4>
          {group.items.map((item) => <label key={item.key} className="portal-switch">
            <input type="checkbox" checked={portal[item.key]} onChange={(event) => setPortal({ [item.key]: event.target.checked })} />
            <span>{item.label}{item.hint && <small>{item.hint}</small>}</span>
          </label>)}
        </div>)}</div>
        <label className="field portal-welcome-field"><span>رسالة أعلى البوابة (اختيارية)</span>
          <textarea maxLength={500} value={portal.welcome} placeholder="مثال: تُصرف رواتب تشرين الأول يوم 30. لأي استفسار راجع الموارد البشرية في فرعك." onChange={(event) => setPortal({ welcome: event.target.value })} />
          <small>{portal.welcome.length}/500 · تظهر لكل الموظفين في أعلى «خدمتي».</small>
        </label>
      </section>}
      {tab === 'brands' && <section className="panel">
        <div className="panel-head"><div><h3><Bi ar={"العلامات التجارية وشعاراتها"} en={"Brands"} /></h3><p>أضف أو احذف أو أعد تسمية أو رتّب العلامات، ثم «حفظ». بعد الحفظ ارفع شعار كل علامة من ملفاتكم الرسمية. تظهر في شاشة الدخول وتحت اسم النظام، وتُربط بشركات المجموعة.</p></div>
          <button className="button button-quiet" onClick={() => setDraft({ ...draft, ui: { ...ui, brands: [...ui.brands, { id: `brand-${Date.now().toString(36)}`, name: 'علامة جديدة', logoKey: null }] } })}><Plus size={15} />إضافة علامة</button></div>
        <div className="brand-admin">{ui.brands.map((brand, index) => { const live = brands.find((item) => item.id === brand.id); const saved = Boolean(session.settings.ui?.brands.some((item) => item.id === brand.id)); return <div key={brand.id} className="brand-admin-card">
          <div className="brand-admin-logo">{live?.logo ? <img src={live.logo} alt={brand.name} /> : <Image size={28} />}</div>
          <input className="brand-name-input" value={brand.name} maxLength={40} onChange={(event) => setDraft({ ...draft, ui: { ...ui, brands: ui.brands.map((item) => item.id === brand.id ? { ...item, name: event.target.value } : item) } })} />
          <div className="row-actions">
            <button className="icon-button" title="قبل" disabled={index === 0} onClick={() => { const next = [...ui.brands]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setDraft({ ...draft, ui: { ...ui, brands: next } }); }}>→</button>
            <button className="icon-button" title="بعد" disabled={index === ui.brands.length - 1} onClick={() => { const next = [...ui.brands]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; setDraft({ ...draft, ui: { ...ui, brands: next } }); }}>←</button>
            {saved ? <label className="button button-quiet button-small"><Upload size={13} />شعار<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => void uploadLogo(brand.id, event)} /></label> : <small className="muted">احفظ أولاً</small>}
            {live?.logo && <button className="button button-quiet button-small" title="إزالة الشعار" onClick={() => void removeLogo(brand.id)}><Image size={13} />×</button>}
            <button className="icon-button" title="حذف العلامة" onClick={() => setDraft({ ...draft, ui: { ...ui, brands: ui.brands.filter((item) => item.id !== brand.id) } })}><Trash2 size={14} /></button>
          </div>
        </div>; })}</div>
      </section>}
      {tab === 'texts' && <section className="panel">
        <div className="panel-head"><div><h3>النصوص والتسميات · Texts & names</h3><p>غيّر اسم النظام ونصوص شاشة الدخول، وأعد تسمية أي تطبيق أو قائمة بالعربي والإنكليزي. اترك الحقل فارغاً لاستعمال النص الأصلي.</p></div></div>
        <h4>النظام وشاشة الدخول · System & sign-in page</h4>
        <div className="text-editor">{EDITABLE_TEXTS.map((item) => <div key={item.key} className="text-row">
          <span className="text-label">{item.label}</span>
          {item.long ? <textarea rows={2} placeholder={item.ar} value={ui.texts[item.key]?.ar ?? ''} onChange={(event) => setText(item.key, 'ar', event.target.value)} /> : <input placeholder={item.ar} value={ui.texts[item.key]?.ar ?? ''} onChange={(event) => setText(item.key, 'ar', event.target.value)} />}
          {item.long ? <textarea rows={2} dir="ltr" placeholder={item.en} value={ui.texts[item.key]?.en ?? ''} onChange={(event) => setText(item.key, 'en', event.target.value)} /> : <input dir="ltr" placeholder={item.en} value={ui.texts[item.key]?.en ?? ''} onChange={(event) => setText(item.key, 'en', event.target.value)} />}
        </div>)}</div>
        <h4>التطبيقات والقوائم · Apps & menus</h4>
        <div className="text-editor">{APPS.flatMap((app) => [
          { key: app.label, label: `تطبيق: ${app.label}`, en: en(app.label) },
          { key: app.description, label: `وصف: ${app.label}`, en: en(app.description) },
          ...app.menus.filter((menu) => menu.label !== app.label).map((menu) => ({ key: menu.label, label: `قائمة: ${app.label} ← ${menu.label}`, en: en(menu.label) })),
        ]).filter((item, index, all) => all.findIndex((other) => other.key === item.key) === index).map((item) => <div key={item.key} className="text-row">
          <span className="text-label">{item.label}</span>
          <input placeholder={item.key} value={ui.texts[item.key]?.ar ?? ''} onChange={(event) => setText(item.key, 'ar', event.target.value)} />
          <input dir="ltr" placeholder={item.en || 'English'} value={ui.texts[item.key]?.en ?? ''} onChange={(event) => setText(item.key, 'en', event.target.value)} />
        </div>)}</div>
      </section>}
      {tab === 'demo' && <section className="panel"><DemoAccounts /></section>}
      {tab === 'security' && <section className="panel"><div className="form-grid">
        <label className="field"><span><Bi ar={"إنهاء الجلسة بعد عدم النشاط (دقيقة)"} en={"Idle sign-out"} /></span><input type="number" min={5} max={480} value={security.idleMinutes} onChange={(event) => setSecurity({ idleMinutes: Number(event.target.value) })} /><small>الافتراضي 15 دقيقة. يظهر تنبيه قبلها بدقيقة.</small></label>
        <label className="settings-check"><input type="checkbox" checked={security.askLocationOnLogin} onChange={(event) => setSecurity({ askLocationOnLogin: event.target.checked })} />طلب الموقع عند الدخول (يظهر على الخريطة في الحارس الأمني)</label>
        <label className="field"><span>بداية الدوام</span><input type="time" value={security.workdayStart} onChange={(event) => setSecurity({ workdayStart: event.target.value })} /></label>
        <label className="field"><span>نهاية الدوام</span><input type="time" value={security.workdayEnd} onChange={(event) => setSecurity({ workdayEnd: event.target.value })} /><small>التعديلات الحساسة خارج هذا الوقت تُنبَّه.</small></label>
        <label className="field"><span>محاولات دخول خاطئة من عنوان واحد خلال 15 دقيقة</span><input type="number" min={3} max={100} value={security.failedLoginAlertThreshold} onChange={(event) => setSecurity({ failedLoginAlertThreshold: Number(event.target.value) })} /></label>
        <label className="field"><span>تنزيلات ملفات من شخص خلال ساعة</span><input type="number" min={3} max={500} value={security.exportAlertThreshold} onChange={(event) => setSecurity({ exportAlertThreshold: Number(event.target.value) })} /></label>
        <label className="settings-check"><input type="checkbox" checked={security.wafEnabled !== false} onChange={(event) => setSecurity({ wafEnabled: event.target.checked })} />جدار الحماية: صد أنماط الهجوم (SQL، المسارات، السكربت)</label>
        <label className="field"><span>حظر تلقائي لمن يخمّن كلمات المرور (دقيقة، 0 = إيقاف)</span><input type="number" min={0} max={10080} value={security.autoBlockMinutes ?? 60} onChange={(event) => setSecurity({ autoBlockMinutes: Number(event.target.value) })} /></label>
        <label className="field"><span>أقصى طلبات من عنوان واحد في الدقيقة</span><input type="number" min={60} max={10000} value={security.requestsPerMinute ?? 600} onChange={(event) => setSecurity({ requestsPerMinute: Number(event.target.value) })} /></label>
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
        <div className="panel-head"><div><h3><Bi ar={"استنساخ النظام لشركة أخرى"} en={"Clone for another company"} /></h3>
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

