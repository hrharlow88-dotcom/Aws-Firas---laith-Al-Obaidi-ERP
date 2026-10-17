import { useEffect, useState } from 'react';
import { Camera, CheckCircle2, Download, FileSpreadsheet, ImagePlus, Images, Upload, X } from 'lucide-react';
import { Bi } from '../components/Brand';
import { Dialog, Empty, Loading, Stat, Tabs, Tone, Warning } from '../components/ui';
import { apiBlob, downloadFile } from '../lib/api';
import { formatDateTime, formatNumber } from '../lib/format';
import { navigate } from '../lib/router';
import { useLoad, useSession } from '../lib/session';

interface SheetRow {
  row: number; action: 'create' | 'update' | 'none' | 'error'; employeeNo: string; employeeId: string | null; fullName: string | null;
  changes: Array<{ field: string; label: string; from: string | null; to: string | null }>;
  errors: string[]; warnings: string[];
}
interface SheetPreview {
  columns: string[]; rows: SheetRow[]; newJobTitles: string[];
  summary: { rows: number; create: number; update: number; unchanged: number; errors: number; salaries: number };
}

type Tab = 'sheet' | 'photos';

/** Employees' master data from one Excel sheet, and their photos (in bulk, or sent from the portal). */
export function EmployeesImportPage() {
  const session = useSession();
  const [tab, setTab] = useState<Tab>('sheet');
  const canPhotos = session.can('employees.manage_profile');
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="استيراد وتحديث بيانات الموظفين" en="Import and update employee data" /></h2>
        <p>ملف Excel واحد لكل البيانات: الاسمان، رقم البصمة، البريد والهاتف الشخصيان، المدير، القسم، المسمى، المحافظة، الفرع، المباشرة والراتب. والصور دفعة واحدة أو من بوابة الموظفين.</p></div></div>
      {canPhotos && <Tabs<Tab> value={tab} onChange={setTab} items={[{ id: 'sheet', label: 'ملف الموظفين · Excel' }, { id: 'photos', label: 'الصور · Photos' }]} />}
      {tab === 'sheet' && <EmployeeSheet />}
      {tab === 'photos' && canPhotos && <Photos />}
    </section>
  );
}

