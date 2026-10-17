import { useGovernorates } from './PayrollRegisterPage';
import { FormEvent, useState } from 'react';
import { Archive, Download, Eye, FileArchive, FileUp, Lock, RotateCcw, Search, Trash2, UserMinus } from 'lucide-react';
import { Bi } from '../components/Brand';
import { EmployeePicker, PickedEmployee } from '../components/EmployeePicker';
import { DocumentFrame } from '../components/DocumentFrame';
import { Dialog, Empty, Loading, Stat, Tone, useReasonPrompt } from '../components/ui';
import { ViewSwitch, useViewMode } from '../components/ViewSwitch';
import { downloadFile, openFile } from '../lib/api';
import { formatDate, formatDateTime, formatMoney, formatNumber, monthLabel } from '../lib/format';
import { navigate } from '../lib/router';
import { useLoad, useSession } from '../lib/session';

export const ARCHIVE_CATEGORY: Record<string, string> = {
  correspondence: 'مراسلات · Correspondence', contract: 'عقود · Contracts', decision: 'قرارات وأوامر إدارية · Decisions', policy: 'سياسات · Policies',
  payroll: 'رواتب · Payroll', finance: 'مالية · Finance', legal: 'قانونية · Legal', hr: 'موارد بشرية · HR', report: 'تقارير · Reports',
  certificate: 'شهادات · Certificates', other: 'أخرى · Other',
};

