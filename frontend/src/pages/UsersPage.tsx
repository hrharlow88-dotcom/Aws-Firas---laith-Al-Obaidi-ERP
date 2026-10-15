import { FormEvent, useState } from 'react';
import { KeyRound, LockOpen, Pencil, Plus, ShieldCheck, UserRoundCog } from 'lucide-react';
import { Dialog, Empty, Loading, Tone } from '../components/ui';
import { EmployeePicker, PickedEmployee } from '../components/EmployeePicker';
import { formatDateTime } from '../lib/format';
import { useLoad, useSession } from '../lib/session';
import type { UserRole } from '../SettingsPage';

interface Account {
  id: string; name: string; email: string; role: UserRole; branchId: string | null; employeeId: string | null;
  isActive: boolean; lockedUntil: string | null; lastLoginAt: string | null;
  employee: { employeeNo: string; fullName: string } | null;
}

/** What each role sees, shown next to the role picker so nobody guesses. */
const SCOPE_HINT: Partial<Record<UserRole, string>> = {
  employee: 'يرى ملفه وقسائم راتبه وإجازاته فقط. يلزم ربطه بملف الموظف.',
  line_manager: 'يرى نفسه وفريقه (المرتبطين به مباشرة أو عبر مدرائهم) ويعتمد إجازاتهم. يلزم ربطه بملف الموظف.',
  branch_manager: 'يرى موظفي فرعه فقط. يلزم اختيار الفرع.',
  auditor: 'قراءة فقط لكل البيانات بما فيها الرواتب وسجل التدقيق، بلا أي تعديل.',
  it_admin: 'يدير الحسابات والربط التقني ولا يرى الرواتب ولا الملفات الشخصية.',
  payroll_officer: 'يعد المسيرات ويحتسبها؛ الاعتماد لدور آخر.',
};

