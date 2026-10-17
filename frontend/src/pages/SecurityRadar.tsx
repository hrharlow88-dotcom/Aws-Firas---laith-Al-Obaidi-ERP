import { Bi } from '../components/Brand';
import { FormEvent, useEffect, useState } from 'react';
import { Ban, CheckCircle2, Radar, RefreshCw, ShieldAlert, ShieldCheck, Unlock, Wrench } from 'lucide-react';
import { Empty, Loading, Stat, Tone } from '../components/ui';
import { formatDateTime, formatNumber } from '../lib/format';
import { useLoad, useSession } from '../lib/session';

interface RadarPerson {
  id: string; name: string; role: string; isDemo: boolean; lastSeenAt: string; ip: string | null; userAgent: string | null;
  latitude: number | null; longitude: number | null; channel: string | null; module: string | null; path: string | null;
}
interface Threat { ip: string; hits: number; lastAt: string; kinds: string[]; blocked: boolean }

const hash = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
const device = (agent: string | null) => !agent ? '—' : /iphone|ipad/i.test(agent) ? 'iOS' : /android/i.test(agent) ? 'Android' : /windows/i.test(agent) ? 'Windows' : /mac os/i.test(agent) ? 'macOS' : 'Linux';
const KIND: Record<string, string> = { login_failed: 'تخمين كلمة مرور', forbidden: 'طلب مرفوض', waf_blocked: 'نمط هجوم', rate_limited: 'إغراق' };

