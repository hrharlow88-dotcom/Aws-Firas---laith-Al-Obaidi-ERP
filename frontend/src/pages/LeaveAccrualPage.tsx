import { useMemo, useState } from 'react';
import { CalendarPlus, CheckCircle2 } from 'lucide-react';
import { Empty, Loading, Stat, Tone, Warning } from '../components/ui';
import { formatDate, formatDateTime, formatNumber, monthLabel, previousPeriod } from '../lib/format';
import { useLoad, useSession } from '../lib/session';

interface AccrualLine {
  employeeId: string; employeeNo: string; fullName: string; branch: string; hireDate: string; employmentType: string;
  days: number; entitlement: number; serviceYears: number; employedDays: number; monthDays: number;
  skipReason: string | null; alreadyPosted: boolean;
}
interface Preview {
  period: string;
  leaveType: { id: string; name: string };
  lines: AccrualLine[];
  errors: string[];
  warnings: string[];
  summary: { employees: number; credited: number; skipped: number; totalDays: number };
}
interface Run { id: string; leaveTypeId: string; period: string; employeeCount: number; totalDays: number; createdAt: string; createdBy: string | null }

/**
 * Monthly leave accrual: preview every employee's credit for a month, then
 * post it to the leave ledger once. Posting the same month twice is refused
 * by the server.
 */