interface ArchiveDoc {
  id: string; title: string; category: string; docDate: string | null; reference: string | null; tags: string | null; notes: string | null;
  originalName: string; mimeType: string; sizeBytes: number; confidential: boolean; createdAt: string; uploadedByName: string;
  employeeId: string | null; employeeName: string | null; employeeNo: string | null; departmentName: string | null;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The company document archive: any file type, searchable, tied to an employee or department. */
export function ArchivePage() {
  const session = useSession();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const docs = useLoad<ArchiveDoc[]>(`/archive?q=${encodeURIComponent(query)}${category ? `&category=${category}` : ''}`, []);
  const departments = useLoad<Array<{ id: string; name: string }>>('/org/departments', []);
  const [uploading, setUploading] = useState(false);
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [view, setView] = useViewMode('archive', 'list');
  const reason = useReasonPrompt();
  const canManage = session.can('archive.manage');

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const files = form.getAll('files').filter((file): file is File => file instanceof File && file.size > 0);
    if (!files.length) return;
    let done = 0;
    for (const file of files) {
      const body = new FormData();
      body.set('file', file);
      body.set('title', files.length === 1 && form.get('title') ? String(form.get('title')) : file.name);
      for (const key of ['category', 'departmentId', 'docDate', 'reference', 'tags', 'notes']) if (form.get(key)) body.set(key, String(form.get(key)));
      if (employee) body.set('employeeId', employee.id);
      if (form.get('confidential') === 'on') body.set('confidential', 'true');
      try { await session.call('/archive', { form: body }); done += 1; } catch (error) { session.fail(error, `تعذر رفع ${file.name}`); }
    }
    if (done) session.notify(`أُرشف ${done} ملف.`);
    setUploading(false);
    setEmployee(null);
    docs.reload();
  }
  async function withdraw(doc: ArchiveDoc) {
    const why = await reason.ask(`سحب «${doc.title}» إلى سلة المحذوفات`);
    if (!why) return;
    try { await session.call(`/archive/${doc.id}/withdraw`, { method: 'POST', body: { reason: why } }); docs.reload(); session.notify('نُقل إلى سلة المحذوفات.'); }
    catch (error) { session.fail(error, 'تعذر السحب.'); }
  }
  const viewable = (doc: ArchiveDoc) => ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(doc.mimeType);
  const actions = (doc: ArchiveDoc) => <span className="row-actions">
    {viewable(doc) && <button className="icon-button" title="عرض" onClick={() => void openFile(`/archive/${doc.id}/file?inline=1`, session.token).catch((error) => session.fail(error, 'تعذر الفتح.'))}><Eye size={16} /></button>}
    <button className="icon-button" title="تنزيل" onClick={() => void downloadFile(`/archive/${doc.id}/file`, session.token, doc.originalName).catch((error) => session.fail(error, 'تعذر التنزيل.'))}><Download size={16} /></button>
    {canManage && <button className="icon-button" title="سحب" onClick={() => void withdraw(doc)}><Trash2 size={16} /></button>}
  </span>;

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="أرشيف الوثائق" en="Document archive" /></h2><p>كل أنواع الملفات (PDF، Word، Excel، صور، صوت، فيديو، مضغوطة…) حتى 50 ميغابايت للملف، مع البحث والتصنيف والربط بالموظف أو القسم، وكل فتح وتنزيل مسجل.</p></div>
        {canManage && <button className="button button-primary" onClick={() => setUploading(true)}><FileUp size={16} />أرشفة ملفات · Upload</button>}</div>
      <div className="stat-row"><Stat label="الوثائق · Documents" value={formatNumber(docs.data.length)} />
        <Stat label="مرتبطة بموظفين" value={formatNumber(docs.data.filter((doc) => doc.employeeId).length)} />
        <Stat label="سرية" value={formatNumber(docs.data.filter((doc) => doc.confidential).length)} />
        <Stat label="الحجم" value={size(docs.data.reduce((sum, doc) => sum + doc.sizeBytes, 0))} /></div>
      <section className="panel">
        <div className="filter-bar">
          <label className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث بالعنوان أو المرجع أو الموظف…" /></label>
          <select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">كل التصنيفات</option>{Object.entries(ARCHIVE_CATEGORY).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
          <ViewSwitch value={view} onChange={setView} modes={['list', 'grid']} />
        </div>
        {docs.loading ? <Loading /> : !docs.data.length ? <Empty icon={<FileArchive size={22} />} title="الأرشيف فارغ" text="ارفع الوثائق لتُحفظ هنا." />
          : view === 'grid' ? <div className="card-grid">{docs.data.map((doc) => <div key={doc.id} className="record-card">
            <span className="record-ref">{ARCHIVE_CATEGORY[doc.category]}</span><strong>{doc.confidential && <Lock size={13} />} {doc.title}</strong>
            <small>{doc.employeeName ?? doc.departmentName ?? '—'}</small><small>{doc.originalName} · {size(doc.sizeBytes)}</small>{actions(doc)}
          </div>)}</div>
          : <div className="table-scroll"><table className="dense"><thead><tr><th>الوثيقة</th><th>التصنيف</th><th>مرتبطة بـ</th><th>التاريخ</th><th>رفعها</th><th /></tr></thead>
            <tbody>{docs.data.map((doc) => <tr key={doc.id}>
              <td><strong>{doc.confidential && <Lock size={13} />} {doc.title}</strong><small className="table-sub">{doc.originalName} · {size(doc.sizeBytes)}{doc.reference ? ` · ${doc.reference}` : ''}</small></td>
              <td>{ARCHIVE_CATEGORY[doc.category]}</td>
              <td>{doc.employeeName ? <a href={`#/employees/${doc.employeeId}`}>{doc.employeeName}</a> : doc.departmentName ?? '—'}</td>
              <td>{doc.docDate ? formatDate(doc.docDate) : '—'}</td>
              <td>{doc.uploadedByName}<small className="table-sub">{formatDateTime(doc.createdAt)}</small></td>
              <td>{actions(doc)}</td>
            </tr>)}</tbody></table></div>}
      </section>
      <Dialog wide open={uploading} title="أرشفة ملفات · Upload to archive" subtitle="يمكن اختيار عدة ملفات مرة واحدة." onClose={() => setUploading(false)}>
        <form className="form-grid" onSubmit={(event) => void upload(event)}>
          <label className="field settings-wide"><span>الملفات *</span><input type="file" name="files" multiple required /></label>
          <label className="field settings-wide"><span>العنوان (لملف واحد)</span><input name="title" maxLength={200} /></label>
          <label className="field"><span>التصنيف</span><select name="category" defaultValue="hr">{Object.entries(ARCHIVE_CATEGORY).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label className="field"><span>القسم</span><select name="departmentId"><option value="">—</option>{departments.data.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <div className="settings-wide"><EmployeePicker label="الموظف (اختياري)" value={employee} onChange={setEmployee} /></div>
          <label className="field"><span>تاريخ الوثيقة</span><input type="date" name="docDate" /></label>
          <label className="field"><span>رقم المرجع / الكتاب</span><input name="reference" maxLength={80} /></label>
          <label className="field settings-wide"><span>كلمات للبحث</span><input name="tags" maxLength={300} /></label>
          <label className="field settings-wide"><span>ملاحظات</span><textarea name="notes" rows={2} maxLength={1000} /></label>
          <label className="settings-check"><input type="checkbox" name="confidential" />سرية (تظهر لمن يملك صلاحية إدارة الأرشيف فقط)</label>
          <div className="dialog-actions settings-wide"><button className="button button-primary" type="submit"><Archive size={15} />أرشفة</button></div>
        </form>
      </Dialog>
      {reason.element}
    </section>
  );
}

const SEPARATION: Record<string, string> = {
  resignation: 'استقالة · Resignation', termination: 'إنهاء خدمة · Termination', end_of_contract: 'انتهاء العقد · End of contract',
  retirement: 'تقاعد · Retirement', death: 'وفاة · Death', absconded: 'انقطاع عن العمل · Absconded', other: 'أخرى · Other',
};

interface Former {
  id: string; employeeNo: string; fullName: string; department: string; position: string; branchName: string; hireDate: string;
  terminationDate: string | null; separationReason: string | null; separationNote: string | null; separatedAt: string | null; separatedByName: string | null;
  status: string; documents: string;
}

/** Former employees: who left, when and why, with their files kept. */
export function FormerEmployeesPage() {
  const session = useSession();
  const [query, setQuery] = useState('');
  const rows = useLoad<Former[]>(`/employees/former?q=${encodeURIComponent(query)}`, []);
  const [separating, setSeparating] = useState(false);
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const reason = useReasonPrompt();
  const byReason = Object.keys(SEPARATION).map((key) => ({ key, count: rows.data.filter((row) => row.separationReason === key).length })).filter((item) => item.count);

  async function separate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!employee) return;
    const form = new FormData(event.currentTarget);
    try {
      await session.call(`/employees/${employee.id}/separate`, { method: 'POST', body: {
        terminationDate: form.get('terminationDate'), reason: form.get('reason'), note: form.get('note') || null, disableAccount: form.get('disableAccount') === 'on',
      } });
      session.notify('نُقل الموظف إلى أرشيف المنفكّين.');
      setSeparating(false);
      setEmployee(null);
      rows.reload();
    } catch (error) { session.fail(error, 'تعذر الحفظ.'); }
  }
  async function reinstate(row: Former) {
    const note = await reason.ask(`إعادة ${row.fullName} إلى الخدمة`);
    if (!note) return;
    try { await session.call(`/employees/${row.id}/reinstate`, { method: 'POST', body: { note } }); rows.reload(); session.notify('أُعيد الموظف إلى الخدمة.'); }
    catch (error) { session.fail(error, 'تعذر الإرجاع.'); }
  }
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="أرشيف الموظفين المنفكّين" en="Former employees" /></h2><p>المستقيلون ومنتهية خدماتهم مع تاريخ آخر يوم عمل والسبب ومن سجّله، وملفاتهم ومستمسكاتهم محفوظة.</p></div>
        {session.can('employees.update') && <button className="button button-primary" onClick={() => setSeparating(true)}><UserMinus size={16} />تسجيل انفكاك · Record separation</button>}</div>
      <div className="stat-row"><Stat label="المنفكّون · Former" value={formatNumber(rows.data.length)} />
        {byReason.slice(0, 3).map((item) => <Stat key={item.key} label={SEPARATION[item.key]} value={formatNumber(item.count)} />)}</div>
      <section className="panel">
        <div className="filter-bar"><label className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث بالاسم أو الرقم…" /></label></div>
        {rows.loading ? <Loading /> : !rows.data.length ? <Empty icon={<Archive size={22} />} title="لا يوجد منفكّون" text="يظهر هنا من انتهت خدمته." />
          : <div className="table-scroll"><table className="dense"><thead><tr><th>الموظف</th><th>الوظيفة</th><th>الخدمة</th><th>السبب</th><th>سجّله</th><th /></tr></thead>
            <tbody>{rows.data.map((row) => <tr key={row.id}>
              <td><a href={`#/employees/${row.id}`}><strong>{row.fullName}</strong></a><small className="table-sub">{row.employeeNo} · {row.branchName}</small></td>
              <td>{row.position}<small className="table-sub">{row.department}</small></td>
              <td>{formatDate(row.hireDate)} → {row.terminationDate ? formatDate(row.terminationDate) : '—'}</td>
              <td>{row.separationReason ? SEPARATION[row.separationReason] : <Tone tone="muted">غير نشط</Tone>}{row.separationNote && <small className="table-sub">{row.separationNote}</small>}</td>
              <td>{row.separatedByName ?? '—'}{row.separatedAt && <small className="table-sub">{formatDateTime(row.separatedAt)}</small>}</td>
              <td>{session.can('employees.update') && <button className="button button-quiet button-small" onClick={() => void reinstate(row)}><RotateCcw size={14} />إرجاع</button>}</td>
            </tr>)}</tbody></table></div>}
      </section>
      <Dialog open={separating} title="تسجيل انفكاك موظف · Record a separation" onClose={() => setSeparating(false)}>
        <form className="form-grid" onSubmit={(event) => void separate(event)}>
          <div className="settings-wide"><EmployeePicker label="الموظف *" value={employee} onChange={setEmployee} /></div>
          <label className="field"><span>آخر يوم عمل *</span><input type="date" name="terminationDate" required /></label>
          <label className="field"><span>السبب *</span><select name="reason" required>{Object.entries(SEPARATION).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label className="field settings-wide"><span>ملاحظات</span><textarea name="note" rows={3} maxLength={1000} /></label>
          <label className="settings-check settings-wide"><input type="checkbox" name="disableAccount" defaultChecked />إيقاف حساب البوابة للموظف</label>
          <p className="muted settings-wide">الراتب الأخير يُصرف بالتسوية حسب إعدادات الرواتب، والملف يبقى محفوظاً ويمكن إرجاعه.</p>
          <div className="dialog-actions settings-wide"><button className="button button-primary" type="submit" disabled={!employee}>حفظ</button></div>
        </form>
      </Dialog>
      {reason.element}
    </section>
  );
}