export function UsersPage({ roleNames, branches }: { roleNames: Record<UserRole, string>; branches: Array<{ id: string; name: string }> }) {
  const session = useSession();
  const users = useLoad<Account[]>('/users', []);
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [role, setRole] = useState<UserRole>('employee');
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [busy, setBusy] = useState(false);
  const current = editing && editing !== 'new' ? editing : null;
  const isAdmin = session.user.role === 'super_admin';
  const grantable = (Object.keys(roleNames) as UserRole[]).filter((item) => isAdmin || item !== 'super_admin');

  function open(target: Account | 'new') {
    setEditing(target);
    setRole(target === 'new' ? 'employee' : target.role);
    setEmployee(target !== 'new' && target.employeeId && target.employee
      ? { id: target.employeeId, fullName: target.employee.fullName, employeeNo: target.employee.employeeNo }
      : null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    setBusy(true);
    try {
      if (current) {
        await session.call(`/users/${current.id}`, {
          method: 'PUT',
          body: { name: text('name'), role, branchId: text('branchId') || null, employeeId: employee?.id ?? null },
        });
        session.notify('حُدّث الحساب. إذا تغيّر الدور أو الربط يُطلب من المستخدم الدخول من جديد.');
      } else {
        await session.call('/users', {
          body: {
            name: text('name'), email: text('email'), password: text('password'), role,
            branchId: text('branchId') || undefined, employeeId: employee?.id,
          },
        });
        session.notify('أُنشئ الحساب. أبلغ صاحبه بكلمة المرور المؤقتة بطريقة آمنة.');
      }
      setEditing(null);
      users.reload();
    } catch (error) {
      session.fail(error, 'تعذر حفظ الحساب.');
    } finally {
      setBusy(false);
    }
  }

  async function patch(account: Account, body: Record<string, unknown>, message: string) {
    try {
      await session.call(`/users/${account.id}`, { method: 'PUT', body });
      session.notify(message);
      users.reload();
    } catch (error) {
      session.fail(error, 'تعذر التحديث.');
    }
  }

  const needsEmployee = role === 'employee' || role === 'line_manager';
  return (
    <section className="screen">
      <div className="screen-heading">
        <div><h2>المستخدمون والصلاحيات</h2><p>لكل شخص حسابه، وأقل صلاحية يحتاجها. الصلاحيات ونطاق البيانات تُفحص في الخادم مع كل طلب.</p></div>
        <div className="heading-actions"><button className="button button-primary" onClick={() => open('new')}><Plus size={16} />حساب جديد</button></div>
      </div>
      <div className="permission-note"><ShieldCheck size={18} /><div><strong>نطاق البيانات حسب الدور</strong><span>الموظف يرى نفسه، المدير المباشر فريقه، مدير الفرع فرعه، والأدوار المركزية كل الشركة. خمس محاولات دخول خاطئة تقفل الحساب 15 دقيقة.</span></div></div>
      <section className="panel">
        {users.loading ? <Loading /> : users.data.length ? <div className="table-scroll"><table>
          <thead><tr><th>المستخدم</th><th>الدور</th><th>مرتبط بـ</th><th>آخر دخول</th><th>الحالة</th><th /></tr></thead>
          <tbody>{users.data.map((account) => {
            const locked = Boolean(account.lockedUntil);
            return <tr key={account.id}>
              <td><span className="person-cell"><span className="person-mark">{account.name.slice(0, 1)}</span><span><strong>{account.name}</strong><small dir="ltr">{account.email}</small></span></span></td>
              <td><span className="role-tag">{roleNames[account.role] ?? account.role}</span></td>
              <td>{account.employee ? <><strong>{account.employee.fullName}</strong><small className="table-sub">{account.employee.employeeNo}</small></>
                : account.branchId ? branches.find((branch) => branch.id === account.branchId)?.name ?? '—' : 'كل الشركة'}</td>
              <td>{account.lastLoginAt ? formatDateTime(account.lastLoginAt) : 'لم يدخل بعد'}</td>
              <td>{!account.isActive ? <Tone tone="muted">معطل</Tone> : locked ? <Tone tone="bad">مقفل مؤقتاً</Tone> : <Tone tone="good">نشط</Tone>}</td>
              <td className="row-actions">
                {locked && <button className="text-button" onClick={() => void patch(account, { unlock: true }, 'فُتح الحساب.')}><LockOpen size={14} />فتح القفل</button>}
                <button className="icon-link" aria-label="تعديل" onClick={() => open(account)}><Pencil size={14} /></button>
                {account.id !== session.user.id && <button className="text-button" onClick={() => void patch(account, { isActive: !account.isActive }, account.isActive ? 'عُطّل الحساب.' : 'فُعّل الحساب.')}>{account.isActive ? 'تعطيل' : 'تفعيل'}</button>}
              </td>
            </tr>;
          })}</tbody>
        </table></div> : <Empty icon={<UserRoundCog size={22} />} title="لا توجد حسابات" text="أضف حساباً لكل مستخدم بدل مشاركة حساب المدير." />}
      </section>

      <Dialog open={editing !== null} title={current ? 'تعديل الحساب' : 'حساب جديد'} subtitle={current?.email} onClose={() => setEditing(null)}>
        <form onSubmit={save} key={current?.id ?? 'new'}>
          <div className="form-grid form-grid-2">
            <label className="field"><span>الاسم *</span><input name="name" required maxLength={120} defaultValue={current?.name ?? employee?.fullName ?? ''} /></label>
            {!current && <label className="field"><span>البريد الإلكتروني *</span><input name="email" type="email" required maxLength={254} dir="ltr" /></label>}
            <label className="field"><span>الدور *</span><select value={role} onChange={(event) => setRole(event.target.value as UserRole)}>{grantable.map((item) => <option key={item} value={item}>{roleNames[item]}</option>)}</select></label>
            {role === 'branch_manager' && <label className="field"><span>الفرع *</span><select name="branchId" required defaultValue={current?.branchId ?? ''}><option value="">اختر</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}
            <div className="field settings-wide"><EmployeePicker label={needsEmployee ? 'ملف الموظف *' : 'ملف الموظف (اختياري: لخدمته الذاتية)'} value={employee} onChange={setEmployee} /></div>
            {!current && <label className="field"><span>كلمة المرور المؤقتة *</span><input name="password" type="password" minLength={12} required autoComplete="new-password" dir="ltr" /><small>12 محرفاً على الأقل.</small></label>}
          </div>
          {SCOPE_HINT[role] && <p className="hint"><KeyRound size={13} /> {SCOPE_HINT[role]}</p>}
          <div className="dialog-actions"><button className="button button-primary" disabled={busy || (needsEmployee && !employee)}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</button><button type="button" className="button button-quiet" onClick={() => setEditing(null)}>إلغاء</button></div>
        </form>
      </Dialog>
    </section>
  );
}
