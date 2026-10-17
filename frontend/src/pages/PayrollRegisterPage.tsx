import { useMemo, useState } from 'react';
import { Landmark, Printer } from 'lucide-react';
import { Bi } from '../components/Brand';
import { RateBulletin } from '../components/RateBulletin';
import { Empty, Loading, Stat, Tone } from '../components/ui';
import { formatMoney, formatNumber, monthLabel, previousPeriod } from '../lib/format';
import { navigate } from '../lib/router';
import { useLoad } from '../lib/session';

export interface Governorate { id: string; code: string; nameAr: string; nameEn: string; branches: Array<{ id: string; name: string; city: string; employees: number }> }
interface RegisterLine {
  source: 'system' | 'archive'; sourceId: string; status: string; employeeId: string | null; employeeNo: string; employeeName: string;
  governorateName: string | null; branchName: string | null; department: string | null; currency: string;
  gross: number | null; deductions: number | null; net: number; netIqd: number | null; netUsd: number | null;
}
interface Group { governorate: string; branch: string; department: string; employees: number; byCurrency: Record<string, number>; netIqd: number; netUsd: number }
interface Register {
  period: string; rate: { rate: number; date: string } | null; source: 'system' | 'archive' | null;
  lines: RegisterLine[]; groups: Group[]; totals: { employees: number; byCurrency: Record<string, number>; netIqd: number; netUsd: number };
}

export function useGovernorates() {
  return useLoad<{ governorates: Governorate[]; unassigned: Array<{ id: string; name: string }> }>('/governorates', { governorates: [], unassigned: [] });
}

/**
 * Salaries for one month by governorate (Baghdad, Mosul, Erbil), branch and
 * department, in dinars, dollars or both: each employee's own currency with
 * the equivalent at the month's dollar rate, for local and foreign staff alike.
 */