function EmployeeSheet() {
  const session = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SheetPreview | null>(null);
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState<'changes' | 'errors' | 'all'>('changes');

  async function check(selected: File) {
    setFile(selected);
    setPreview(null);
    setBusy('preview');
    const form = new FormData();
    form.append('file', selected);
    try {
      const result = await session.call<{ data: SheetPreview }>('/employees/import/preview', { form });
      setPreview(result.data);
      setFilter(result.data.summary.errors ? 'errors' : 'changes');
    } catch (error) {
      session.fail(error, 'تعذرت قراءة الملف.');
    } finally {
      setBusy('');
    }
  }

  async function apply() {
    if (!file) return;
    setBusy('apply');
    const form = new FormData();
    form.append('file', file);
    try {
      const result = await session.call<{ data: { created: number; updated: number; salaries: number } }>('/employees/import/apply', { form });
      const parts = [
        result.data.created && `أُضيف ${formatNumber(result.data.created)} موظف`,
        result.data.updated && `حُدّث ${formatNumber(result.data.updated)}`,
        result.data.salaries && `${formatNumber(result.data.salaries)} راتب جديد`,
      ].filter(Boolean);
      session.notify(`${parts.join('، ')}. التغييرات مسجلة في سجل التدقيق.`);
      setPreview(null);
      setFile(null);
    } catch (error) {
      session.fail(error, 'تعذر الاعتماد.');
    } finally {
      setBusy('');
    }
  }

  const changed = preview ? preview.summary.create + preview.summary.update : 0;
  const rows = preview?.rows.filter((row) => (filter === 'all' ? true : filter === 'errors' ? row.errors.length : row.changes.length && !row.errors.length)) ?? [];
  return (
    <section className="panel">
      <div className="panel-head">
        <div><h3>ملف بيانات الموظفين</h3><p>نزّل الملف بالبيانات الحالية، عدّله أو أضف أسطراً لموظفين جدد، ثم ارفعه. أو ارفع ملفاً من عندك بنفس عناوين الأعمدة (مثلاً: رقم الموظف ورقم البصمة والبريد والهاتف فقط). لا يُحفظ شيء قبل المعاينة.</p></div>
        <div className="heading-actions">
          <button className="button button-quiet" onClick={() => void downloadFile('/employees/import/template.xlsx', session.token, 'employees.xlsx').catch((error) => session.fail(error, 'تعذر التنزيل.'))}><Download size={15} />تنزيل ملف الموظفين</button>
          <label className="button button-primary file-button"><Upload size={15} />{busy === 'preview' ? 'جارٍ الفحص…' : 'رفع الملف'}<input type="file" accept=".xlsx,.csv,.txt" hidden onChange={(event) => { const selected = event.target.files?.[0]; if (selected) void check(selected); event.target.value = ''; }} /></label>
        </div>
      </div>
      {!preview ? <Empty icon={<FileSpreadsheet size={22} />} title="ارفع ملف الموظفين" text="يُقرأ الملف ويُعرض كل تغيير وكل خطأ قبل الحفظ. الخلية الفارغة لا تغيّر شيئاً، و«-» تمسح القيمة." /> : <>
        <div className="panel-pad">
          <div className="stat-row">
            <Stat label="أسطر الملف" value={formatNumber(preview.summary.rows)} foot={`${formatNumber(preview.columns.length)} عموداً مقروءاً`} />
            <Stat label="موظفون جدد" value={formatNumber(preview.summary.create)} tone={preview.summary.create ? 'good' : undefined} />
            <Stat label="سيتحدّثون" value={formatNumber(preview.summary.update)} foot={preview.summary.salaries ? `${formatNumber(preview.summary.salaries)} راتب جديد` : undefined} />
            <Stat label="أسطر بأخطاء" value={formatNumber(preview.summary.errors)} tone={preview.summary.errors ? 'bad' : undefined} foot={`${formatNumber(preview.summary.unchanged)} بلا تغيير`} />
          </div>
          {preview.newJobTitles.length > 0 && <Warning title="مسميات جديدة ستُضاف">{preview.newJobTitles.join('، ')}</Warning>}
          {preview.summary.errors > 0 && <Warning title="صحح الأخطاء ثم ارفع الملف من جديد">لا يُحفظ أي سطر ما دام في الملف خطأ واحد.</Warning>}
        </div>
        <div className="panel-pad"><Tabs<'changes' | 'errors' | 'all'> value={filter} onChange={setFilter} items={[
          { id: 'changes', label: 'التغييرات', badge: changed },
          { id: 'errors', label: 'الأخطاء', badge: preview.summary.errors },
          { id: 'all', label: 'كل الأسطر', badge: preview.summary.rows },
        ]} /></div>
        {rows.length ? <div className="table-scroll"><table className="dense">
          <thead><tr><th>السطر</th><th>الموظف</th><th>التغيير</th><th>ملاحظات</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.row}>
            <td>{row.row}</td>
            <td><strong>{row.fullName ?? '—'}</strong><small className="table-sub" dir="ltr">{row.employeeNo}</small>{row.action === 'create' && <Tone tone="good">جديد</Tone>}</td>
            <td>{row.changes.length ? row.changes.map((change, index) => <div key={`${change.field}-${index}`} className="change-line"><b>{change.label}:</b> {change.from !== null && <><span className="muted">{change.from || '—'}</span> ← </>}<strong>{change.to ?? 'بدون'}</strong></div>) : <span className="muted">بلا تغيير</span>}</td>
            <td className="wrap">{row.errors.map((error) => <div key={error}><Tone tone="bad">{error}</Tone></div>)}{row.warnings.map((warning) => <div key={warning}><Tone tone="warn">{warning}</Tone></div>)}</td>
          </tr>)}</tbody>
        </table></div> : <Empty icon={<CheckCircle2 size={22} />} title={filter === 'errors' ? 'لا أخطاء' : 'لا تغييرات'} text={filter === 'errors' ? 'الملف جاهز للاعتماد.' : 'البيانات في الملف مطابقة للنظام.'} />}
        <div className="dialog-actions panel-pad">
          <button className="button button-primary" disabled={Boolean(preview.summary.errors) || !changed || busy === 'apply'} onClick={() => void apply()}><CheckCircle2 size={16} />{busy === 'apply' ? 'جارٍ الاعتماد…' : `اعتماد (${formatNumber(changed)})`}</button>
          <button className="button button-quiet" onClick={() => { setPreview(null); setFile(null); }}>إلغاء</button>
        </div>
      </>}
    </section>
  );
}

