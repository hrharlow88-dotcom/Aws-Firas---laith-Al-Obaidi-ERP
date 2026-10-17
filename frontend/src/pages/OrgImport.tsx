import { useState } from 'react';
import { CheckCircle2, Download, FileSpreadsheet, Upload } from 'lucide-react';
import { Empty, Stat, Tabs, Tone, Warning } from '../components/ui';
import { downloadFile } from '../lib/api';
import { formatNumber } from '../lib/format';
import { useSession } from '../lib/session';

interface Row {
  row: number; employeeNo: string; fullName: string | null; errors: string[]; warnings: string[];
  changes: Array<{ field: 'manager' | 'department' | 'position' | 'branch'; from: string | null; to: string | null }>;
}
interface Preview {
  rows: Row[]; newJobTitles: string[];
  summary: { rows: number; changed: number; unchanged: number; errors: number; managerChanges: number };
}

const FIELD: Record<Row['changes'][number]['field'], string> = {
  manager: 'المدير المباشر', department: 'القسم', position: 'المسمى', branch: 'الفرع',
};

/**
 * Bulk update of reporting lines and structure: download today's structure,
 * edit it in Excel, upload, review every change, then apply.
 */
export function OrgImport({ onApplied }: { onApplied: () => void }) {
  const session = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState<'changes' | 'errors' | 'all'>('changes');

  async function check(selected: File) {
    setFile(selected);
    setPreview(null);
    setBusy('preview');
    const form = new FormData();
    form.append('file', selected);
    try {
      const result = await session.call<{ data: Preview }>('/org/import/preview', { form });
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
      const result = await session.call<{ data: { updated: number } }>('/org/import/apply', { form });
      session.notify(`حُدّث ${formatNumber(result.data.updated)} موظف. التغييرات مسجلة في سجل التدقيق.`);
      setPreview(null);
      setFile(null);
      onApplied();
    } catch (error) {
      session.fail(error, 'تعذر الاعتماد.');
    } finally {
      setBusy('');
    }
  }

  const rows = preview?.rows.filter((row) => (filter === 'all' ? true : filter === 'errors' ? row.errors.length : row.changes.length && !row.errors.length)) ?? [];
  return (
    <section className="panel">
      <div className="panel-head">
        <div><h3>استيراد خطوط الإشراف والهيكل من Excel</h3><p>نزّل الهيكل الحالي، عدّل المدير المباشر والقسم والمسمى والفرع، ثم ارفعه. لا يُحفظ شيء قبل المعاينة والاعتماد.</p></div>
        <div className="heading-actions">
          <button className="button button-quiet" onClick={() => void downloadFile('/org/import/template.xlsx', session.token, 'org-structure.xlsx').catch((error) => session.fail(error, 'تعذر التنزيل.'))}><Download size={15} />تنزيل الهيكل الحالي</button>
          <label className="button button-primary file-button"><Upload size={15} />{busy === 'preview' ? 'جارٍ الفحص…' : 'رفع الملف المعدّل'}<input type="file" accept=".xlsx" hidden onChange={(event) => { const selected = event.target.files?.[0]; if (selected) void check(selected); event.target.value = ''; }} /></label>
        </div>
      </div>
      {!preview ? <Empty icon={<FileSpreadsheet size={22} />} title="ارفع ملف الهيكل" text="الملف يُقرأ ويُعرض كل تغيير وكل خطأ قبل الحفظ." /> : <>
        <div className="panel-pad">
          <div className="stat-row">
            <Stat label="أسطر الملف" value={formatNumber(preview.summary.rows)} />
            <Stat label="موظفون سيتغيرون" value={formatNumber(preview.summary.changed)} foot={`${formatNumber(preview.summary.managerChanges)} تغيير مدير مباشر`} />
            <Stat label="بلا تغيير" value={formatNumber(preview.summary.unchanged)} />
            <Stat label="أسطر بأخطاء" value={formatNumber(preview.summary.errors)} tone={preview.summary.errors ? 'bad' : undefined} />
          </div>
          {preview.newJobTitles.length > 0 && <Warning title="مسميات جديدة ستُضاف">{preview.newJobTitles.join('، ')}</Warning>}
          {preview.summary.errors > 0 && <Warning title="صحح الأخطاء ثم ارفع الملف من جديد">لا يُحفظ أي سطر ما دام في الملف خطأ واحد.</Warning>}
        </div>
        <div className="panel-pad"><Tabs<'changes' | 'errors' | 'all'> value={filter} onChange={setFilter} items={[
          { id: 'changes', label: 'التغييرات', badge: preview.summary.changed },
          { id: 'errors', label: 'الأخطاء', badge: preview.summary.errors },
          { id: 'all', label: 'كل الأسطر', badge: preview.summary.rows },
        ]} /></div>
        <div className="table-scroll"><table className="dense">
          <thead><tr><th>السطر</th><th>الموظف</th><th>التغيير</th><th>ملاحظات</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.row}>
            <td>{row.row}</td>
            <td><strong>{row.fullName ?? '—'}</strong><small className="table-sub">{row.employeeNo}</small></td>
            <td>{row.changes.length ? row.changes.map((change) => <div key={change.field} className="change-line"><b>{FIELD[change.field]}:</b> <span className="muted">{change.from ?? '—'}</span> ← <strong>{change.to ?? 'بدون'}</strong></div>) : <span className="muted">بلا تغيير</span>}</td>
            <td className="wrap">{row.errors.map((error) => <div key={error}><Tone tone="bad">{error}</Tone></div>)}{row.warnings.map((warning) => <div key={warning}><Tone tone="warn">{warning}</Tone></div>)}</td>
          </tr>)}</tbody>
        </table></div>
        <div className="dialog-actions panel-pad">
          <button className="button button-primary" disabled={Boolean(preview.summary.errors) || !preview.summary.changed || busy === 'apply'} onClick={() => void apply()}><CheckCircle2 size={16} />{busy === 'apply' ? 'جارٍ الاعتماد…' : `اعتماد التغييرات (${formatNumber(preview.summary.changed)})`}</button>
          <button className="button button-quiet" onClick={() => { setPreview(null); setFile(null); }}>إلغاء</button>
        </div>
      </>}
    </section>
  );
}
