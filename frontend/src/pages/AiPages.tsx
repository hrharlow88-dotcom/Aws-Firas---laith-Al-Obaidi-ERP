import { ChangeEvent, FormEvent, useState } from 'react';
import { Bot, Check, FileSpreadsheet, FileWarning, KeyRound, Sparkles, Star, X } from 'lucide-react';
import { Bi } from '../components/Brand';
import { Empty, Loading, Stat, Tabs, Tone } from '../components/ui';
import { DOCUMENT_TYPES, formatDateTime, formatNumber } from '../lib/format';
import { navigate } from '../lib/router';
import { useLoad, useSession } from '../lib/session';

interface AiStatus { configured: boolean; enabled: boolean; model: string }
interface AttendanceProposal {
  attendanceRules?: { lateMonthlyAllowanceMinutes?: number; overtimeMinimumMinutes?: number; markAbsentWithoutPunch?: boolean; lateDayTiers?: Array<{ minutes: number; days: number }> };
  components?: Record<string, { active?: boolean; rate?: number }>;
  shifts?: { graceMinutes?: number; earlyLeaveGraceMinutes?: number };
  hourly?: { hourlyMonthlyQuota?: number; maxHoursPerRequest?: number };
  summaryAr: string[];
  unsupported: string[];
}
interface ImportRow { employeeId: string | null; employeeNo: string; name: string; action: string; reason?: string; changes: Array<{ field: string; label: string; before: string | null; after: string }> }
interface ImportPreview { id: string; engine: string; summary: { sheets: Array<{ name: string; rows: number; columns: Record<string, string> }>; update: number; create: number; skip: number; salaryChanges: number; notes: string[] }; rows: ImportRow[]; skipped: ImportRow[]; error: string | null }
interface Job { id: string; kind: string; instruction: string | null; fileName: string | null; status: string; engine: string; createdAt: string; appliedAt: string | null; createdByName: string; result: Record<string, unknown> | null }

const JOB_STATUS: Record<string, { label: string; tone: string }> = {
  proposed: { label: 'بانتظار مراجعتك', tone: 'warn' }, applied: { label: 'طُبّق', tone: 'good' }, discarded: { label: 'أُلغي', tone: 'muted' }, failed: { label: 'فشل', tone: 'bad' },
};
const EXAMPLE = `التأخير أكثر من 15 دقيقة يخصم ربع يوم.
التأخير أكثر من 60 دقيقة يخصم نصف يوم.
سماح 60 دقيقة شهرياً.
الإضافي لا يحتسب أقل من 30 دقيقة.
الإضافي يحتسب 1.5 مرة.
الغياب بدون إجازة يخصم يوم.
الإجازة الزمنية 8 ساعات في الشهر.`;

/**
 * The AI assistant, under the owner's control: tell it how to calculate
 * attendance, or give it old Excel files to sort into employee cards and
 * salaries. It proposes; the owner reviews every change and applies it.
 */