interface Submission { id: string; employeeId: string; employeeNo: string; fullName: string; branchName: string; submittedAt: string; hasPhoto: boolean }
interface Match { name: string; key: string; employee: { id: string; employeeNo: string; fullName: string; hasPhoto: boolean } | null }

function SubmissionPhoto({ id }: { id: string }) {
  const { token } = useSession();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let created: string | null = null;
    let live = true;
    apiBlob(`/employees/photo-submissions/${id}/file`, token).then((result) => {
      created = result.url;
      if (live) setUrl(result.url); else URL.revokeObjectURL(result.url);
    }).catch(() => setUrl(null));
    return () => { live = false; if (created) URL.revokeObjectURL(created); };
  }, [id, token]);
  return url ? <img className="submission-photo" src={url} alt="" /> : <span className="submission-photo submission-photo-empty"><Camera size={20} /></span>;
}

function Photos() {
  const session = useSession();
  const waiting = useLoad<Submission[]>('/employees/photo-submissions', []);
  const [busy, setBusy] = useState('');
  const [rejecting, setRejecting] = useState<Submission | null>(null);
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; failed: string[] } | null>(null);

  async function accept(ids?: string[]) {
    setBusy(ids ? ids[0] : 'all');
    try {
      const result = await session.call<{ data: { accepted: number } }>('/employees/photo-submissions/accept', { body: ids ? { ids } : {} });
      session.notify(`اعتُمدت ${formatNumber(result.data.accepted)} صورة وأُضيفت إلى ملفات الموظفين.`);
      waiting.reload();
    } catch (error) { session.fail(error, 'تعذر الاعتماد.'); } finally { setBusy(''); }
  }
  async function reject() {
    if (!rejecting) return;
    try {
      await session.call(`/employees/photo-submissions/${rejecting.id}/reject`, { body: { note } });
      session.notify('أُبلغ الموظف بسبب الرفض.');
      setRejecting(null);
      setNote('');
      waiting.reload();
    } catch (error) { session.fail(error, 'تعذر الرفض.'); }
  }
  async function choose(list: FileList | null) {
    const chosen = Array.from(list ?? []).filter((file) => /^image\/(jpeg|png|webp)$/.test(file.type));
    setFiles(chosen);
    setMatches(null);
    setProgress(null);
    if (!chosen.length) return;
    try {
      const result = await session.call<{ data: Match[] }>('/employees/photos/match', { body: { names: chosen.map((file) => file.name) } });
      setMatches(result.data);
    } catch (error) { session.fail(error, 'تعذرت مطابقة الأسماء.'); }
  }
  async function uploadAll() {
    if (!matches) return;
    const work = matches.map((match, index) => ({ match, file: files[index] })).filter((item) => item.match.employee && item.file);
    const failed: string[] = [];
    setProgress({ done: 0, total: work.length, failed });
    for (const [index, item] of work.entries()) {
      const form = new FormData();
      form.append('file', item.file);
      try {
        await session.call(`/employees/${item.match.employee!.id}/photo`, { form });
      } catch (error) {
        failed.push(`${item.file.name}: ${error instanceof Error ? error.message : 'تعذر الرفع'}`);
      }
      setProgress({ done: index + 1, total: work.length, failed: [...failed] });
    }
    session.notify(`رُفعت ${formatNumber(work.length - failed.length)} صورة${failed.length ? `، وتعذرت ${formatNumber(failed.length)}` : ''}.`);
    setFiles([]);
    setMatches(null);
  }

  const matched = matches?.filter((item) => item.employee).length ?? 0;
  return (
    <div className="split">
      <section className="panel">
        <div className="panel-head"><div><h3>صور من بوابة الموظفين</h3><p>صور أرسلها الموظفون من «خدمتي». اعتمدها كلها بضغطة واحدة، أو واحدة واحدة.</p></div>
          {waiting.data.length > 0 && <button className="button button-primary" disabled={Boolean(busy)} onClick={() => void accept()}><CheckCircle2 size={15} />{busy === 'all' ? 'جارٍ الاعتماد…' : `اعتماد الكل (${formatNumber(waiting.data.length)})`}</button>}</div>
        {waiting.loading && !waiting.data.length ? <Loading /> : waiting.data.length ? <div className="submission-grid">{waiting.data.map((item) => <div key={item.id} className="submission-card">
          <SubmissionPhoto id={item.id} />
          <div><strong>{item.fullName}</strong><small dir="ltr">{item.employeeNo}</small><small>{item.branchName} · {formatDateTime(item.submittedAt)}</small>{item.hasPhoto && <small className="muted">تحل محل صورته الحالية</small>}</div>
          <div className="row-actions">
            <button className="button button-small button-primary" disabled={Boolean(busy)} onClick={() => void accept([item.id])}><CheckCircle2 size={13} />اعتماد</button>
            <button className="button button-small button-quiet" onClick={() => { setRejecting(item); setNote(''); }}><X size={13} />رفض</button>
            <button className="text-button" onClick={() => navigate('employees', item.employeeId)}>الملف</button>
          </div>
        </div>)}</div> : <Empty icon={<Images size={22} />} title="لا صور بانتظار الاعتماد" text="عندما يرسل موظف صورته من بوابته تظهر هنا. يفتح المالك هذا الخيار من «لوحة المالك ← بوابة الموظف»." />}
      </section>
      <section className="panel">
        <div className="panel-head"><div><h3>رفع صور دفعة واحدة</h3><p>اختر صوراً كثيرة مرة واحدة، اسم كل صورة رقم الموظف أو رقم بصمته (مثل 10123.jpg). تُطابق الأسماء أولاً ثم تُرفع.</p></div>
          <label className="button button-quiet file-button"><ImagePlus size={15} />اختيار الصور<input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(event) => { void choose(event.target.files); event.target.value = ''; }} /></label></div>
        {progress && <div className="panel-pad">
          <div className="progress-line"><span style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} /></div>
          <p className="muted">{formatNumber(progress.done)} من {formatNumber(progress.total)}</p>
          {progress.failed.length > 0 && <Warning title="صور لم تُرفع">{progress.failed.join(' — ')}</Warning>}
        </div>}
        {matches ? <>
          <div className="table-scroll"><table className="dense">
            <thead><tr><th>الملف</th><th>الموظف</th><th /></tr></thead>
            <tbody>{matches.map((item) => <tr key={item.name}>
              <td dir="ltr">{item.name}</td>
              <td>{item.employee ? <><strong>{item.employee.fullName}</strong><small className="table-sub" dir="ltr">{item.employee.employeeNo}</small></> : <Tone tone="bad">لا يطابق رقم موظف أو بصمة</Tone>}</td>
              <td>{item.employee?.hasPhoto && <Tone tone="warn">تستبدل صورته</Tone>}</td>
            </tr>)}</tbody>
          </table></div>
          <div className="dialog-actions panel-pad">
            <button className="button button-primary" disabled={!matched || Boolean(progress && progress.done < progress.total)} onClick={() => void uploadAll()}><Upload size={15} />رفع {formatNumber(matched)} صورة</button>
            <button className="button button-quiet" onClick={() => { setFiles([]); setMatches(null); }}>إلغاء</button>
          </div>
        </> : !progress && <Empty icon={<ImagePlus size={22} />} title="اختر الصور" text="JPG أو PNG أو WEBP، حتى 3 ميغابايت للصورة." />}
      </section>
      <Dialog open={Boolean(rejecting)} title={`رفض صورة ${rejecting?.fullName ?? ''}`} subtitle="يصل السبب للموظف ليرسل صورة أفضل." onClose={() => setRejecting(null)}>
        <label className="field"><span>السبب *</span><input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="مثال: الصورة غير واضحة، أرسل صورة للوجه بخلفية فاتحة" /></label>
        <div className="dialog-actions"><button className="button button-primary" disabled={!note.trim()} onClick={() => void reject()}>رفض وإبلاغ الموظف</button><button className="button button-quiet" onClick={() => setRejecting(null)}>إلغاء</button></div>
      </Dialog>
    </div>
  );
}
