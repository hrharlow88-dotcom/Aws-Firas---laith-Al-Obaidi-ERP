import { CalendarDays, FileText, IdCard, Wallet } from 'lucide-react';
import { EmployeePhoto } from '../components/EmployeePhoto';
import { Empty, Loading, Stat, StatusTag } from '../components/ui';
import { EMPLOYMENT_TYPES, formatDate, formatMoney, formatNumber, monthLabel } from '../lib/format';
import { navigate } from '../lib/router';
import { useLoad, useSession } from '../lib/session';

interface MyProfile {
  id: string; employeeNo: string; fullName: string; nameEn: string | null; branchName: string; department: string;
  position: string; managerName: string | null; hireDate: string; employmentStatus: string; employmentType: string;
  hasPhoto: boolean; shiftName: string | null; email: string | null; phone: string | null;
}
interface MyPayslip { runId: string; period: string; currency: string; totalEarnings: number; totalDeductions: number; netPay: number }
interface Balance { leaveTypeId: string; leaveTypeName: string; unit: string; balance: number; pending: number; available: number }

const STATUS: Record<string, { label: string; tone: string }> = {
  active: { label: 'على رأس العمل', tone: 'good' },
  on_leave: { label: 'في إجازة', tone: 'warn' },
  suspended: { label: 'موقوف', tone: 'bad' },
  inactive: { label: 'غير نشط', tone: 'muted' },
};

/** Employee self-service: my file, my payslips, my leave balances. */
export function MySpacePage() {
  const session = useSession();
  const profile = useLoad<MyProfile | null>('/me/profile', null);
  const payslips = useLoad<MyPayslip[]>('/me/payslips', []);
  const employeeId = profile.data?.id;
  const balances = useLoad<{ balances: Balance[] } | null>(
    employeeId && session.can('leaves.view') ? `/leaves/balances?employeeId=${employeeId}` : null, null,
  );
  if (profile.loading && !profile.data) return <section className="screen"><Loading /></section>;
  const me = profile.data;
  if (!me) return <section className="screen"><Empty icon={<IdCard size={22} />} title="حسابك غير مرتبط بملف موظف" text="راجع الموارد البشرية لربط حسابك بملفك." /></section>;
  const annual = balances.data?.balances[0];
  const last = payslips.data[0];
  return (
    <section className="screen">
      <header className="profile-header panel">
        <div className="profile-photo-wrap"><EmployeePhoto employeeId={me.id} hasPhoto={me.hasPhoto} name={me.fullName} size={84} /></div>
        <div className="profile-identity">
          <div className="profile-name-row"><h2>{me.fullName}</h2><StatusTag map={STATUS} value={me.employmentStatus} /></div>
          <p>{me.position} · {me.department}{me.nameEn ? ` · ${me.nameEn}` : ''}</p>
          <div className="profile-facts">
            <span><small>الرقم الوظيفي</small><strong dir="ltr">{me.employeeNo}</strong></span>
            <span><small>الفرع</small><strong>{me.branchName}</strong></span>
            <span><small>تاريخ المباشرة</small><strong>{formatDate(me.hireDate)}</strong></span>
            <span><small>نوع التوظيف</small><strong>{EMPLOYMENT_TYPES[me.employmentType] ?? me.employmentType}</strong></span>
            <span><small>المدير المباشر</small><strong>{me.managerName ?? '—'}</strong></span>
            <span><small>الدوام</small><strong>{me.shiftName ?? '—'}</strong></span>
          </div>
        </div>
      </header>
      <div className="stat-row">
        <Stat label="آخر صافي راتب" value={last ? formatMoney(last.netPay, last.currency) : '—'} foot={last ? monthLabel(last.period) : 'لا توجد قسائم معتمدة'} />
        <Stat label={annual ? `رصيد ${annual.leaveTypeName}` : 'رصيد الإجازة'} value={annual ? `${formatNumber(annual.available, 2)} يوم` : '—'} foot={annual?.pending ? `${formatNumber(annual.pending, 2)} بانتظار الموافقة` : undefined} />
      </div>
      <div className="split-grid">
        <section className="panel">
          <div className="panel-head"><div><h3>قسائم راتبي</h3><p>تظهر القسيمة بعد اعتماد مسير الشهر.</p></div></div>
          {payslips.loading ? <Loading /> : payslips.data.length ? <div className="table-scroll"><table>
            <thead><tr><th>الشهر</th><th>الاستحقاقات</th><th>الاستقطاعات</th><th>الصافي</th><th /></tr></thead>
            <tbody>{payslips.data.map((slip) => <tr key={`${slip.runId}`} className="row-link" onClick={() => navigate('my-payslip', slip.runId)}>
              <td><strong>{monthLabel(slip.period)}</strong></td>
              <td>{formatMoney(slip.totalEarnings, slip.currency)}</td>
              <td>{formatMoney(slip.totalDeductions, slip.currency)}</td>
              <td><strong>{formatMoney(slip.netPay, slip.currency)}</strong></td>
              <td><FileText size={14} /></td>
            </tr>)}</tbody>
          </table></div> : <Empty icon={<Wallet size={22} />} title="لا توجد قسائم بعد" text="ستظهر قسيمتك هنا بعد اعتماد رواتب الشهر." />}
        </section>
        <section className="panel">
          <div className="panel-head"><div><h3>أرصدة إجازاتي</h3><p>الرصيد المتاح بعد خصم الطلبات المعلقة.</p></div>
            {session.can('leaves.request') && <button className="button button-quiet" onClick={() => navigate('leaves')}><CalendarDays size={15} />طلب إجازة</button>}</div>
          {balances.loading ? <Loading /> : balances.data?.balances.length ? <div className="table-scroll"><table className="dense">
            <thead><tr><th>النوع</th><th>الرصيد</th><th>معلق</th><th>المتاح</th></tr></thead>
            <tbody>{balances.data.balances.map((item) => <tr key={item.leaveTypeId}>
              <td>{item.leaveTypeName}</td><td>{formatNumber(item.balance, 2)}</td><td>{formatNumber(item.pending, 2)}</td><td><strong>{formatNumber(item.available, 2)}</strong></td>
            </tr>)}</tbody>
          </table></div> : <Empty icon={<CalendarDays size={22} />} title="لا توجد أرصدة مسجلة" text="تُضاف الأرصدة من قسم الموارد البشرية." />}
        </section>
      </div>
    </section>
  );
}