export function AiAssistantPage() {
  const session = useSession();
  const status = useLoad<AiStatus>('/ai/status', { configured: false, enabled: false, model: 'claude-sonnet-5-5' });
  const jobs = useLoad<Job[]>('/ai/jobs', []);
  const [tab, setTab] = useState<'attendance' | 'import' | 'settings' | 'history'>('attendance');
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<{ id: string; engine: string; proposal: AttendanceProposal; error: string | null } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState(`${new Date().toISOString().slice(0, 7)}-01`);
  const live = status.data.configured && status.data.enabled;

  async function ask() {
    setBusy(true);
    try { setProposal((await session.call<{ data: NonNullable<typeof proposal> }>('/ai/attendance', { method: 'POST', body: { instruction } })).data); jobs.reload(); }
    catch (error) { session.fail(error, 'تعذر التحليل.'); } finally { setBusy(false); }
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const form = new FormData(); form.set('file', file);
    setBusy(true);
    try { setPreview((await session.call<{ data: ImportPreview }>('/ai/import', { form })).data); jobs.reload(); }
    catch (error) { session.fail(error, 'تعذرت قراءة الملف.'); } finally { setBusy(false); }
  }
  async function apply(id: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      const result = await session.call<{ data: Record<string, number> }>(`/ai/jobs/${id}/apply`, { method: 'POST', body: extra });
      session.notify(result.data.updated !== undefined ? `طُبّق: ${result.data.updated} تحديث، ${result.data.created} جديد، ${result.data.salaries} راتب.` : 'طُبّقت القواعد. ستُحتسب بها البصمات والمسيرات من الآن.');
      setProposal(null); setPreview(null); jobs.reload(); session.refreshSettings();
    } catch (error) { session.fail(error, 'تعذر التطبيق.'); } finally { setBusy(false); }
  }
  async function discard(id: string) {
    try { await session.call(`/ai/jobs/${id}/discard`, { method: 'POST' }); setProposal(null); setPreview(null); jobs.reload(); }
    catch (error) { session.fail(error, 'تعذر الإلغاء.'); }
  }
  async function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const apiKey = String(form.get('apiKey') || '').trim();
    try {
      await session.call('/ai/settings', { method: 'PUT', body: { ...(apiKey ? { apiKey } : {}), enabled: form.get('enabled') === 'on', model: String(form.get('model') || status.data.model) } });
      element.reset(); status.reload(); session.notify('حُفظت إعدادات المساعد.');
    } catch (error) { session.fail(error, 'تعذر الحفظ.'); }
  }
  async function removeKey() {
    try { await session.call('/ai/settings', { method: 'PUT', body: { apiKey: null, enabled: false } }); status.reload(); }
    catch (error) { session.fail(error, 'تعذر الحذف.'); }
  }

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bot size={22} /> <Bi ar="المساعد الذكي" en="AI assistant" /></h2>
        <p>موظف ذكاء اصطناعي داخل النظام تتحكم به وحدك: اكتب له كيف يُحتسب الحضور والاستقطاعات والإضافي والزمنيات، أو ارفع له ملفات الإكسل القديمة ليرتب بطاقات الموظفين والرواتب. يقترح فقط، وأنت تراجع كل تغيير وتعتمده.</p></div>
        <Tone tone={live ? 'good' : 'muted'}>{live ? `يعمل بالذكاء الاصطناعي · ${status.data.model}` : 'القارئ المدمج (بلا ذكاء اصطناعي)'}</Tone></div>
      <Tabs value={tab} onChange={setTab} items={[
        { id: 'attendance', label: 'احتساب الحضور بأوامرك' }, { id: 'import', label: 'ترتيب ملفات الإكسل القديمة' },
        { id: 'history', label: 'السجل', badge: jobs.data.filter((job) => job.status === 'proposed').length }, { id: 'settings', label: 'الإعداد' },
      ]} />
      {tab === 'attendance' && <section className="panel">
        <div className="panel-head"><div><h3>اكتب القواعد كما تقولها</h3><p>كل سطر قاعدة. يفهم: شرائح التأخير اليومية، السماح الشهري، سماح الدوام، الحد الأدنى للإضافي ونسبته، خصم الغياب، والإجازة الزمنية.</p></div>
          <button className="button button-quiet" onClick={() => setInstruction(EXAMPLE)}>مثال</button></div>
        <textarea className="ai-instruction" rows={7} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={EXAMPLE} />
        <div className="dialog-actions"><button className="button button-primary" disabled={busy || !instruction.trim()} onClick={() => void ask()}><Sparkles size={15} />{busy ? 'يحلّل…' : 'حلّل واقترح'}</button></div>
        {proposal && <div className="ai-proposal">
          <h4>الاقتراح {proposal.engine === 'ai' ? '(ذكاء اصطناعي)' : '(القارئ المدمج)'}</h4>
          {proposal.error && <p className="muted small">تعذر الوصول إلى الذكاء الاصطناعي ({proposal.error})، فأجاب القارئ المدمج.</p>}
          {proposal.proposal.summaryAr.length ? <ul className="ai-changes">{proposal.proposal.summaryAr.map((line) => <li key={line}><Check size={14} />{line}</li>)}</ul> : <p className="muted">لم يُفهم أي تغيير.</p>}
          {proposal.proposal.unsupported.length > 0 && <div className="callout callout-warn"><FileWarning size={16} /><div><strong>لم يُفهم أو غير مدعوم:</strong><span>{proposal.proposal.unsupported.join(' — ')}</span></div></div>}
          <div className="dialog-actions">
            <button className="button button-primary" disabled={busy || !proposal.proposal.summaryAr.length} onClick={() => void apply(proposal.id)}><Check size={15} />اعتماد وتطبيق</button>
            <button className="button button-quiet" onClick={() => void discard(proposal.id)}><X size={15} />إلغاء</button></div>
        </div>}
      </section>}
      {tab === 'import' && <section className="panel">
        <div className="panel-head"><div><h3>ارفع ملف إكسل قديم</h3><p>سجل الموظفين، ملف الرواتب، قائمة الجوازات… يتعرف على الأوراق والأعمدة، ويطابق الموظفين بالرقم الوظيفي، ويقترح تحديث البطاقات والرواتب وإضافة غير الموجودين. لا يُحفظ شيء قبل موافقتك.</p></div>
          <label className="button button-primary"><FileSpreadsheet size={15} />{busy ? 'يقرأ…' : 'اختر ملف xlsx'}<input type="file" accept=".xlsx" hidden onChange={(event) => void upload(event)} /></label></div>
        {preview && <div className="ai-proposal">
          <div className="stat-row"><Stat label="تحديث بطاقات" value={formatNumber(preview.summary.update)} /><Stat label="موظفون جدد" value={formatNumber(preview.summary.create)} />
            <Stat label="رواتب ستتغير" value={formatNumber(preview.summary.salaryChanges)} /><Stat label="بلا تغيير / متروك" value={formatNumber(preview.summary.skip)} /></div>
          {preview.summary.sheets.map((sheet) => <p key={sheet.name} className="muted small">ورقة «{sheet.name}» ({sheet.rows} صف): {Object.entries(sheet.columns).map(([field, header]) => `${header} ← ${field}`).join('، ')}</p>)}
          {preview.summary.notes.map((note) => <p key={note} className="muted small">• {note}</p>)}
          <div className="table-scroll ai-table"><table className="dense"><thead><tr><th>الموظف</th><th>الإجراء</th><th>التغييرات</th></tr></thead>
            <tbody>{preview.rows.map((row) => <tr key={row.employeeNo}><td><strong>{row.name}</strong><small className="table-sub">{row.employeeNo}</small></td>
              <td>{row.action === 'create' ? <Tone tone="good">جديد</Tone> : <Tone tone="warn">تحديث</Tone>}</td>
              <td>{row.changes.map((change) => <span key={change.field} className="ai-change">{change.label}: {change.before ? <s>{change.before}</s> : null} {change.after}</span>)}</td></tr>)}</tbody></table></div>
          {preview.skipped.length > 0 && <details><summary>متروك ({preview.skipped.length})</summary><ul>{preview.skipped.map((row) => <li key={row.employeeNo}>{row.employeeNo} {row.name}: {row.reason}</li>)}</ul></details>}
          <div className="dialog-actions">
            <label className="field"><span>تاريخ سريان الرواتب الجديدة</span><input type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></label>
            <button className="button button-primary" disabled={busy || !(preview.summary.update + preview.summary.create)} onClick={() => void apply(preview.id, { effectiveFrom })}><Check size={15} />اعتماد كل التغييرات</button>
            <button className="button button-quiet" onClick={() => void discard(preview.id)}><X size={15} />إلغاء</button></div>
        </div>}
      </section>}
      {tab === 'history' && <section className="panel">{jobs.loading ? <Loading /> : !jobs.data.length ? <Empty icon={<Bot size={22} />} title="لا يوجد سجل" text="—" />
        : <div className="table-scroll"><table className="dense"><thead><tr><th>الوقت</th><th>النوع</th><th>المدخل</th><th>المحرك</th><th>الحالة</th><th>النتيجة</th></tr></thead>
          <tbody>{jobs.data.map((job) => <tr key={job.id}><td>{formatDateTime(job.createdAt)}<small className="table-sub">{job.createdByName}</small></td>
            <td>{job.kind === 'import' ? 'ملف إكسل' : 'قواعد الحضور'}</td><td className="ai-input-cell">{job.fileName ?? job.instruction}</td><td>{job.engine === 'ai' ? 'ذكاء اصطناعي' : 'مدمج'}</td>
            <td><Tone tone={JOB_STATUS[job.status]?.tone ?? 'muted'}>{JOB_STATUS[job.status]?.label ?? job.status}</Tone></td>
            <td>{job.result ? Object.entries(job.result).map(([key, value]) => `${key}: ${String(value)}`).join('، ') : '—'}</td></tr>)}</tbody></table></div>}</section>}
      {tab === 'settings' && <section className="panel">
        <div className="panel-head"><div><h3><KeyRound size={17} /> مفتاح الذكاء الاصطناعي</h3>
          <p>بدون مفتاح يعمل القارئ المدمج (يفهم العبارات الشائعة ورؤوس الأعمدة المعروفة). مع مفتاح Anthropic يفهم أي صياغة وأي ملف. يُحفظ المفتاح مشفّراً ولا يُعرض مرة أخرى، والاستخدام يُحسب على حساب الشركة لدى Anthropic.</p></div></div>
        <form className="form-grid" onSubmit={(event) => void configure(event)}>
          <label className="field"><span>المفتاح {status.data.configured ? '(محفوظ — اتركه فارغاً للإبقاء عليه)' : ''}</span><input name="apiKey" type="password" autoComplete="off" dir="ltr" placeholder="sk-ant-..." /></label>
          <label className="field"><span>النموذج</span><select name="model" defaultValue={status.data.model}>{['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'].map((model) => <option key={model}>{model}</option>)}</select></label>
          <label className="settings-check"><input type="checkbox" name="enabled" defaultChecked={status.data.enabled} />تشغيل المساعد بالذكاء الاصطناعي</label>
          <div className="dialog-actions settings-wide">
            {status.data.configured && <button type="button" className="button button-danger" onClick={() => void removeKey()}>حذف المفتاح</button>}
            <button className="button button-primary">حفظ</button></div>
        </form>
      </section>}
    </section>
  );
}

