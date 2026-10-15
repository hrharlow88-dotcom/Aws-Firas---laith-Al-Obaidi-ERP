import { FormEvent, useState } from 'react';
import { Power, PowerOff, Presentation, UserPlus } from 'lucide-react';
import { EmployeePicker, PickedEmployee } from '../components/EmployeePicker';
import { Empty, Loading, Tone } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { useLoad, useSession } from '../lib/session';

interface DemoAccount {
  id: string; name: string; email: string; role: string; isActive: boolean; expiresAt: string | null; lastLoginAt: string | null;
  employeeName: string | null; logins: number;
}
const ROLE: Record<string, string> = {
  employee: 'موظف (البوابة) · Employee', hr_manager: 'مدير موارد بشرية (ديمو أدمن) · HR admin', executive: 'إدارة عليا · Executive',
  finance: 'المالية · Finance', line_manager: 'مدير مباشر · Line manager', payroll_officer: 'مسؤول رواتب · Payroll',
};

/** Demo accounts on the demo copy: the owner creates them, sets their password, and switches them on or off. */
export function DemoAccounts() {
  const session = useSession();
  const data = useLoad<{ accounts: DemoAccount[]; demoInstance: boolean }>('/owner/demo', { accounts: [], demoInstance: false });
  const [role, setRole] = useState('hr_manager');
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const { accounts, demoInstance } = data.data;

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await session.call('/owner/demo', { method: 'POST', body: {
        name: form.get('name'), email: form.get('email'), password: form.get('password'), role, employeeId: employee?.id ?? null,
        expiresAt: form.get('expiresAt') ? new Date(String(form.get('expiresAt'))).toISOString() : null,
      } });
      formElement.reset(); setEmployee(null);
      session.notify('أُنشئ الحساب التجريبي.');
      data.reload();
    } catch (error) { session.fail(error, 'تعذر الإنشاء.'); }
  }
  async function patch(id: string, body: Record<string, unknown>, message: string) {
    try { await session.call(`/owner/demo/${id}`, { method: 'PATCH', body }); session.notify(message); data.reload(); }
    catch (error) { session.fail(error, 'تعذر التحديث.'); }
  }
  async function toggleAll(enabled: boolean) {
    try { const result = await session.call<{ data: { count: number } }>('/owner/demo-toggle', { method: 'POST', body: { enabled } }); session.notify(`${enabled ? 'فُعّل' : 'أُوقف'} ${result.data.count} حساب.`); data.reload(); }
    catch (error) { session.fail(error, 'تعذر التنفيذ.'); }
  }

  if (data.loading) return <Loading />;
  return (
    <div className="demo-admin">
      <div className="panel-head"><div><h3><Presentation size={18} /> الحسابات التجريبية للعرض · Demo accounts</h3>
        <p>لعرض النظام على أي شخص: حساب «ديمو أدمن» أو «ديمو موظف» ببريد وكلمة مرور تحددهما أنت، تفعّله وتوقفه متى شئت، وتحدد له تاريخ انتهاء. الحسابات التجريبية تعمل على <b>نسخة العرض التجريبية</b> ذات البيانات الوهمية فقط، فلا يرى الضيف أي اسم أو راتب حقيقي، ولا يستطيع تغيير كلمة المرور.</p></div>
        {demoInstance && accounts.length > 0 && <div className="row-actions">
          <button className="button button-quiet" onClick={() => void toggleAll(true)}><Power size={14} />تفعيل الكل</button>
          <button className="button button-danger" onClick={() => void toggleAll(false)}><PowerOff size={14} />إيقاف الكل</button></div>}</div>
      {!demoInstance && <div className="callout callout-warn"><Presentation size={17} /><div><strong>هذه هي النسخة الحقيقية</strong>
        <span>أنشئ الحسابات التجريبية من لوحة المالك في نسخة العرض التجريبية (رابطها عند مدير النظام). هنا يمكنك فقط إيقاف أي حساب تجريبي.</span></div></div>}
      {demoInstance && <form className="form-grid demo-form" onSubmit={(event) => void create(event)}>
        <label className="field"><span>نوع الحساب</span><select value={role} onChange={(event) => setRole(event.target.value)}>{Object.entries(ROLE).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="field"><span>الاسم الظاهر</span><input name="name" required maxLength={120} defaultValue={role === 'employee' ? 'موظف تجريبي' : 'مدير تجريبي'} /></label>
        <label className="field"><span>البريد للدخول</span><input name="email" type="email" required dir="ltr" placeholder="demo.admin@alobaidi-cars.com" /></label>
        <label className="field"><span>كلمة المرور (12 محرفاً على الأقل)</span><input name="password" type="password" required minLength={12} maxLength={72} autoComplete="new-password" dir="ltr" /></label>
        <label className="field"><span>ينتهي في (اختياري)</span><input name="expiresAt" type="datetime-local" /></label>
        {role === 'employee' && <div className="settings-wide"><EmployeePicker label="الموظف الوهمي الذي يمثله" value={employee} onChange={setEmployee} /></div>}
        <div className="dialog-actions settings-wide"><button className="button button-primary"><UserPlus size={15} />إنشاء الحساب التجريبي</button></div>
      </form>}
      {!accounts.length ? <Empty icon={<Presentation size={22} />} title="لا توجد حسابات تجريبية" text="—" />
        : <div className="table-scroll"><table className="dense"><thead><tr><th>الحساب</th><th>النوع</th><th>الحالة</th><th>ينتهي</th><th>آخر دخول</th><th /></tr></thead>
          <tbody>{accounts.map((account) => <tr key={account.id}>
            <td><strong>{account.name}</strong><small className="table-sub" dir="ltr">{account.email}</small>{account.employeeName && <small className="table-sub">{account.employeeName}</small>}</td>
            <td>{ROLE[account.role] ?? account.role}</td>
            <td>{account.isActive ? <Tone tone="good">مفعّل</Tone> : <Tone tone="muted">موقوف</Tone>}</td>
            <td>{account.expiresAt ? formatDateTime(account.expiresAt) : 'بلا انتهاء'}</td>
            <td>{account.lastLoginAt ? formatDateTime(account.lastLoginAt) : '—'}<small className="table-sub">{account.logins} دخول</small></td>
            <td className="row-actions">
              {account.isActive
                ? <button className="button button-danger button-small" onClick={() => void patch(account.id, { isActive: false }, 'أُوقف الحساب وأُنهيت جلساته.')}><PowerOff size={13} />إيقاف</button>
                : demoInstance && <button className="button button-quiet button-small" onClick={() => void patch(account.id, { isActive: true }, 'فُعّل الحساب.')}><Power size={13} />تفعيل</button>}
              {demoInstance && <button className="button button-quiet button-small" onClick={() => {
                const value = window.prompt('كلمة مرور جديدة للحساب التجريبي (12 محرفاً على الأقل):');
                if (value) void patch(account.id, { password: value }, 'تغيّرت كلمة المرور وأُنهيت الجلسات.');
              }}>كلمة مرور</button>}
            </td>
          </tr>)}</tbody></table></div>}
    </div>
  );
}