interface ArchiveMonth {
  id: string; period: string; label: string; originalName: string; employeeCount: number; totals: Record<string, { employees: number; net: number; gross: number }>;
  notes: string | null; createdAt: string; uploadedByName: string; branchName: string | null; unmatched: string;
  governorateId: string | null; governorateName: string | null;
}
interface Preview {
  format: string; sheet: string; period: string; duplicate: boolean; lines: number; skipped: number; matched: number;
  totals: ArchiveMonth['totals']; unmatched: Array<{ employeeNo: string; employeeName: string | null }>;
  sample: Array<{ employeeNo: string; employeeName: string | null; currency: string; gross: number | null; totalDeductions: number | null; netPay: number }>;
}

/** Payroll archive: the months paid before the system went live, file by file, month by month. */
export function PayrollArchivePage({ monthId }: { monthId?: string }) {
  const session = useSession();
  const months = useLoad<{ months: ArchiveMonth[]; launchPeriod: string | null }>('/payroll/archive', { months: [], launchPeriod: null });
  const [file, setFile] = useState<File | null>(null);
  const [period, setPeriod] = useState('');
  const [label, setLabel] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [governorateId, setGovernorateId] = useState('');
  const governorates = useGovernorates();
  if (monthId) return <ArchiveMonthView id={monthId} />;
  const launch = months.data.launchPeriod;
  const byPeriod = months.data.months.reduce<Record<string, ArchiveMonth[]>>((groups, month) => { (groups[month.period] ??= []).push(month); return groups; }, {});
  const year = (launch ?? new Date().toISOString().slice(0, 7)).slice(0, 4);
  const timeline = Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`);

  const form = () => {
    const body = new FormData(); body.set('file', file!); if (period) body.set('period', period); if (label) body.set('label', label);
    if (governorateId) body.set('governorateId', governorateId);
    return body;
  };
  async function check() {
    if (!file) return;
    setBusy(true);
    try { setPreview((await session.call<{ data: Preview }>('/payroll/archive/preview', { form: form() })).data); if (!period) setPeriod(''); }
    catch (error) { session.fail(error, 'تعذر قراءة الملف.'); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true);
    try {
      await session.call('/payroll/archive', { form: form() });
      session.notify('أُرشف شهر الرواتب.');
      setPreview(null); setFile(null); setLabel(''); setPeriod('');
      months.reload();
    } catch (error) { session.fail(error, 'تعذر الحفظ.'); } finally { setBusy(false); }
  }
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="أرشيف المسيرات" en="Payroll archive" /></h2>
        <p>ارفع ملف رواتب كل شهر من بداية 2026 حتى شهر الانطلاق{launch ? ` (${monthLabel(launch)})` : ''}. يُحفظ الملف الأصلي ويُوزّع صافي كل موظف على شهره الحقيقي، فيظهر في سجل رواتبه مع مسيرات النظام بعد الانطلاق.</p></div></div>
      <section className="panel">
        <div className="panel-head"><div><h3>أشهر {year} · {year} months</h3><p>الأخضر مؤرشف، والبرتقالي شهر الانطلاق، وما بعده يُحتسب بمسيرات النظام.</p></div></div>
        <div className="table-scroll"><table className="archive-matrix"><thead><tr><th>المحافظة</th>{timeline.map((month) => <th key={month} className={launch === month ? 'is-launch' : ''}>{monthLabel(month).split(' ')[0]}</th>)}</tr></thead>
          <tbody>{[...governorates.data.governorates.map((item) => ({ id: item.id, name: item.nameAr })), { id: '', name: 'بلا محافظة' }].map((row) => {
            const files = months.data.months.filter((month) => (month.governorateId ?? '') === row.id);
            if (!row.id && !files.length) return null;
            return <tr key={row.id || 'none'}><th>{row.name}</th>{timeline.map((month) => {
              const done = files.filter((item) => item.period === month);
              const after = launch && month > launch;
              return <td key={month} className={`month-cell ${done.length ? 'is-done' : ''} ${launch === month ? 'is-launch' : ''} ${after ? 'is-system' : ''}`}
                title={done.map((item) => `${item.label} — ${item.employeeCount} موظف`).join('\n')}>
                {done.length ? `✓ ${formatNumber(done.reduce((sum, item) => sum + item.employeeCount, 0))}` : after ? 'النظام' : '—'}</td>;
            })}</tr>;
          })}</tbody></table></div>
      </section>
      {session.can('payroll.prepare') && <section className="panel">
        <div className="panel-head"><div><h3>رفع شهر · Upload a month</h3><p>ملف Excel للفرع أو للشركة. يُقرأ شهر الرواتب من لوحة الملف إن وُجد، وإلا اختره.</p></div></div>
        <div className="form-grid">
          <label className="field"><span>الملف (xlsx) *</span><input type="file" accept=".xlsx" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); }} /></label>
          <label className="field"><span>الشهر</span><input type="month" value={period} max={launch ?? undefined} onChange={(event) => setPeriod(event.target.value)} /></label>
          <label className="field"><span>المحافظة *</span><select value={governorateId} onChange={(event) => setGovernorateId(event.target.value)}>
            <option value="">اختر المحافظة</option>{governorates.data.governorates.map((item) => <option key={item.id} value={item.id}>{item.nameAr} · {item.nameEn}</option>)}</select></label>
          <label className="field"><span>الوصف (مثل: رواتب أربيل)</span><input value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} /></label>
        </div>
        <div className="dialog-actions"><button className="button button-quiet" disabled={!file || busy} onClick={() => void check()}>معاينة · Preview</button>
          {preview && !preview.duplicate && <button className="button button-primary" disabled={busy || !governorateId} title={governorateId ? undefined : 'اختر المحافظة'} onClick={() => void save()}>أرشفة {monthLabel(preview.period)}</button>}</div>
        {preview && <div className="archive-preview">
          {preview.duplicate && <p className="form-error">هذا الملف مؤرشف مسبقاً لنفس الشهر.</p>}
          <div className="stat-row"><Stat label="الشهر" value={monthLabel(preview.period)} /><Stat label="الموظفون" value={formatNumber(preview.lines)} />
            <Stat label="طوبقوا مع ملفاتهم" value={`${preview.matched}/${preview.lines}`} tone={preview.matched < preview.lines ? 'warn' : 'good'} />
            {Object.entries(preview.totals).map(([currency, total]) => <Stat key={currency} label={`صافي ${currency}`} value={formatMoney(total.net, currency)} />)}</div>
          {preview.unmatched.length > 0 && <p className="muted">أرقام غير موجودة في النظام (تُحفظ بالاسم): {preview.unmatched.map((row) => `${row.employeeNo}${row.employeeName ? ` ${row.employeeName}` : ''}`).join('، ')}</p>}
          <div className="table-scroll"><table className="dense"><thead><tr><th>الرقم</th><th>الاسم</th><th>الإجمالي</th><th>الاستقطاعات</th><th>الصافي</th></tr></thead>
            <tbody>{preview.sample.map((row) => <tr key={row.employeeNo}><td>{row.employeeNo}</td><td>{row.employeeName}</td><td>{formatMoney(row.gross, row.currency)}</td><td>{formatMoney(row.totalDeductions, row.currency)}</td><td><strong>{formatMoney(row.netPay, row.currency)}</strong></td></tr>)}</tbody></table></div>
        </div>}
      </section>}
      <section className="panel">
        {months.loading ? <Loading /> : !months.data.months.length ? <Empty icon={<FileArchive size={22} />} title="لا توجد أشهر مؤرشفة" text="ارفع ملف أول شهر." />
          : <div className="table-scroll"><table className="dense"><thead><tr><th>الشهر</th><th>الملف</th><th>الموظفون</th><th>الصافي</th><th>رفعه</th></tr></thead>
            <tbody>{months.data.months.map((month) => <tr key={month.id} className="row-link" onClick={() => navigate('payroll-archive', month.id)}>
              <td><strong>{monthLabel(month.period)}</strong><small className="table-sub">{month.governorateName ? `${month.governorateName} · ` : ''}{month.label}</small></td>
              <td>{month.originalName}</td>
              <td>{formatNumber(month.employeeCount)}{Number(month.unmatched) > 0 && <small className="table-sub">{month.unmatched} بلا ملف</small>}</td>
              <td>{Object.entries(month.totals).map(([currency, total]) => <div key={currency}>{formatMoney(total.net, currency)}</div>)}</td>
              <td>{month.uploadedByName}<small className="table-sub">{formatDateTime(month.createdAt)}</small></td>
            </tr>)}</tbody></table></div>}
      </section>
    </section>
  );
}

function ArchiveMonthView({ id }: { id: string }) {
  const session = useSession();
  const data = useLoad<{ month: { id: string; period: string; label: string }; lines: Array<{ id: string; employeeNo: string; employeeName: string | null; employeeId: string | null; currency: string; gross: number | null; totalDeductions: number | null; netPay: number }> } | null>(`/payroll/archive/${id}`, null);
  if (!data.data) return <Loading />;
  const { month, lines } = data.data;
  const totals = lines.reduce<Record<string, number>>((sum, line) => { sum[line.currency] = (sum[line.currency] ?? 0) + line.netPay; return sum; }, {});
  return (
    <section className="screen">
      <div className="screen-heading no-print"><div><h2>{monthLabel(month.period)} — {month.label}</h2></div>
        <div className="row-actions">
          <button className="button button-quiet" onClick={() => void downloadFile(`/payroll/archive/${id}/file`, session.token, 'payroll.xlsx')}><Download size={15} />الملف الأصلي</button>
          {session.user.role === 'super_admin' && <button className="button button-danger" onClick={async () => {
            try { await session.call(`/payroll/archive/${id}/withdraw`, { method: 'POST', body: {} }); navigate('payroll-archive'); session.notify('نُقل إلى سلة المحذوفات.'); }
            catch (error) { session.fail(error, 'تعذر السحب.'); }
          }}><Trash2 size={15} />سحب</button>}
        </div></div>
      <DocumentFrame title={`كشف رواتب ${monthLabel(month.period)} (أرشيف)`} titleEn={`Payroll register ${month.period} (archive)`} reference={month.label} fileName={`payroll-${month.period}`}>
        <table className="dense"><thead><tr><th>الرقم</th><th>الاسم</th><th>العملة</th><th>الإجمالي</th><th>الاستقطاعات</th><th>الصافي</th></tr></thead>
          <tbody>{lines.map((line) => <tr key={line.id}><td>{line.employeeNo}</td><td>{line.employeeId ? <a href={`#/employees/${line.employeeId}`}>{line.employeeName}</a> : line.employeeName}</td>
            <td>{line.currency}</td><td>{formatMoney(line.gross, line.currency)}</td><td>{formatMoney(line.totalDeductions, line.currency)}</td><td><strong>{formatMoney(line.netPay, line.currency)}</strong></td></tr>)}</tbody>
          <tfoot>{Object.entries(totals).map(([currency, total]) => <tr key={currency}><td colSpan={5}>المجموع {currency}</td><td><strong>{formatMoney(total, currency)}</strong></td></tr>)}</tfoot>
        </table>
      </DocumentFrame>
    </section>
  );
}
