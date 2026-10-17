import { FormEvent, useState } from 'react';
import { Bell, MapPinned } from 'lucide-react';
import { Tone } from '../components/ui';
import { useSession } from '../lib/session';
import { useGovernorates } from './PayrollRegisterPage';

/** The governorates (Baghdad, Mosul, Erbil) and which branches belong to each; each governorate has its own payroll file. */
export function GovernorateBranches({ branches }: { branches: Array<{ id: string; name: string; city: string }> }) {
  const session = useSession();
  const data = useGovernorates();
  const canManage = session.can('branches.manage');
  const governorateOf = (branchId: string) => data.data.governorates.find((item) => item.branches.some((branch) => branch.id === branchId))?.id ?? '';
  async function move(branchId: string, governorateId: string) {
    try { await session.call(`/branches/${branchId}`, { method: 'PUT', body: { governorateId: governorateId || null } }); data.reload(); }
    catch (error) { session.fail(error, 'تعذر الربط.'); }
  }
  return (
    <section className="panel">
      <div className="panel-head"><div><h3><MapPinned size={17} /> المحافظات وفروعها · Governorates</h3><p>لكل محافظة فروعها وملف رواتبها الخاص.</p></div></div>
      <div className="governorate-grid">{data.data.governorates.map((item) => <article key={item.id} className="governorate-card">
        <strong>{item.nameAr}</strong><small dir="ltr">{item.nameEn}</small>
        <span>{item.branches.length} فرع · {item.branches.reduce((sum, branch) => sum + Number(branch.employees), 0)} موظف</span>
        <ul>{item.branches.map((branch) => <li key={branch.id}>{branch.name}</li>)}</ul>
      </article>)}</div>
      {canManage && <div className="table-scroll"><table className="dense"><thead><tr><th>الفرع</th><th>المدينة</th><th>المحافظة</th></tr></thead>
        <tbody>{branches.map((branch) => <tr key={branch.id}><td>{branch.name}</td><td>{branch.city}</td>
          <td><select value={governorateOf(branch.id)} onChange={(event) => void move(branch.id, event.target.value)}>
            <option value="">— بلا محافظة —</option>{data.data.governorates.map((item) => <option key={item.id} value={item.id}>{item.nameAr}</option>)}</select></td></tr>)}</tbody></table></div>}
    </section>
  );
}

/** Copies of notifications and approval requests by e-mail, to the work address or a personal one. */
export function NotificationPreferences() {
  const session = useSession();
  const [saved, setSaved] = useState<{ notifyEmail: boolean; personalEmail: string } | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = { notifyEmail: form.get('notifyEmail') === 'on', personalEmail: String(form.get('personalEmail') || '').trim() || null };
    try { await session.call('/users/me/notifications', { method: 'PUT', body }); setSaved({ notifyEmail: body.notifyEmail, personalEmail: body.personalEmail ?? '' }); session.notify('حُفظت تفضيلات الإشعارات.'); }
    catch (error) { session.fail(error, 'تعذر الحفظ.'); }
  }
  return (
    <form className="panel" onSubmit={(event) => void save(event)}>
      <div className="panel-head"><div><h3><Bell size={17} /> الإشعارات بالبريد · E-mail notifications</h3>
        <p>تصلك نسخة من كل إشعار وطلب موافقة وسير عمل على بريدك، برسالة باللغتين العربية والإنكليزية فيها رابط الدخول. تعمل حين يفعّل مالك النظام قناة البريد.</p></div>
        {saved && <Tone tone={saved.notifyEmail ? 'good' : 'muted'}>{saved.notifyEmail ? 'مفعّلة' : 'متوقفة'}</Tone>}</div>
      <div className="form-grid">
        <label className="settings-check"><input type="checkbox" name="notifyEmail" defaultChecked={(session.user as { notifyEmail?: boolean }).notifyEmail} />أرسل لي الإشعارات والموافقات بالبريد</label>
        <label className="field"><span>بريدي الشخصي (اختياري، وإلا بريد العمل {session.user.email})</span><input name="personalEmail" type="email" dir="ltr" maxLength={254} placeholder="name@gmail.com" /></label>
      </div>
      <div className="form-actions"><button className="button button-primary">حفظ</button></div>
    </form>
  );
}