/** The radar: who is in the system now (by name), and who is probing it. */
export function RadarPanel() {
  const session = useSession();
  const radar = useLoad<{ people: RadarPerson[]; threats: Threat[]; blockedCount: number; scannedAt: string } | null>('/security/radar', null);
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => { const timer = window.setInterval(radar.reload, 10000); return () => window.clearInterval(timer); }, [radar.reload]);
  const data = radar.data;
  if (!data) return <Loading />;
  const now = Date.now();
  const blips = [
    ...data.people.map((person) => {
      const minutes = Math.min(30, (now - new Date(person.lastSeenAt).getTime()) / 60000);
      return { key: person.id, kind: person.isDemo ? 'demo' : 'person', label: person.name, angle: (hash(person.id) % 360) * Math.PI / 180, radius: 0.22 + (minutes / 30) * 0.5 };
    }),
    ...data.threats.map((threat) => ({ key: threat.ip, kind: threat.blocked ? 'blocked' : 'threat', label: threat.ip, angle: (hash(threat.ip) % 360) * Math.PI / 180, radius: 0.78 + Math.min(threat.hits, 50) / 400 })),
  ];
  async function block(ip: string) {
    try { await session.call('/security/blocks', { method: 'POST', body: { ip, minutes: 1440, reason: 'حظر من الرادار' } }); session.notify(`حُظر ${ip} لمدة 24 ساعة.`); radar.reload(); }
    catch (error) { session.fail(error, 'تعذر الحظر.'); }
  }
  return (
    <div className="radar-layout">
      <div className="radar-scope">
        <svg viewBox="-100 -100 200 200" role="img" aria-label="رادار الحماية">
          <defs>
            <radialGradient id="radar-bg"><stop offset="0%" stopColor="#0f2a1e" /><stop offset="100%" stopColor="#06120c" /></radialGradient>
            <linearGradient id="radar-sweep" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="rgba(54,230,140,0)" /><stop offset="100%" stopColor="rgba(54,230,140,.55)" /></linearGradient>
          </defs>
          <circle r="98" fill="url(#radar-bg)" stroke="#1f6b45" strokeWidth="1" />
          {[24, 48, 72, 96].map((r) => <circle key={r} r={r} fill="none" stroke="#1f6b45" strokeWidth=".6" strokeDasharray={r === 72 ? '2 2' : undefined} />)}
          <line x1="-98" y1="0" x2="98" y2="0" stroke="#1f6b45" strokeWidth=".5" /><line x1="0" y1="-98" x2="0" y2="98" stroke="#1f6b45" strokeWidth=".5" />
          <g className="radar-sweep"><path d="M0 0 L98 0 A98 98 0 0 0 69.3 -69.3 Z" fill="url(#radar-sweep)" /></g>
          {blips.map((blip) => {
            const x = Math.cos(blip.angle) * blip.radius * 96;
            const y = Math.sin(blip.angle) * blip.radius * 96;
            return <g key={blip.key} className={`radar-blip blip-${blip.kind} ${focus === blip.key ? 'is-focus' : ''}`} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`} onMouseEnter={() => setFocus(blip.key)}>
              <circle r="7" className="blip-pulse" /><circle r="2.6" className="blip-dot" />
              <text y="-5.5" textAnchor="middle">{blip.label.split(' ')[0]}</text>
            </g>;
          })}
          <circle r="3" fill="#36e68c" />
        </svg>
        <div className="radar-legend"><span><i className="blip-person" />مستخدم متصل</span><span><i className="blip-demo" />حساب تجريبي</span><span><i className="blip-threat" />عنوان مهاجم</span><span><i className="blip-blocked" />محظور</span></div>
      </div>
      <div className="radar-side">
        <div className="stat-row"><Stat label="متصلون الآن" value={formatNumber(data.people.length)} /><Stat label="مصادر تهديد (ساعة)" value={formatNumber(data.threats.length)} tone={data.threats.some((threat) => !threat.blocked) ? 'bad' : undefined} /><Stat label="عناوين محظورة" value={formatNumber(data.blockedCount)} /></div>
        <h4><Bi ar={"المستخدمون في النظام الآن"} en={"Who is in"} /></h4>
        {!data.people.length ? <p className="muted">لا أحد متصل.</p> : <ul className="radar-list">{data.people.map((person) => <li key={person.id} className={focus === person.id ? 'is-focus' : ''} onMouseEnter={() => setFocus(person.id)}>
          <strong>{person.name}{person.isDemo && <Tone tone="info">تجريبي</Tone>}</strong>
          <span>{person.role} · {device(person.userAgent)} · <bdi dir="ltr">{person.ip ?? '—'}</bdi>{person.latitude !== null && ` · 📍${person.latitude.toFixed(3)},${person.longitude?.toFixed(3)}`}</span>
          <small>{person.module ? `يعمل على: ${person.module}` : ''} {person.path ? <bdi dir="ltr">{person.path}</bdi> : null} · {formatDateTime(person.lastSeenAt)}</small>
        </li>)}</ul>}
        <h4><Bi ar={"من يحاول الدخول أو العبث"} en={"Probing sources"} /></h4>
        {!data.threats.length ? <p className="muted"><ShieldCheck size={14} /> لا توجد محاولات خلال الساعة الماضية.</p> : <ul className="radar-list">{data.threats.map((threat) => <li key={threat.ip} className={`is-threat ${focus === threat.ip ? 'is-focus' : ''}`} onMouseEnter={() => setFocus(threat.ip)}>
          <strong dir="ltr">{threat.ip}</strong>
          <span>{threat.hits} محاولة · {threat.kinds.map((kind) => KIND[kind] ?? kind).join('، ')}</span>
          {threat.blocked ? <Tone tone="muted">محظور</Tone> : <button className="button button-danger button-small" onClick={() => void block(threat.ip)}><Ban size={13} />حظر 24 ساعة</button>}
        </li>)}</ul>}
        <small className="muted">آخر مسح: {formatDateTime(data.scannedAt)} · يتحدث كل 10 ثوانٍ</small>
      </div>
    </div>
  );
}

interface Finding { id: string; severity: 'critical' | 'high' | 'medium' | 'low' | 'ok'; title: string; detail: string; items?: string[]; fix?: { label: string } }
const SEV: Record<string, { label: string; tone: string }> = {
  critical: { label: 'حرج', tone: 'bad' }, high: { label: 'عالٍ', tone: 'bad' }, medium: { label: 'متوسط', tone: 'warn' }, low: { label: 'منخفض', tone: 'info' }, ok: { label: 'سليم', tone: 'good' },
};

/** Vulnerability scan with one-click fixes. */
export function ScanPanel() {
  const session = useSession();
  const report = useLoad<{ findings: Finding[]; score: number } | null>('/security/scan-report', null);
  const [busy, setBusy] = useState<string | null>(null);
  async function fix(id: string) {
    setBusy(id);
    try { const result = await session.call<{ data: { summary: string } }>(`/security/fix/${id}`, { method: 'POST' }); session.notify(result.data.summary); report.reload(); }
    catch (error) { session.fail(error, 'تعذر الإصلاح.'); } finally { setBusy(null); }
  }
  if (!report.data) return <Loading />;
  const { findings, score } = report.data;
  return (
    <div>
      <div className="scan-head">
        <div className={`scan-score ${score >= 85 ? 'good' : score >= 60 ? 'warn' : 'bad'}`}><strong>{score}</strong><span>/100</span><small>درجة الحماية</small></div>
        <div><h3><Bi ar={"فحص الثغرات والمخاطر"} en={"Vulnerability scan"} /></h3><p className="muted">يفحص الإعدادات والحسابات والملفات وحركة الهجوم وسلامة السجل، ويعالج ما يمكن معالجته بنقرة.</p>
          <button className="button button-quiet" onClick={report.reload}><RefreshCw size={14} />فحص من جديد</button></div>
      </div>
      <div className="scan-list">{findings.map((finding) => <div key={finding.id} className={`scan-item sev-${finding.severity}`}>
        {finding.severity === 'ok' ? <CheckCircle2 size={20} /> : <ShieldAlert size={20} />}
        <div><strong>{finding.title}</strong><Tone tone={SEV[finding.severity].tone}>{SEV[finding.severity].label}</Tone>
          {finding.detail && <p>{finding.detail}</p>}
          {finding.items?.length ? <small>{finding.items.slice(0, 12).join(' · ')}{finding.items.length > 12 ? ' …' : ''}</small> : null}
        </div>
        {finding.fix && <button className="button button-primary button-small" disabled={busy === finding.id} onClick={() => void fix(finding.id)}><Wrench size={13} />{finding.fix.label}</button>}
      </div>)}</div>
    </div>
  );
}

/** Firewall: blocked addresses, manual blocks and lifting them. */
export function FirewallPanel() {
  const session = useSession();
  const blocks = useLoad<Array<{ id: string; ip: string; reason: string; automatic: boolean; blockedUntil: string | null; createdAt: string; hits: number; liftedAt: string | null; createdByName: string | null }>>('/security/blocks', []);
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const minutes = String(form.get('minutes'));
    try {
      await session.call('/security/blocks', { method: 'POST', body: { ip: form.get('ip'), reason: form.get('reason') || null, minutes: minutes === 'forever' ? null : Number(minutes) } });
      (event.target as HTMLFormElement).reset();
      blocks.reload();
    } catch (error) { session.fail(error, 'تعذر الحظر.'); }
  }
  return (
    <div>
      <p className="muted">جدار الحماية يصد تلقائياً أنماط حقن SQL وتجاوز المسارات وحقن السكربت، ويحدّ عدد الطلبات من كل عنوان، ويحظر من يخمّن كلمات المرور. الإعدادات في «لوحة المالك ← الجلسة والأمان».</p>
      <form className="filter-bar" onSubmit={(event) => void add(event)}>
        <input name="ip" required placeholder="عنوان IP" dir="ltr" />
        <input name="reason" placeholder="السبب" />
        <select name="minutes" defaultValue="1440"><option value="60">ساعة</option><option value="1440">يوم</option><option value="10080">أسبوع</option><option value="forever">دائم</option></select>
        <button className="button button-danger"><Ban size={14} />حظر</button>
      </form>
      {blocks.loading ? <Loading /> : !blocks.data.length ? <Empty icon={<ShieldCheck size={22} />} title="لا توجد عناوين محظورة" text="—" />
        : <div className="table-scroll"><table className="dense"><thead><tr><th>العنوان</th><th>السبب</th><th>حتى</th><th>محاولات بعد الحظر</th><th /></tr></thead>
          <tbody>{blocks.data.map((row) => <tr key={row.id} className={row.liftedAt ? 'row-muted' : ''}><td dir="ltr"><strong>{row.ip}</strong></td>
            <td>{row.reason}{row.automatic && <Tone tone="warn">تلقائي</Tone>}<small className="table-sub">{row.createdByName ?? 'الحارس الأمني'} · {formatDateTime(row.createdAt)}</small></td>
            <td>{row.liftedAt ? 'رُفع' : row.blockedUntil ? formatDateTime(row.blockedUntil) : 'دائم'}</td><td>{row.hits}</td>
            <td>{!row.liftedAt && <button className="button button-quiet button-small" onClick={async () => { await session.call(`/security/blocks/${row.id}/lift`, { method: 'POST' }); blocks.reload(); }}><Unlock size={13} />رفع الحظر</button>}</td></tr>)}</tbody></table></div>}
    </div>
  );
}

export { Radar };
