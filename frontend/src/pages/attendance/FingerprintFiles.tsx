import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, CheckCircle2, FileUp, Fingerprint, MapPin, RefreshCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Bi } from '../../components/Brand';
import { Dialog, Empty, Loading, Stat, Tabs, Tone, Warning } from '../../components/ui';
import { formatNumber } from '../../lib/format';
import { useSession } from '../../lib/session';

export type FileKind = 'attendance' | 'leaves' | 'tasks';

export const FILE_KIND: Record<FileKind, { title: string; en: string; text: string; icon: LucideIcon }> = {
  attendance: {
    title: 'ملف الحضور', en: 'Attendance', icon: Fingerprint,
    text: 'بصمات الدخول والخروج من جهاز البصمة: سطر لكل بصمة، أو سطر لكل يوم بوقت الدخول والخروج.',
  },
  leaves: {
    title: 'ملف الإجازات', en: 'Leave', icon: CalendarDays,
    text: 'كل أنواع الإجازات من نظام البصمة. تُسجّل معتمدة وتُخصم من الرصيد، والمسجلة مسبقاً لا تتكرر.',
  },
  tasks: {
    title: 'ملف المهام', en: 'App tasks', icon: MapPin,
    text: 'حركات بصمة التطبيق للتكاليف والعمل الخارجي. وقت المهمة يُحتسب دواماً، واليوم الكامل حضوراً.',
  },
};

type RowStatus = 'ok' | 'duplicate' | 'skip' | 'unmatched' | 'error';
interface PreviewRow {
  row: number; pin: string; name: string; employee: { id: string; employeeNo: string; fullName: string } | null;
  date: string | null; detail: string; status: RowStatus; note: string | null; warnings: string[];
}
interface FilePreview {
  kind: FileKind; format: string; headerIndex: number; header: string[]; sample: string[][]; top: string[][];
  mapping: Record<string, number>; fields: Array<{ key: string; label: string; required: boolean }>;
  leaveTypes?: Array<{ name: string; count: number; typeId: string | null }>;
  summary: Record<string, number | string | null>;
  rows: PreviewRow[]; rowsShown: number;
}

const STATUS: Record<RowStatus, { label: string; tone: string }> = {
  ok: { label: 'جاهز', tone: 'good' },
  duplicate: { label: 'موجود مسبقاً', tone: 'muted' },
  skip: { label: 'متجاهل', tone: 'muted' },
  unmatched: { label: 'رقم غير مربوط', tone: 'warn' },
  error: { label: 'لن يُستورد', tone: 'bad' },
};

const letter = (index: number) => {
  let value = index + 1;
  let out = '';
  while (value > 0) { const rest = (value - 1) % 26; out = String.fromCharCode(65 + rest) + out; value = Math.floor((value - 1) / 26); }
  return out;
};

/** The three exports of the fingerprint system, each uploaded on its own. */
export function FingerprintFiles({ onApplied }: { onApplied: () => void }) {
  const [open, setOpen] = useState<{ kind: FileKind; file: File } | null>(null);
  return (
    <section className="panel">
      <div className="panel-head"><div><h3><Bi ar="ملفات نظام البصمة" en="Fingerprint system files" /></h3>
        <p>ارفع كل ملف على حدة. يُقرأ كل سطر برقم الموظف في البصمة واسمه وتاريخ اليوم، وتُعرض النتيجة قبل الحفظ.</p></div></div>
      <div className="fp-cards">{(Object.keys(FILE_KIND) as FileKind[]).map((kind) => {
        const item = FILE_KIND[kind];
        const Icon = item.icon;
        return <div key={kind} className="fp-card">
          <span className="fp-card-icon"><Icon size={22} /></span>
          <div><h4><Bi ar={item.title} en={item.en} /></h4><p>{item.text}</p></div>
          <label className="button button-primary file-button"><FileUp size={15} />اختيار الملف
            <input type="file" accept=".xlsx,.csv,.txt,.xls,.htm,.html" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) setOpen({ kind, file }); event.target.value = ''; }} />
          </label>
        </div>;
      })}</div>
      {open && <FileDialog kind={open.kind} file={open.file} onClose={() => setOpen(null)} onApplied={() => { setOpen(null); onApplied(); }} />}
    </section>
  );
}

