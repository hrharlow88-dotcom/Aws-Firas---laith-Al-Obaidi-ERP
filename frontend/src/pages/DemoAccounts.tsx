import { Bi, BiText } from '../components/Brand';
import { FormEvent, useState } from 'react';
import { Power, PowerOff, Presentation, Send, UserPlus } from 'lucide-react';
import { InviteDialog, InviteTarget } from '../components/InviteDialog';
import { Empty, Loading, Tone } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { useLoad, useSession } from '../lib/session';

interface DemoAccount {
  id: string; name: string; email: string; role: string; isActive: boolean; expiresAt: string | null; lastLoginAt: string | null;
  employeeName: string | null; logins: number;
}
interface DemoEmployee { id: string; employeeNo: string; fullName: string }
interface Invite { id: string; name: string; login: string; path: string; origin: string | null }
const ROLE: Record<string, string> = {
  hr_manager: 'ديمو أدمن (موارد بشرية) · Demo admin', employee: 'ديمو موظف (البوابة) · Demo employee', executive: 'إدارة عليا · Executive',
  finance: 'المالية · Finance', line_manager: 'مدير مباشر · Line manager', payroll_officer: 'مسؤول رواتب · Payroll',
};

/**
 * Demo guests, managed by the owner alone from the owner console: he invites a
 * guest by WhatsApp, SMS or e-mail, and switches the account off whenever he wants.
 * The guest opens the link and chooses the password; the account lives on the
 * demo copy with made-up data, and can never grant access to anyone.
 */
