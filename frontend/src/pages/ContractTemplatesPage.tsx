import { FormEvent, useState } from 'react';
import { Copy, Download, FileSignature, Upload } from 'lucide-react';
import { Dialog, Empty, Loading, Tone } from '../components/ui';
import { downloadFile } from '../lib/api';
import { EMPLOYMENT_TYPES, formatDate, formatNumber } from '../lib/format';
import { useLoad, useSession } from '../lib/session';

interface Template {
  id: string; name: string; contractType: string | null; description: string | null; originalName: string;
  fields: string[]; isActive: boolean; createdAt: string; uploadedByName: string; usedCount: number;
}
interface Field { key: string; alias: string; label: string }

/**
 * Word templates for contracts. HR writes {{field}} at each blank; the
 * employee file fills them when a contract is generated.
 */
export function ContractTemplatesPage() {
  const session = useSession();
  const templates = useLoad<Template[]>('/contracts/templates', []);
  const fields = useLoad<Field[]>('/contracts/fields', []);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = (key: string) => fields.data.find((field) => field.key === key)?.label ?? key;

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await session.call<{ data: { fields: string[] } }>('/contracts/templates', { form: new FormData(event.currentTarget) });
      session.notify(`رُفع القالب، وفيه ${result.data.fields.length} حقل.`);
      setUploading(false);
      templates.reload();
    } catch (error) {
      session.fail(error, 'تعذر رفع القالب.');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(template: Template) {
    try {
      await session.call(`/contracts/templates/${template.id}`, { method: 'PATCH', body: { isActive: !template.isActive } });
      templates.reload();
    } catch (error) {
      session.fail(error, 'تعذر التحديث.');
    }
  }

  function copy(text: string) {
    void navigator.clipboard?.writeText(text).then(() => session.notify(`نُسخ ${text}`));
  }

  return (
    <section className="screen">
      <div className="screen-heading">
        <div><h2>قوالب العقود</h2><p>ملف Word فيه حقول مثل <code dir="ltr">{'{{اسم_الموظف}}'}</code> في أماكن الفراغات. من ملف الموظف ← العقود تُنشئ العقد معبأً ببياناته وراتبه.</p></div>
        <div className="heading-actions"><button className="button button-primary" onClick={() => setUploading(true)}><Upload size={16} />رفع قالب</button></div>
      </div>
      <div className="split-grid">
        <section className="panel">
          <div className="panel-head"><div><h3>القوالب</h3><p>القالب الموقوف لا يظهر عند إنشاء العقود، والعقود السابقة تبقى كما هي.</p></div></div>
          {templates.loading ? <Loading /> : templates.data.length ? <div className="template-list">
            {templates.data.map((template) => <article key={template.id} className={`template-card ${template.isActive ? '' : 'is-off'}`}>
              <span className="template-icon"><FileSignature size={22} /></span>
              <div className="template-body">
                <div className="template-title"><strong>{template.name}</strong>{template.contractType && <Tone tone="info">{EMPLOYMENT_TYPES[template.contractType] ?? template.contractType}</Tone>}{!template.isActive && <Tone tone="muted">موقوف</Tone>}</div>
                <small>{template.originalName} · رفعه {template.uploadedByName} في {formatDate(template.createdAt)} · استُخدم {formatNumber(template.usedCount)} مرة</small>
                <div className="chips">{template.fields.map((key) => <span key={key} className="chip">{label(key)}</span>)}</div>
              </div>
              <div className="template-actions">
                <button className="icon-link" aria-label="تنزيل القالب" onClick={() => void downloadFile(`/contracts/templates/${template.id}/file`, session.token, template.originalName).catch((error) => session.fail(error, 'تعذر التنزيل.'))}><Download size={15} /></button>
                <button className="text-button" onClick={() => void toggle(template)}>{template.isActive ? 'إيقاف' : 'تفعيل'}</button>
              </div>
            </article>)}
          </div> : <Empty icon={<FileSignature size={22} />} title="لا توجد قوالب" text="ارفع قالب عقد الشركة بعد وضع الحقول في أماكن الفراغات." action="رفع قالب" onAction={() => setUploading(true)} />}
        </section>
        <section className="panel">
          <div className="panel-head"><div><h3>الحقول المتاحة</h3><p>اكتب الحقل في Word كما هو، بالعربي أو الإنكليزي. اضغط للنسخ.</p></div></div>
          {fields.loading ? <Loading /> : <ul className="field-list">{fields.data.map((field) => <li key={field.key}>
            <span>{field.label}</span>
            <span className="field-codes">
              <button className="code-chip code-ar" onClick={() => copy(`{{${field.alias}}}`)}>{`{{${field.alias}}}`}<Copy size={12} /></button>
              <button className="code-chip" dir="ltr" onClick={() => copy(`{{${field.key}}}`)}>{`{{${field.key}}}`}<Copy size={12} /></button>
            </span>
          </li>)}</ul>}
        </section>
      </div>
      <Dialog open={uploading} title="رفع قالب عقد" subtitle="ملف Word بصيغة .docx. يُرفض الملف إذا احتوى حقلاً غير معروف، حتى لا يخرج عقد فيه فراغ." onClose={() => setUploading(false)}>
        <form onSubmit={upload}>
          <div className="form-grid form-grid-2">
            <label className="field settings-wide"><span>اسم القالب *</span><input name="name" required maxLength={120} placeholder="عقد عمل - عراقي (عربي/إنكليزي)" /></label>
            <label className="field"><span>نوع العقد</span><select name="contractType" defaultValue="fixed_term"><option value="">—</option>{Object.entries(EMPLOYMENT_TYPES).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
            <label className="field"><span>ملف Word *</span><input name="file" type="file" required accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" /></label>
            <label className="field settings-wide"><span>وصف</span><input name="description" maxLength={500} /></label>
          </div>
          <div className="dialog-actions"><button className="button button-primary" disabled={busy}>{busy ? 'جارٍ الرفع…' : 'رفع'}</button><button type="button" className="button button-quiet" onClick={() => setUploading(false)}>إلغاء</button></div>
        </form>
      </Dialog>
    </section>
  );
}