function FileDialog({ kind, file, onClose, onApplied }: { kind: FileKind; file: File; onClose: () => void; onApplied: () => void }) {
  const session = useSession();
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [headerIndex, setHeaderIndex] = useState<number | null>(null);
  const [dateOrder, setDateOrder] = useState<'dmy' | 'mdy'>('dmy');
  const [typeMap, setTypeMap] = useState<Record<string, string>>({});
  const [defaultTypeId, setDefaultTypeId] = useState('');
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState<'all' | RowStatus>('all');
  const leaveTypes = session.settings.leaveTypes.filter((type) => type.active);

  const form = useMemo(() => () => {
    const data = new FormData();
    data.append('file', file);
    data.append('kind', kind);
    data.append('dateOrder', dateOrder);
    if (Object.keys(mapping).length) data.append('mapping', JSON.stringify(mapping));
    if (headerIndex !== null) data.append('headerIndex', String(headerIndex));
    if (Object.keys(typeMap).length) data.append('typeMap', JSON.stringify(typeMap));
    if (defaultTypeId) data.append('defaultTypeId', defaultTypeId);
    return data;
  }, [file, kind, dateOrder, mapping, headerIndex, typeMap, defaultTypeId]);

  useEffect(() => {
    let live = true;
    setBusy('preview');
    session.call<{ data: FilePreview }>('/attendance/files/preview', { form: form() })
      .then((result) => { if (live) setPreview(result.data); })
      .catch((error) => { if (live) { session.fail(error, 'تعذرت قراءة الملف.'); if (!preview) onClose(); } })
      .finally(() => { if (live) setBusy(''); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  async function apply() {
    setBusy('apply');
    try {
      const result = await session.call<{ data: Record<string, number | string | null> }>('/attendance/files/apply', { form: form() });
      const data = result.data;
      const saved = Number(data.pinsSaved ?? 0);
      const message = kind === 'attendance'
        ? `استُوردت ${formatNumber(Number(data.imported ?? 0))} بصمة${Number(data.unmatched) ? `، منها ${formatNumber(Number(data.unmatched))} برقم غير مربوط` : ''}`
        : kind === 'leaves' ? `سُجلت ${formatNumber(Number(data.leaves ?? 0))} إجازة معتمدة وخُصمت من الأرصدة`
          : `سُجلت ${formatNumber(Number(data.tasks ?? 0))} مهمة و${formatNumber(Number(data.punches ?? 0))} بصمة تطبيق`;
      session.notify(`${message}${saved ? `، وحُفظ رقم البصمة لـ ${formatNumber(saved)} موظف` : ''}. أُعيد احتساب الأيام.`);
      onApplied();
    } catch (error) {
      session.fail(error, 'تعذر الاعتماد.');
    } finally {
      setBusy('');
    }
  }

  const info = FILE_KIND[kind];
  const summary = preview?.summary ?? {};
  const width = preview ? Math.max(preview.header.length, ...preview.sample.map((row) => row.length), 1) : 0;
  const columnName = (index: number) => `${letter(index)} · ${preview?.header[index]?.trim() || 'بلا عنوان'}`;
  const counts = (status: RowStatus) => preview?.rows.filter((row) => row.status === status).length ?? 0;
  const rows = preview?.rows.filter((row) => filter === 'all' || row.status === filter) ?? [];
  const importable = kind === 'attendance' ? Number(summary.punches ?? 0) > 0 : kind === 'leaves' ? Number(summary.ok ?? 0) > 0 : Number(summary.tasks ?? 0) > 0;
  const problem = typeof summary.problem === 'string' ? summary.problem : null;

  return (
    <Dialog open title={`${info.title}: ${file.name}`} subtitle={info.text} onClose={onClose} wide>
      {!preview ? <Loading /> : <div className="fp-dialog">
        <details className="fp-columns" open={Boolean(problem) || undefined}>
          <summary><strong>الأعمدة</strong> <span className="muted">صف العناوين {preview.headerIndex + 1} من الملف · {preview.format.toUpperCase()} · غيّرها إذا قُرئت خطأ</span></summary>
          <div className="form-grid form-grid-2">
            <label className="field"><span>صف العناوين</span>
              <select value={preview.headerIndex} onChange={(event) => { setHeaderIndex(Number(event.target.value)); setMapping({}); }}>
                {preview.top.map((row, index) => <option key={index} value={index}>{`الصف ${index + 1}: ${row.filter(Boolean).slice(0, 4).join(' | ').slice(0, 60)}`}</option>)}
              </select></label>
            <label className="field"><span>ترتيب التاريخ</span>
              <select value={dateOrder} onChange={(event) => setDateOrder(event.target.value as 'dmy' | 'mdy')}><option value="dmy">يوم/شهر/سنة</option><option value="mdy">شهر/يوم/سنة</option></select>
              <small>لا يؤثر على صيغة 2026-10-01.</small></label>
            {preview.fields.map((field) => <label key={field.key} className="field"><span>{field.label}{field.required ? ' *' : ''}</span>
              <select value={preview.mapping[field.key] ?? -1} onChange={(event) => setMapping({ ...preview.mapping, [field.key]: Number(event.target.value) })}>
                <option value={-1}>— لا يوجد —</option>
                {Array.from({ length: width }, (_, index) => <option key={index} value={index}>{columnName(index)}</option>)}
              </select></label>)}
          </div>
        </details>

        {kind === 'leaves' && <div className="fp-types">
          <h4>أنواع الإجازات في الملف</h4>
          {preview.leaveTypes?.length ? <div className="table-scroll"><table className="dense">
            <thead><tr><th>في الملف</th><th>الأسطر</th><th>في النظام</th></tr></thead>
            <tbody>{preview.leaveTypes.map((item) => <tr key={item.name}>
              <td><strong>{item.name}</strong></td><td>{formatNumber(item.count)}</td>
              <td><select value={typeMap[item.name] ?? item.typeId ?? ''} onChange={(event) => setTypeMap({ ...typeMap, [item.name]: event.target.value })}>
                <option value="" disabled>اختر النوع…</option>
                {leaveTypes.map((type) => <option key={type.id} value={type.id}>{type.name}{type.unit === 'hours' ? ' (ساعات)' : ''}</option>)}
                <option value="skip">تجاهل هذا النوع</option>
              </select>{!(typeMap[item.name] ?? item.typeId) && <Tone tone="warn">غير مربوط</Tone>}</td>
            </tr>)}</tbody>
          </table></div> : <p className="muted">لا يوجد عمود لنوع الإجازة في الملف.</p>}
          <label className="field fp-default-type"><span>النوع للأسطر بلا نوع</span>
            <select value={defaultTypeId} onChange={(event) => setDefaultTypeId(event.target.value)}>
              <option value="">— بلا —</option>
              {leaveTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
            </select></label>
        </div>}

        {problem ? <Warning title="حدد الأعمدة">{problem}</Warning> : <>
          <div className="stat-row">
            <Stat label="أسطر مقروءة" value={formatNumber(Number(summary.rows ?? 0))} foot={summary.from ? <span dir="ltr">{summary.from === summary.to ? summary.from : `${summary.from} → ${summary.to}`}</span> : undefined} />
            {kind === 'attendance' && <Stat label="بصمات جديدة" value={formatNumber(Number(summary.punches ?? 0))} tone="good" foot={`${formatNumber(Number(summary.employees ?? 0))} موظف`} />}
            {kind === 'leaves' && <Stat label="إجازات ستُسجل" value={formatNumber(Number(summary.ok ?? 0))} tone="good" foot={`${formatNumber(Number(summary.days ?? 0))} يوم · ${formatNumber(Number(summary.hours ?? 0))} ساعة`} />}
            {kind === 'tasks' && <Stat label="مهام جديدة" value={formatNumber(Number(summary.tasks ?? 0))} tone="good" foot={`${formatNumber(Number(summary.punches ?? 0))} بصمة تطبيق`} />}
            <Stat label="موجودة مسبقاً" value={formatNumber(Number(summary.duplicate ?? 0))} />
            <Stat label="لن تُستورد" value={formatNumber(Number(summary.error ?? 0))} tone={Number(summary.error) ? 'bad' : undefined} foot={Number(summary.unmatched) ? `${formatNumber(Number(summary.unmatched))} برقم غير مربوط (تُحفظ وتُربط لاحقاً)` : Number(summary.skip) ? `${formatNumber(Number(summary.skip))} متجاهلة` : undefined} />
          </div>
          {Number(summary.pinsToSave) > 0 && <Warning title={`سيُحفظ رقم البصمة لـ ${formatNumber(Number(summary.pinsToSave))} موظف`}>طوبقوا بالاسم لأن رقمهم غير مسجل في النظام. راجع الأسطر المعلّمة قبل الاعتماد.</Warning>}
          <Tabs<'all' | RowStatus> value={filter} onChange={setFilter} items={[
            { id: 'all', label: 'الكل', badge: preview.rows.length },
            { id: 'ok', label: 'جاهزة', badge: counts('ok') },
            { id: 'unmatched', label: 'غير مربوطة', badge: counts('unmatched') },
            { id: 'duplicate', label: 'موجودة', badge: counts('duplicate') },
            { id: 'skip', label: 'متجاهلة', badge: counts('skip') },
            { id: 'error', label: 'أخطاء', badge: counts('error') },
          ]} />
          {rows.length ? <div className="table-scroll fp-rows"><table className="dense">
            <thead><tr><th>السطر</th><th>في الملف</th><th>الموظف</th><th>التاريخ</th><th>التفاصيل</th><th>النتيجة</th></tr></thead>
            <tbody>{rows.slice(0, 600).map((row) => <tr key={row.row}>
              <td>{row.row}</td>
              <td><span dir="ltr" className="code-tag">{row.pin || '—'}</span><small className="table-sub">{row.name}</small></td>
              <td>{row.employee ? <><strong>{row.employee.fullName}</strong><small className="table-sub" dir="ltr">{row.employee.employeeNo}</small></> : '—'}</td>
              <td dir="ltr">{row.date ?? '—'}</td>
              <td>{row.detail || '—'}</td>
              <td className="wrap"><Tone tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Tone>{row.note && <small className="table-sub">{row.note}</small>}{row.warnings.map((warning) => <small key={warning} className="table-sub fp-warning">{warning}</small>)}</td>
            </tr>)}</tbody>
          </table></div> : <Empty icon={<CheckCircle2 size={22} />} title="لا أسطر هنا" text="غيّر التصفية لرؤية بقية الأسطر." />}
          {preview.rowsShown < Number(summary.rows ?? 0) && <p className="muted">تُعرض أول {formatNumber(preview.rowsShown)} سطر؛ الاعتماد يشمل الملف كله.</p>}
        </>}
        <div className="dialog-actions">
          <button className="button button-primary" disabled={!importable || Boolean(busy) || Boolean(problem)} onClick={() => void apply()}>
            <CheckCircle2 size={16} />{busy === 'apply' ? 'جارٍ الاعتماد والاحتساب…' : 'اعتماد واستيراد'}</button>
          {busy === 'preview' && <span className="muted"><RefreshCw size={13} /> جارٍ التحديث…</span>}
          <button className="button button-quiet" onClick={onClose}>إلغاء</button>
        </div>
      </div>}
    </Dialog>
  );
}