export function DemoAccounts() {
  const session = useSession();
  const data = useLoad<{ accounts: DemoAccount[]; employees: DemoEmployee[]; mode: 'local' | 'bridge' | 'off'; error?: string }>(
    '/owner/demo', { accounts: [], employees: [], mode: 'off' });
  const [role, setRole] = useState('hr_manager');
  const [invite, setInvite] = useState<InviteTarget | null>(null);
  const { accounts, employees, mode, error } = data.data;
  const ready = mode !== 'off' && !error;

  const target = (result: Invite): InviteTarget => ({
    name: result.name, login: result.login, kind: 'demo', url: `${result.origin ?? window.location.origin}${result.path}`,
  });
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const result = await session.call<{ data: Invite }>('/owner/demo', { method: 'POST', body: {
        name: form.get('name'), email: form.get('email'), role, employeeId: form.get('employeeId') || null,
        expiresAt: form.get('expiresAt') ? new Date(String(form.get('expiresAt'))).toISOString() : null,
      } });
      formElement.reset();
      data.reload();
      setInvite(target(result.data));
    } catch (failure) { session.fail(failure, 'تعذر إنشاء الدعوة.'); }
  }
  async function reinvite(account: DemoAccount) {
    try { setInvite(target((await session.call<{ data: Invite }>(`/owner/demo/${account.id}/invite`, { method: 'POST', body: {} })).data)); }
    catch (failure) { session.fail(failure, 'تعذر تجهيز الدعوة.'); }
  }
  async function patch(id: string, body: Record<string, unknown>, message: string) {
    try { await session.call(`/owner/demo/${id}`, { method: 'PATCH', body }); session.notify(message); data.reload(); }
    catch (failure) { session.fail(failure, 'تعذر التحديث.'); }
  }
  async function toggleAll(enabled: boolean) {
    try { const result = await session.call<{ data: { count: number } }>('/owner/demo-toggle', { method: 'POST', body: { enabled } }); session.notify(`${enabled ? 'فُعّل' : 'أُوقف'} ${result.data.count} حساب.`); data.reload(); }
    catch (failure) { session.fail(failure, 'تعذر التنفيذ.'); }
  }

  if (data.loading) return <Loading />;
  return (
    <div className="demo-admin">
      <div className="panel-head"><div><h3><Presentation size={18} /> <Bi ar={"دعوات تجربة النظام"} en={"Demo invitations"} /></h3>
        <p>لعرض النظام على أي شخص: أرسل له من هنا دعوة «ديمو أدمن» أو «ديمو موظف» عبر واتساب أو رسالة نصية أو بريد. الضيف يفتح الرابط ويختار كلمة مروره بنفسه، ويدخل على <b>نسخة العرض</b> ذات البيانات الوهمية فقط، فلا يرى أي اسم أو راتب حقيقي. أنت وحدك تدعو وتوقف وتحدد تاريخ الانتهاء، والضيف لا يمنح أي حساب أو صلاحية ولا يغيّر الإعدادات.</p></div>
        {ready && accounts.length > 0 && <div className="row-actions">
          <button className="button button-quiet" onClick={() => void toggleAll(true)}><Power size={14} />تفعيل الكل</button>
          <button className="button button-danger" onClick={() => void toggleAll(false)}><PowerOff size={14} />إيقاف الكل</button></div>}</div>
      {mode === 'off' && <div className="callout callout-warn"><Presentation size={17} /><div><strong>نسخة العرض غير مربوطة بعد</strong>
        <span>تُربط مرة واحدة على الخادم (مفتاح DEMO_BRIDGE_KEY). بعدها تُدار كل الدعوات من هنا.</span></div></div>}
      {error && <div className="callout callout-warn"><Presentation size={17} /><div><strong>تعذر الوصول إلى نسخة العرض</strong><span>{error}</span></div></div>}
      {ready && <form className="form-grid demo-form" onSubmit={(event) => void create(event)}>
        <label className="field"><span>نوع الحساب</span><select value={role} onChange={(event) => setRole(event.target.value)}>{Object.entries(ROLE).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="field"><span>اسم الضيف</span><input name="name" required maxLength={120} /></label>
        <label className="field"><span>بريده (اسم الدخول)</span><input name="email" type="email" required dir="ltr" placeholder="guest@example.com" /></label>
        <label className="field"><span>ينتهي في (اختياري)</span><input name="expiresAt" type="datetime-local" /></label>
        {role === 'employee' && <label className="field"><span>الموظف الوهمي الذي يمثله</span>
          <select name="employeeId" required defaultValue=""><option value="" disabled>— اختر —</option>
            {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeNo} · {employee.fullName}</option>)}</select></label>}
        <div className="dialog-actions settings-wide"><button className="button button-primary"><UserPlus size={15} />إنشاء وإرسال الدعوة</button></div>
      </form>}
      {!accounts.length ? <Empty icon={<Presentation size={22} />} title="لا توجد دعوات بعد" text="—" />
        : <div className="table-scroll"><table className="dense"><thead><tr><th>الضيف</th><th>النوع</th><th>الحالة</th><th>ينتهي</th><th>آخر دخول</th><th /></tr></thead>
          <tbody>{accounts.map((account) => <tr key={account.id}>
            <td><strong>{account.name}</strong><small className="table-sub" dir="ltr">{account.email}</small>{account.employeeName && <small className="table-sub">{account.employeeName}</small>}</td>
            <td><BiText text={ROLE[account.role] ?? account.role} /></td>
            <td>{!account.isActive ? <Tone tone="muted">موقوف</Tone> : account.lastLoginAt ? <Tone tone="good">مفعّل</Tone> : <Tone tone="warn">بانتظار قبول الدعوة</Tone>}</td>
            <td>{account.expiresAt ? formatDateTime(account.expiresAt) : 'بلا انتهاء'}</td>
            <td>{account.lastLoginAt ? formatDateTime(account.lastLoginAt) : '—'}<small className="table-sub">{account.logins} دخول</small></td>
            <td className="row-actions">
              {account.isActive
                ? <>{ready && <button className="button button-quiet button-small" onClick={() => void reinvite(account)}><Send size={13} />إعادة الدعوة</button>}
                  <button className="button button-danger button-small" onClick={() => void patch(account.id, { isActive: false }, 'أُوقف الحساب وأُنهيت جلساته.')}><PowerOff size={13} />إيقاف</button></>
                : ready && <button className="button button-quiet button-small" onClick={() => void patch(account.id, { isActive: true }, 'فُعّل الحساب.')}><Power size={13} />تفعيل</button>}
            </td>
          </tr>)}</tbody></table></div>}
      <InviteDialog target={invite} onClose={() => setInvite(null)} />
    </div>
  );
}
