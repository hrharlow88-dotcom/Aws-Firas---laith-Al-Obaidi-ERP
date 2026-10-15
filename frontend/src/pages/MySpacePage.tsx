import { FormEvent, useState } from 'react';
import {
  CalendarClock, CalendarDays, Clock3, FileText, Fingerprint, HandCoins, IdCard, MessageSquare, Paperclip, Receipt, Send, Wallet, X,
} from 'lucide-react';
import { Bi } from '../components/Brand';
import { EmployeePhoto } from '../components/EmployeePhoto';
import { Dialog, Empty, Loading, Stat, StatusTag, Tabs, Tone } from '../components/ui';
import { DAY_STATUS, EMPLOYMENT_TYPES, currentPeriod, formatDate, formatDateTime, formatMinutes, formatMoney, formatNumber, monthLabel } from '../lib/format';
import { navigate } from '../lib/router';
import { useLoad, useSession } from '../lib/session';
import { ACTION, DisciplineRecord, RECORD_STATUS, RecordView } from './DisciplinePage';

interface MyProfile {
  id: string; employeeNo: string; fullName: string; nameEn: string | null; branchName: string; department: string;
  position: string; managerName: string | null; hireDate: string; employmentStatus: string; employmentType: string;
  hasPhoto: boolean; shiftName: string | null; email: string | null; phone: string | null;
}
interface MyPayslip { runId: string; period: string; currency: string; totalEarnings: number; totalDeductions: number; netPay: number }
interface Balance { leaveTypeId: string; leaveTypeName: string; unit: string; balance: number; pending: number; available: number }
interface Day { date: string; status: string; firstIn: string | null; lastOut: string | null; punchCount: number; workedMinutes: number; lateMinutes: number; overtimeMinutes: number; leaveTypeName: string | null }
interface MyRequest {
  id: string; kind: 'loan' | 'expense'; amount: number; currency: string; months: number | null; startPeriod: string | null;
  expenseDate: string | null; description: string; hasReceipt: boolean; status: string; decisionNote: string | null;
  decidedByName: string | null; decidedAt: string | null; createdAt: string;
}
interface LeaveItem { id: string; leaveTypeName: string; leaveUnit: string; startsOn: string; endsOn: string; startTime: string | null; endTime: string | null; quantity: string; status: string; reason: string }

const STATUS: Record<string, { label: string; tone: string }> = {
  active: { label: 'على رأس العمل', tone: 'good' },
  on_leave: { label: 'في إجازة', tone: 'warn' },
  suspended: { label: 'موقوف', tone: 'bad' },
  inactive: { label: 'غير نشط', tone: 'muted' },
};
export const REQUEST_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'بانتظار الموارد البشرية', tone: 'warn' },
  approved: { label: 'موافق عليه', tone: 'good' },
  rejected: { label: 'مرفوض', tone: 'bad' },
  paid: { label: 'مصروف', tone: 'info' },
  cancelled: { label: 'ملغى', tone: 'muted' },
};
const LEAVE_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'قيد الموافقة', tone: 'warn' }, approved: { label: 'موافق عليها', tone: 'good' },
  rejected: { label: 'مرفوضة', tone: 'bad' }, cancelled: { label: 'ملغاة', tone: 'muted' },
};

type Tab = 'attendance' | 'requests' | 'leaves' | 'payslips' | 'notices';
type Form = null | 'leave' | 'hourly' | 'loan' | 'expense';