export function PayrollRegisterPage() {
  const [period, setPeriod] = useState(previousPeriod());
  const [governorateId, setGovernorateId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [currency, setCurrency] = useState<'' | 'IQD' | 'USD'>('');
  const [view, setView] = useState<'groups' | 'lines'>('groups');
  const governorates = useGovernorates();
  const departments = useLoad<Array<{ id: string; name: string }>>('/org/departments', []);
  const query = new URLSearchParams({ period, ...(governorateId ? { governorateId } : {}), ...(branchId ? { branchId } : {}), ...(departmentId ? { departmentId } : {}), ...(currency ? { currency } : {}) });
  const register = useLoad<Register | null>(/^\d{4}-\d{2}$/.test(period) ? `/payroll/register?${query}` : null, null);
  const branches = useMemo(() => governorates.data.governorates.filter((item) => !governorateId || item.id === governorateId).flatMap((item) => item.branches), [governorates.data, governorateId]);
  const data = register.data;

  return (
    <section className="screen">
      <div className="screen-heading">
        <div><h2><Bi ar="الرواتب حسب المحافظة" en="Payroll by governorate" /></h2>
          <p>بغداد والموصل وأربيل، لكل محافظة فروعها وملف رواتبها. يظهر راتب كل موظف بعملته (دينار أو دولار) ومعادله بسعر صرف الشهر، فيُجمع المحليون والأجانب في كشف واحد.</p></div>
        <button className="button button-quiet no-print" onClick={() => window.print()}><Printer size={15} />طباعة</button>
      </div>
      <RateBulletin />
      <div className="filter-bar register-filters no-print">
        <label className="field"><span>الشهر</span><input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} /></label>
        <label className="field"><span>المحافظة</span><select value={governorateId} onChange={(event) => { setGovernorateId(event.target.value); setBranchId(''); }}>
          <option value="">كل المحافظات</option>{governorates.data.governorates.map((item) => <option key={item.id} value={item.id}>{item.nameAr} · {item.nameEn}</option>)}</select></label>
        <label className="field"><span>الفرع</span><select value={branchId} onChange={(event) => setBranchId(event.target.value)}>
          <option value="">كل الفروع</option>{branches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="field"><span>القسم</span><select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
          <option value="">كل الأقسام</option>{departments.data.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <div className="field"><span>العملة</span><div className="segmented">
          <button aria-pressed={currency === ''} onClick={() => setCurrency('')}><Bi ar={"كلاهما"} en={"Both"} /></button>
          <button aria-pressed={currency === 'IQD'} onClick={() => setCurrency('IQD')}><Bi ar={"دينار"} en={"IQD"} /></button>
          <button aria-pressed={currency === 'USD'} onClick={() => setCurrency('USD')}><Bi ar={"دولار"} en={"USD"} /></button></div></div>
      </div>
      {register.loading ? <Loading /> : !data || !data.lines.length
        ? <section className="panel"><Empty icon={<Landmark size={22} />} title={`لا توجد رواتب لشهر ${monthLabel(period)}`} text="شغّل مسير الشهر أو ارفع ملف المحافظة في أرشيف المسيرات." /></section>
        : <>
          <div className="stat-row">
            <Stat label="الموظفون" value={formatNumber(data.totals.employees)} foot={data.source === 'archive' ? 'من أرشيف المسيرات' : 'من مسيرات النظام'} />
            {Object.entries(data.totals.byCurrency).map(([code, total]) => <Stat key={code} label={`صافي ${code === 'USD' ? 'الدولار' : 'الدينار'}`} value={formatMoney(total, code)} />)}
            <Stat label="الإجمالي بالدينار" value={formatMoney(data.totals.netIqd, 'IQD')} foot={data.rate ? `بسعر ${formatNumber(data.rate.rate)} (${data.rate.date})` : 'لا يوجد سعر صرف منشور'} />
            <Stat label="الإجمالي بالدولار" value={formatMoney(data.totals.netUsd, 'USD')} />
          </div>
          <section className="panel">
            <div className="panel-head"><div><h3>{monthLabel(period)}</h3></div>
              <div className="segmented no-print"><button aria-pressed={view === 'groups'} onClick={() => setView('groups')}>حسب الفرع والقسم</button><button aria-pressed={view === 'lines'} onClick={() => setView('lines')}>كل الموظفين</button></div></div>
            {view === 'groups'
              ? <div className="table-scroll"><table className="dense"><thead><tr><th>المحافظة</th><th>الفرع</th><th>القسم</th><th>الموظفون</th><th>بعملته</th><th>معادل الدينار</th><th>معادل الدولار</th></tr></thead>
                <tbody>{data.groups.map((group) => <tr key={`${group.governorate}${group.branch}${group.department}`}>
                  <td><strong>{group.governorate}</strong></td><td>{group.branch}</td><td>{group.department}</td><td>{group.employees}</td>
                  <td>{Object.entries(group.byCurrency).map(([code, total]) => <span key={code} className="table-sub">{formatMoney(total, code)}</span>)}</td>
                  <td>{formatMoney(group.netIqd, 'IQD')}</td><td>{formatMoney(group.netUsd, 'USD')}</td></tr>)}</tbody></table></div>
              : <div className="table-scroll"><table className="dense"><thead><tr><th>الموظف</th><th>المحافظة / الفرع</th><th>القسم</th><th>العملة</th><th>الإجمالي</th><th>الاستقطاعات</th><th>الصافي</th><th>بالدينار</th><th>بالدولار</th></tr></thead>
                <tbody>{data.lines.map((line) => <tr key={`${line.sourceId}${line.employeeNo}`} className={line.employeeId ? 'row-link' : ''} onClick={() => line.employeeId && navigate('employees', line.employeeId)}>
                  <td><strong>{line.employeeName}</strong><small className="table-sub">{line.employeeNo}</small></td>
                  <td>{line.governorateName ?? '—'}<small className="table-sub">{line.branchName ?? '—'}</small></td><td>{line.department ?? '—'}</td>
                  <td><Tone tone={line.currency === 'USD' ? 'warn' : 'muted'}>{line.currency}</Tone></td>
                  <td>{line.gross !== null ? formatMoney(line.gross, line.currency) : '—'}</td><td>{line.deductions !== null ? formatMoney(line.deductions, line.currency) : '—'}</td>
                  <td><strong>{formatMoney(line.net, line.currency)}</strong></td>
                  <td>{line.netIqd !== null ? formatMoney(line.netIqd, 'IQD') : '—'}</td><td>{line.netUsd !== null ? formatMoney(line.netUsd, 'USD') : '—'}</td></tr>)}</tbody></table></div>}
          </section>
        </>}
    </section>
  );
}