interface DocRow { id: string; employeeNo: string; name: string; branch: string; status: string; missing: string[]; exempted: string[]; complete: boolean; priority: boolean }

/** Which files are complete and which documents are still missing, priorities first, with the exceptions the owner agreed. */
export function DocumentsCheckPage() {
  const session = useSession();
  const owner = session.user.role === 'super_admin';
  const data = useLoad<{ rows: DocRow[]; complete: number; incomplete: number; rules: { local: string[]; foreign: string[] } }>('/hr/documents-check', { rows: [], complete: 0, incomplete: 0, rules: { local: [], foreign: [] } });
  const [filter, setFilter] = useState<'missing' | 'all' | 'priority'>('missing');
  const [query, setQuery] = useState('');
  const rows = data.data.rows.filter((row) => (filter === 'all' || (filter === 'priority' ? row.priority : !row.complete)) &&
    (!query.trim() || `${row.name} ${row.employeeNo} ${row.branch}`.includes(query.trim())));

  async function rule(body: Record<string, unknown>) {
    try { await session.call('/hr/documents-check/rule', { method: 'POST', body }); data.reload(); }
    catch (error) { session.fail(error, 'تعذر الحفظ.'); }
  }

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="اكتمال الوثائق" en="Document completeness" /></h2>
        <p>المحليون: {data.data.rules.local.map((type) => DOCUMENT_TYPES[type] ?? type).join('، ')}. الأجانب: {data.data.rules.foreign.map((type) => DOCUMENT_TYPES[type] ?? type).join('، ')}. الوثيقة المنتهية تُحسب ناقصة. ضع ★ لمن يجب إكمال ملفه أولاً، واستثنِ ما لا يلزم موظفاً بعينه.</p></div></div>
      <div className="stat-row"><Stat label="ملفات مكتملة" value={formatNumber(data.data.complete)} tone="good" /><Stat label="ملفات ناقصة" value={formatNumber(data.data.incomplete)} tone={data.data.incomplete ? 'warn' : undefined} />
        <Stat label="أولوية" value={formatNumber(data.data.rows.filter((row) => row.priority).length)} /></div>
      <div className="filter-bar"><input placeholder="بحث بالاسم أو الرقم أو الفرع" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="segmented"><button aria-pressed={filter === 'missing'} onClick={() => setFilter('missing')}>الناقصة</button><button aria-pressed={filter === 'priority'} onClick={() => setFilter('priority')}>الأولوية</button><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>الكل</button></div></div>
      <section className="panel">{data.loading ? <Loading /> : !rows.length ? <Empty icon={<Check size={22} />} title="لا يوجد" text="—" />
        : <div className="table-scroll"><table className="dense"><thead><tr><th /><th>الموظف</th><th>الفرع</th><th>النوع</th><th>الناقص</th><th>مستثنى</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}>
            <td>{owner ? <button className={`icon-button star ${row.priority ? 'is-on' : ''}`} aria-label="أولوية" onClick={() => void rule({ employeeId: row.id, priority: !row.priority })}><Star size={16} /></button> : row.priority ? <Star size={16} /> : null}</td>
            <td className="row-link" onClick={() => navigate('employees', row.id)}><strong>{row.name}</strong><small className="table-sub">{row.employeeNo}</small></td>
            <td>{row.branch}</td><td>{row.status === 'foreign' ? <Tone tone="warn">أجنبي</Tone> : 'محلي'}</td>
            <td>{row.complete ? <Tone tone="good">مكتمل</Tone> : row.missing.map((type) => <span key={type} className="doc-chip">{DOCUMENT_TYPES[type] ?? type}
              {owner && <button aria-label="استثناء" title="لا يلزم هذا الموظف" onClick={() => void rule({ employeeId: row.id, docType: type })}><X size={11} /></button>}</span>)}</td>
            <td>{row.exempted.map((type) => <span key={type} className="doc-chip is-muted">{DOCUMENT_TYPES[type] ?? type}
              {owner && <button aria-label="إلغاء الاستثناء" onClick={() => void rule({ employeeId: row.id, docType: type, exempt: false })}><X size={11} /></button>}</span>)}</td>
          </tr>)}</tbody></table></div>}</section>
    </section>
  );
}