/** The employee portal: my card, my attendance, and every request I can make. */
export function MySpacePage() {
  const session = useSession();
  const profile = useLoad<MyProfile | null>('/me/profile', null);
  const payslips = useLoad<MyPayslip[]>('/me/payslips', []);
  const [period, setPeriod] = useState(currentPeriod());
  const attendance = useLoad<{ days: Day[]; punches: Array<{ date: string; time: string }> } | null>(`/me/attendance?period=${period}`, null);
  const requests = useLoad<MyRequest[]>('/me/requests', []);
  const leaves = useLoad<LeaveItem[]>(session.can('leaves.view') ? '/leaves' : null, []);
  const employeeId = profile.data?.id;
  const balances = useLoad<{ balances: Balance[] } | null>(employeeId && session.can('leaves.view') ? `/leaves/balances?employeeId=${employeeId}` : null, null);
  const [tab, setTab] = useState<Tab>('attendance');
  const notices = useLoad<DisciplineRecord[]>('/me/discipline', []);
  const [notice, setNotice] = useState<DisciplineRecord | null>(null);
  const [form, setForm] = useState<Form>(null);

  if (profile.loading && !profile.data) return <section className="screen"><Loading /></section>;
  const me = profile.data;
  if (!me) return <section className="screen"><Empty icon={<IdCard size={22} />} title="حسابك غير مرتبط بملف موظف" text="راجع الموارد البشرية لربط حسابك بملفك." /></section>;

  const annual = balances.data?.balances.find((item) => item.unit === 'days');
  const last = payslips.data[0];
  const days = attendance.data?.days ?? [];
  const present = days.filter((day) => day.status === 'present').length;
  const late = days.reduce((sum, day) => sum + day.lateMinutes, 0);
  const openRequests = requests.data.filter((item) => item.status === 'pending').length + leaves.data.filter((item) => item.status === 'pending').length;
  const refresh = () => { requests.reload(); leaves.reload(); balances.reload(); };

  return (
    <section className="screen portal">
      <header className="portal-card">
        <div className="portal-card-photo"><EmployeePhoto employeeId={me.id} hasPhoto={me.hasPhoto} name={me.fullName} size={96} /></div>
        <div className="portal-card-body">
          <span className="portal-card-company">مجموعة الليث العبيدي للسيارات · Al-Laith Al-Obaidi Automotive Group</span>
          <h2>{me.fullName} <StatusTag map={STATUS} value={me.employmentStatus} /></h2>
          {me.nameEn && <p dir="ltr" className="portal-card-en">{me.nameEn}</p>}
          <p>{me.position} · {me.department}</p>
          <div className="portal-card-facts">
            <span><small>الرقم الوظيفي · ID</small><strong dir="ltr">{me.employeeNo}</strong></span>
            <span><small>الفرع · Branch</small><strong>{me.branchName}</strong></span>
            <span><small>المباشرة · Joined</small><strong>{formatDate(me.hireDate)}</strong></span>
            <span><small>التوظيف · Type</small><strong>{EMPLOYMENT_TYPES[me.employmentType] ?? me.employmentType}</strong></span>
            <span><small>المدير المباشر · Manager</small><strong>{me.managerName ?? '—'}</strong></span>
            <span><small>الدوام · Shift</small><strong>{me.shiftName ?? '—'}</strong></span>
          </div>
        </div>
      </header>

      <div className="portal-actions">
        {session.can('leaves.request') && <button onClick={() => setForm('leave')}><CalendarDays size={22} /><Bi ar="طلب إجازة" en="Leave request" block /></button>}
        {session.can('leaves.request') && <button onClick={() => setForm('hourly')}><Clock3 size={22} /><Bi ar="إجازة زمنية" en="Hourly leave" block /></button>}
        <button onClick={() => setForm('loan')}><HandCoins size={22} /><Bi ar="طلب سلفة" en="Loan request" block /></button>
        <button onClick={() => setForm('expense')}><Receipt size={22} /><Bi ar="تكاليف عمل" en="Work expenses" block /></button>
        <button onClick={() => navigate('my-tickets')}><MessageSquare size={22} /><Bi ar="تذكرة (تقنية، صيانة، سيارة)" en="Helpdesk ticket" block /></button>
      </div>

      <div className="stat-row">
        <Stat label={`حضوري · ${monthLabel(period)}`} value={`${formatNumber(present)} يوم`} foot={late ? `تأخير ${formatMinutes(late)}` : 'بلا تأخير'} />
        <Stat label={annual ? `رصيد ${annual.leaveTypeName}` : 'رصيد الإجازة'} value={annual ? `${formatNumber(annual.available, 2)} يوم` : '—'} foot={annual?.pending ? `${formatNumber(annual.pending, 2)} بانتظار الموافقة` : undefined} />
        <Stat label="آخر صافي راتب" value={last ? formatMoney(last.netPay, last.currency) : '—'} foot={last ? monthLabel(last.period) : 'لا توجد قسائم معتمدة'} />
        <Stat label="طلبات مفتوحة" value={formatNumber(openRequests)} tone={openRequests ? 'warn' : undefined} />
      </div>

      <section className="panel">
        <div className="panel-head"><Tabs<Tab> value={tab} onChange={setTab} items={[
          { id: 'attendance', label: 'البصمة والحضور · Attendance' },
          { id: 'requests', label: 'طلباتي · Requests', badge: requests.data.length },
          { id: 'leaves', label: 'إجازاتي · Leave', badge: leaves.data.length },
          { id: 'payslips', label: 'قسائمي · Payslips', badge: payslips.data.length },
          { id: 'notices', label: 'إشعاراتي · Notices', badge: notices.data.filter((item) => item.status === 'issued').length || undefined },
        ]} />
          {tab === 'attendance' && <input className="inline-month" type="month" value={period} max={currentPeriod()} onChange={(event) => setPeriod(event.target.value)} aria-label="الشهر" />}</div>

        {tab === 'attendance' && (!attendance.data ? <Loading /> : days.length ? <div className="table-scroll"><table className="dense">
          <thead><tr><th>اليوم</th><th>الحالة</th><th>دخول</th><th>خروج</th><th>البصمات</th><th>العمل</th><th>تأخير</th><th>إضافي</th></tr></thead>
          <tbody>{days.map((day) => <tr key={day.date}>
            <td><strong>{formatDate(day.date)}</strong></td>
            <td><StatusTag map={DAY_STATUS} value={day.status} />{day.leaveTypeName && <small className="table-sub">{day.leaveTypeName}</small>}</td>
            <td dir="ltr">{day.firstIn ?? '—'}</td><td dir="ltr">{day.lastOut ?? '—'}</td>
            <td>{formatNumber(day.punchCount)}</td><td>{formatMinutes(day.workedMinutes)}</td>
            <td className={day.lateMinutes ? 'num-warn' : ''}>{day.lateMinutes ? formatMinutes(day.lateMinutes) : '—'}</td>
            <td>{day.overtimeMinutes ? formatMinutes(day.overtimeMinutes) : '—'}</td>
          </tr>)}</tbody>
        </table></div> : <Empty icon={<Fingerprint size={22} />} title="لا توجد سجلات حضور لهذا الشهر" text="تظهر بصماتك هنا بعد وصولها من جهاز البصمة." />)}

        {tab === 'requests' && (requests.data.length ? <div className="table-scroll"><table className="dense">
          <thead><tr><th>الطلب</th><th>المبلغ</th><th>التفاصيل</th><th>الحالة</th><th /></tr></thead>
          <tbody>{requests.data.map((item) => <tr key={item.id}>
            <td><strong>{item.kind === 'loan' ? 'سلفة' : 'تكاليف عمل'}</strong><small className="table-sub">{formatDateTime(item.createdAt)}</small></td>
            <td><strong>{formatMoney(item.amount, item.currency)}</strong>{item.kind === 'loan' && item.months && <small className="table-sub">{item.months} أشهر · {formatMoney(Math.floor(item.amount / item.months), item.currency)} شهرياً من {item.startPeriod ? monthLabel(item.startPeriod) : ''}</small>}</td>
            <td>{item.description}{item.hasReceipt && <small className="table-sub"><Paperclip size={11} /> وصل مرفق</small>}</td>
            <td><StatusTag map={REQUEST_STATUS} value={item.status} />{item.decisionNote && <small className="table-sub">{item.decisionNote}</small>}</td>
            <td>{item.status === 'pending' && <button className="text-button" onClick={() => void session.call(`/me/requests/${item.id}/cancel`, { method: 'POST' }).then(() => { session.notify('أُلغي الطلب.'); requests.reload(); }).catch((error) => session.fail(error, 'تعذر الإلغاء.'))}><X size={13} />إلغاء</button>}</td>
          </tr>)}</tbody>
        </table></div> : <Empty icon={<FileText size={22} />} title="لا توجد طلبات" text="قدّم طلب سلفة أو تكاليف عمل من الأزرار أعلاه." />)}

        {tab === 'leaves' && (leaves.data.length ? <div className="table-scroll"><table className="dense">
          <thead><tr><th>النوع</th><th>الفترة</th><th>المدة</th><th>الحالة</th></tr></thead>
          <tbody>{leaves.data.map((item) => <tr key={item.id}>
            <td><strong>{item.leaveTypeName}</strong><small className="table-sub">{item.reason}</small></td>
            <td>{formatDate(item.startsOn)}{item.endsOn !== item.startsOn ? ` – ${formatDate(item.endsOn)}` : ''}{item.startTime && <small className="table-sub" dir="ltr">{item.startTime.slice(0, 5)} – {item.endTime?.slice(0, 5)}</small>}</td>
            <td>{formatNumber(Number(item.quantity), 2)} {item.leaveUnit === 'hours' ? 'ساعة' : 'يوم'}</td>
            <td><StatusTag map={LEAVE_STATUS} value={item.status} /></td>
          </tr>)}</tbody>
        </table></div> : <Empty icon={<CalendarDays size={22} />} title="لا توجد إجازات" text="اطلب إجازة من الأزرار أعلاه." />)}

        {tab === 'payslips' && (payslips.data.length ? <div className="table-scroll"><table>
          <thead><tr><th>الشهر</th><th>الاستحقاقات</th><th>الاستقطاعات</th><th>الصافي</th><th /></tr></thead>
          <tbody>{payslips.data.map((slip) => <tr key={slip.runId} className="row-link" onClick={() => navigate('my-payslip', slip.runId)}>
            <td><strong>{monthLabel(slip.period)}</strong></td><td>{formatMoney(slip.totalEarnings, slip.currency)}</td>
            <td>{formatMoney(slip.totalDeductions, slip.currency)}</td><td><strong>{formatMoney(slip.netPay, slip.currency)}</strong></td><td><FileText size={14} /></td>
          </tr>)}</tbody>
        </table></div> : <Empty icon={<Wallet size={22} />} title="لا توجد قسائم بعد" text="ستظهر قسيمتك هنا بعد اعتماد رواتب الشهر." />)}
      </section>

      {tab === 'notices' && <section className="panel">
        {notices.data.length ? <div className="table-scroll"><table className="dense">
          <thead><tr><th>المرجع</th><th>الإجراء</th><th>العنوان</th><th>التاريخ</th><th>الحالة</th></tr></thead>
          <tbody>{notices.data.map((item) => <tr key={item.id} className="row-link" onClick={() => setNotice(item)}>
            <td dir="ltr">{item.refNo}</td><td>{ACTION[item.action].label}</td><td>{item.title}</td><td>{formatDate(item.incidentDate)}</td><td><StatusTag map={RECORD_STATUS} value={item.status} /></td>
          </tr>)}</tbody>
        </table></div> : <Empty icon={<FileText size={22} />} title="لا توجد إشعارات" text="لا توجد إنذارات أو ملاحظات مسجلة عليك." />}
      </section>}
      <Dialog open={Boolean(notice)} title={notice ? `${ACTION[notice.action].label} — ${notice.refNo}` : ''} onClose={() => setNotice(null)} wide>
        {notice && <RecordView record={notice} own onChanged={() => { setNotice(null); notices.reload(); }} />}
      </Dialog>

      {balances.data?.balances.length ? <section className="panel">
        <div className="panel-head"><div><h3>أرصدة إجازاتي · Leave balances</h3><p>الرصيد المتاح بعد خصم الطلبات المعلقة.</p></div></div>
        <div className="balance-tiles">{balances.data.balances.map((item) => <div key={item.leaveTypeId}>
          <small>{item.leaveTypeName}</small><strong>{formatNumber(item.available, 2)}</strong><span>{item.unit === 'hours' ? 'ساعة' : 'يوم'} متاح</span>
        </div>)}</div>
      </section> : null}

      <RequestForms form={form} employeeId={me.id} onClose={() => setForm(null)} onDone={() => { setForm(null); refresh(); }} />
    </section>
  );
}

