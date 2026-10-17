import { FormEvent, useState } from 'react';
import { FileSpreadsheet, Upload } from 'lucide-react';
import { Warning } from '../components/ui';
import { useSession } from '../lib/session';

/**
 * Loads the company's own HR workbooks (branch payroll files, the employee
 * register and the leave system) into this server. System administrator only.
 * Running it again updates employees by code; existing loans are kept.
 */
export function CompanyImportPage() {
  const session = useSession();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!files.length) return;
    if (!window.confirm(`استيراد ${files.length} ملف إلى قاعدة البيانات؟ الموظفون يُحدّثون حسب الرقم الوظيفي.`)) return;
    const form = new FormData();
    files.forEach((file) => form.append('files', file));
    setBusy(true);
    try {
      const result = await session.call<{ data: { lines: string[] } }>('/admin/company-import', { method: 'POST', form });
      setLines(result.data.lines);
      session.notify('اكتمل استيراد بيانات الشركة.');
    } catch (error) {
      session.fail(error, 'تعذر الاستيراد.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="screen">
      <div className="screen-heading">
        <div>
          <h2>استيراد بيانات الشركة</h2>
          <p>ملفات رواتب الفروع (01 Employee Data … 04 Payroll)، والسجل الرئيسي للموظفين، وملف نظام الإجازات. تُقرأ الملفات ولا تُحفظ على السيرفر.</p>
        </div>
      </div>
      <Warning title="قبل الاستيراد">كل ملفات الرواتب لنفس الشهر. الإعادة تحدّث بيانات الموظفين ولا تكررها، ولا تغيّر السلف المسجلة مسبقاً.</Warning>
      <form className="panel" onSubmit={(event) => void submit(event)}>
        <div className="panel-head"><div><h3>الملفات</h3><p>{files.length ? `${files.length} ملف مختار` : 'اختر ملفات xlsx'}</p></div>
          <button className="button button-primary" disabled={busy || !files.length}><Upload size={16} />{busy ? 'جارٍ الاستيراد…' : 'استيراد'}</button></div>
        <label className="field"><span>ملفات الإكسل</span>
          <input type="file" multiple accept=".xlsx" onChange={(event) => setFiles([...(event.target.files ?? [])])} /></label>
        {files.length > 0 && <ul className="plain-list">{files.map((file) => <li key={file.name}><FileSpreadsheet size={14} /> {file.name}</li>)}</ul>}
      </form>
      {lines.length > 0 && <section className="panel"><div className="panel-head"><div><h3>النتيجة</h3></div></div>
        <pre className="import-log" dir="auto">{lines.join('\n')}</pre></section>}
    </section>
  );
}