export function LeaveAccrualPage() {
  const session = useSession();
  const types = session.settings.leaveTypes.filter((type) => type.active && type.monthlyAccrual);
  const [leaveTypeId, setLeaveTypeId] = useState(types[0]?.id ?? '');
  const [period, setPeriod] = useState(previousPeriod());
  const [filter, setFilter] = useState<'credited' | 'skipped' | 'all'>('credited');
  const [posting, setPosting] = useState(false);
  const preview = useLoad<Preview | null>(leaveTypeId && period ? `/leaves/accruals/preview?period=${period}&leaveTypeId=${leaveTypeId}` : null, null);
  const runs = useLoad<Run[]>('/leaves/accruals', []);
  const startPeriod = session.settings.leaveRules.accrualStartPeriod;

  const lines = useMemo(() => (preview.data?.lines ?? []).filter((line) =>
    filter === 'all' ? true : filter === 'skipped' ? Boolean(line.skipReason) : line.days > 0), [preview.data, filter]);

  async function post() {
    if (!preview.data) return;
    const { summary } = preview.data;
    if (!window.confirm(`ترحيل استحقاق ${monthLabel(period)}: ${formatNumber(summary.totalDays, 2)} يوم على ${summary.credited} موظف؟ لا يمكن ترحيل الشهر نفسه مرة ثانية.`)) return;
    setPosting(true);
    try {
      await session.call('/leaves/accruals', { body: { period, leaveTypeId } });
      session.notify(`رُحّل استحقاق ${monthLabel(period)} إلى أرصدة الموظفين.`);
      preview.reload();
      runs.reload();
    } catch (error) {
      session.fail(error, 'تعذر ترحيل الاستحقاق.');
    } finally {
      setPosting(false);
    }
  }

  if (!types.length) {
    return <section className="screen">
      <div className="screen-heading"><div><h2>الاستحقاق الشهري للإجازات</h2></div></div>
      <Empty icon={<CalendarPlus size={20} />} title="لا يوجد نوع إجازة بالاستحقاق الشهري"
        text="من الإعدادات ← الإجازات فعّل «يُستحق شهرياً» لنوع الإجازة السنوية، وحدد أول شهر للاستحقاق." />
    </section>;
  }

  const data = preview.data;
  return (
    <section className="screen">
      <div className="screen-heading">
        <div>
          <h2>الاستحقاق الشهري للإجازات</h2>
          <p>يُضاف لكل موظف جزء الشهر من استحقاقه السنوي حسب سنوات خدمته، ومن باشر أو انتهت خدمته خلال الشهر يُحتسب له بنسبة أيامه.{startPeriod ? ` أول شهر للاستحقاق: ${monthLabel(startPeriod)}.` : ''}</p>
        </div>
      </div>

      <div className="toolbar">
        {types.length > 1 && <label className="field"><span>نوع الإجازة</span>
          <select value={leaveTypeId} onChange={(event) => setLeaveTypeId(event.target.value)}>{types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>}
        <label className="field"><span>الشهر</span><input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} /></label>
        <label className="field"><span>العرض</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
            <option value="credited">من سيُضاف لهم</option><option value="skipped">المستثنون</option><option value="all">الكل</option>
          </select></label>
      </div>

      {preview.loading && <Loading />}
      {data && <>
        <div className="stat-row">
          <Stat label="موظفون بالشهر" value={formatNumber(data.summary.employees)} />
          <Stat label="سيُضاف لهم" value={formatNumber(data.summary.credited)} tone="good" />
          <Stat label="مستثنون" value={formatNumber(data.summary.skipped)} />
          <Stat label="مجموع الأيام" value={formatNumber(data.summary.totalDays, 2)} />
        </div>
        {data.errors.map((error) => <Warning key={error} title="لا يمكن الترحيل">{error}</Warning>)}
        {data.warnings.map((warning) => <Warning key={warning} title="تنبيه">{warning}</Warning>)}
        <section className="panel">
        <div className="panel-head"><div><h3>{data.leaveType.name} · {monthLabel(period)}</h3><p>{lines.length} موظف بهذا العرض</p></div>
          <button className="button button-primary" disabled={posting || data.errors.length > 0 || data.summary.credited === 0} onClick={() => void post()}>
            <CheckCircle2 size={16} />ترحيل الاستحقاق
          </button>
        </div>
        {lines.length ? <div className="table-scroll"><table>
          <thead><tr><th>الموظف</th><th>الفرع</th><th>المباشرة</th><th>سنوات الخدمة</th><th>الاستحقاق السنوي</th><th>أيام الشهر</th><th>يُضاف</th></tr></thead>
          <tbody>{lines.map((line) => <tr key={line.employeeId}>
            <td><strong>{line.fullName}</strong><span className="table-sub">{line.employeeNo}</span></td>
            <td>{line.branch}</td>
            <td>{formatDate(line.hireDate)}</td>
            <td>{line.skipReason ? '—' : formatNumber(line.serviceYears)}</td>
            <td>{line.skipReason ? '—' : `${formatNumber(line.entitlement)} يوم`}</td>
            <td>{line.skipReason ? '—' : `${line.employedDays} / ${line.monthDays}`}</td>
            <td>{line.alreadyPosted ? <Tone tone="good">مُرحّل</Tone> : line.skipReason ? <Tone tone="muted">{line.skipReason}</Tone> : <strong>{formatNumber(line.days, 2)}</strong>}</td>
          </tr>)}</tbody>
        </table></div> : <div className="table-loading">لا يوجد موظفون بهذا العرض.</div>}
        </section>
      </>}

      <section className="panel">
      <div className="panel-head"><div><h3>الأشهر المُرحّلة</h3><p>كل شهر يُرحّل مرة واحدة فقط</p></div></div>
      {runs.data.length ? <div className="table-scroll"><table>
        <thead><tr><th>الشهر</th><th>نوع الإجازة</th><th>الموظفون</th><th>الأيام</th><th>رحّلها</th><th>التاريخ</th></tr></thead>
        <tbody>{runs.data.map((run) => <tr key={run.id}>
          <td>{monthLabel(run.period)}</td>
          <td>{session.settings.leaveTypes.find((type) => type.id === run.leaveTypeId)?.name ?? '—'}</td>
          <td>{formatNumber(run.employeeCount)}</td>
          <td>{formatNumber(run.totalDays, 2)}</td>
          <td>{run.createdBy ?? '—'}</td>
          <td>{formatDateTime(run.createdAt)}</td>
        </tr>)}</tbody>
      </table></div> : <div className="table-loading">لم يُرحّل أي شهر بعد.</div>}
      </section>
    </section>
  );
}