function RequestForms({ form, employeeId, onClose, onDone }: { form: Form; employeeId: string; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [loan, setLoan] = useState({ amount: 0, months: 0 });
  const dayTypes = session.settings.leaveTypes.filter((type) => type.active && type.unit === 'days');
  const hourTypes = session.settings.leaveTypes.filter((type) => type.active && type.unit === 'hours');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      if (form === 'leave' || form === 'hourly') {
        const day = String(data.get('startsOn'));
        await session.call('/leaves', {
          body: {
            employeeId, leaveTypeId: data.get('leaveTypeId'), startsOn: day, endsOn: form === 'hourly' ? day : data.get('endsOn'),
            reason: data.get('reason'), ...(form === 'hourly' ? { startTime: data.get('startTime'), endTime: data.get('endTime') } : {}),
          },
        });
        session.notify('أُرسل طلب الإجازة إلى مسار الموافقات.');
      } else {
        const created = await session.call<{ data: { id: string } }>('/me/requests', {
          body: form === 'loan'
            ? { kind: 'loan', amount: Number(data.get('amount')), currency: data.get('currency'), months: Number(data.get('months')), startPeriod: data.get('startPeriod'), description: data.get('description') }
            : { kind: 'expense', amount: Number(data.get('amount')), currency: data.get('currency'), expenseDate: data.get('expenseDate'), description: data.get('description') },
        });
        const receipt = data.get('receipt');
        if (form === 'expense' && receipt instanceof File && receipt.size) {
          const upload = new FormData();
          upload.append('file', receipt);
          await session.call(`/me/requests/${created.data.id}/receipt`, { method: 'POST', form: upload });
        }
        session.notify(form === 'loan' ? 'أُرسل طلب السلفة إلى الموارد البشرية.' : 'أُرسلت تكاليف العمل إلى الموارد البشرية.');
      }
      onDone();
    } catch (error) {
      session.fail(error, 'تعذر إرسال الطلب.');
    } finally {
      setBusy(false);
    }
  }

  const titles: Record<Exclude<Form, null>, string> = {
    leave: 'طلب إجازة · Leave request', hourly: 'إجازة زمنية · Hourly leave', loan: 'طلب سلفة · Loan request', expense: 'تكاليف عمل · Work expenses',
  };
  const installment = loan.amount && loan.months ? Math.floor(loan.amount / loan.months) : 0;
  return (
    <Dialog open={form !== null} title={form ? titles[form] : ''} onClose={onClose}>
      {form && <form onSubmit={(event) => void submit(event)} key={form}>
        <div className="form-grid form-grid-2">
          {form === 'leave' && <>
            <label className="field"><span>نوع الإجازة *</span><select name="leaveTypeId" required defaultValue={dayTypes[0]?.id}>{dayTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
            <span />
            <label className="field"><span>من *</span><input name="startsOn" type="date" required /></label>
            <label className="field"><span>إلى *</span><input name="endsOn" type="date" required /></label>
          </>}
          {form === 'hourly' && <>
            <label className="field"><span>النوع *</span><select name="leaveTypeId" required defaultValue={hourTypes[0]?.id}>{hourTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
            <label className="field"><span>اليوم *</span><input name="startsOn" type="date" required /></label>
            <label className="field"><span>من الساعة *</span><input name="startTime" type="time" required /></label>
            <label className="field"><span>إلى الساعة *</span><input name="endTime" type="time" required /></label>
          </>}
          {(form === 'leave' || form === 'hourly') && <label className="field field-wide"><span>السبب *</span><input name="reason" required maxLength={500} /></label>}
          {form === 'loan' && <>
            <label className="field"><span>المبلغ *</span><input name="amount" type="number" min={1} required onChange={(event) => setLoan({ ...loan, amount: Number(event.target.value) })} /></label>
            <label className="field"><span>العملة</span><select name="currency" defaultValue="IQD"><option value="IQD">دينار عراقي</option><option value="USD">دولار أمريكي</option></select></label>
            <label className="field"><span>عدد الأشهر *</span><input name="months" type="number" min={1} max={60} required onChange={(event) => setLoan({ ...loan, months: Number(event.target.value) })} /></label>
            <label className="field"><span>أول شهر استقطاع *</span><input name="startPeriod" type="month" required defaultValue={currentPeriod()} /></label>
            {installment > 0 && <p className="field-wide portal-note"><CalendarClock size={15} />القسط الشهري التقريبي {formatNumber(installment)} على {loan.months} أشهر، والقسط الأخير يأخذ الباقي. الموارد البشرية تعتمد القسط النهائي.</p>}
            <label className="field field-wide"><span>السبب *</span><input name="description" required maxLength={1000} /></label>
          </>}
          {form === 'expense' && <>
            <label className="field"><span>المبلغ *</span><input name="amount" type="number" min={1} required /></label>
            <label className="field"><span>العملة</span><select name="currency" defaultValue="IQD"><option value="IQD">دينار عراقي</option><option value="USD">دولار أمريكي</option></select></label>
            <label className="field"><span>تاريخ المصروف *</span><input name="expenseDate" type="date" required /></label>
            <label className="field"><span>الوصل (PDF أو صورة)</span><input name="receipt" type="file" accept=".pdf,image/*" /></label>
            <label className="field field-wide"><span>الوصف *</span><input name="description" required maxLength={1000} placeholder="مثال: أجور نقل وثائق إلى فرع أربيل" /></label>
          </>}
        </div>
        <div className="dialog-actions"><button className="button button-primary" disabled={busy}><Send size={15} />{busy ? 'جارٍ الإرسال…' : 'إرسال'}</button><button type="button" className="button button-quiet" onClick={onClose}>إلغاء</button></div>
      </form>}
    </Dialog>
  );
}

export function RequestStatusTone({ status }: { status: string }) {
  return <Tone tone={REQUEST_STATUS[status]?.tone ?? 'muted'}>{REQUEST_STATUS[status]?.label ?? status}</Tone>;
}
