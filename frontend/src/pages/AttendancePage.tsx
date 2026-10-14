import { FormEvent, useState } from 'react';
import { Clock3, Cpu, FileUp, Fingerprint, Link2, Plus, RefreshCw, Sun, Users } from 'lucide-react';
import { EmployeePicker, PickedEmployee } from '../components/EmployeePicker';
import { Dialog, Empty, Loading, Stat, StatusTag, Tabs, Tone, Warning } from '../components/ui';
import {
  DAY_STATUS, WEEKDAYS, addDays, formatDateTime, formatMinutes, formatNumber, periodRange, previousPeriod, today,
} from '../lib/format';
import { navigate } from '../lib/router';
import { useLoad, useSession } from '../lib/session';
import { AttendanceDaysTable } from './EmployeeProfilePage';

type Tab = 'today' | 'days' | 'summary' | 'import' | 'shifts' | 'devices';

interface Shift {
  id: string; code: string; name: string; startTime: string; endTime: string; breakMinutes: number; graceMinutes: number;
  earlyLeaveGraceMinutes: number; workingDays: number[]; isDefault: boolean; isActive: boolean; employeeCount: number;
}

export function AttendancePage({ branches }: { branches: Array<{ id: string; name: string }> }) {
  const session = useSession();
  const canManage = session.can('attendance.manage');
  const [tab, setTab] = useState<Tab>('today');
  const items: Array<{ id: Tab; label: string }> = [
    { id: 'today', label: 'اليوم' },
    { id: 'days', label: 'السجل اليومي' },
    { id: 'summary', label: 'ملخص الفترة' },
    ...(canManage ? [{ id: 'import' as Tab, label: 'استيراد البصمات' }] : []),
    { id: 'shifts', label: 'الدوامات' },
    { id: 'devices', label: 'أجهزة البصمة' },
  ];
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2>الحضور والانصراف</h2><p>البصمات من الأجهزة والملفات، واحتساب التأخير والغياب والإضافي للموظفين المسند لهم دوام.</p></div></div>
      <Tabs<Tab> value={tab} onChange={setTab} items={items} />
      {tab === 'today' && <TodayBoard />}
      {tab === 'days' && <DaysView branches={branches} canManage={canManage} />}
      {tab === 'summary' && <SummaryView branches={branches} />}
      {tab === 'import' && canManage && <ImportView />}
      {tab === 'shifts' && <ShiftsView canManage={canManage} />}
      {tab === 'devices' && <DevicesView branches={branches} canManage={canManage} />}
    </section>
  );
}

function TodayBoard() {
  const board = useLoad<{
    date: string;
    totals: { tracked: number; inside: number; late: number; onLeave: number; notArrived: number };
    rows: Array<{ employeeId: string; employeeName: string; employeeNo: string; branchName: string; firstIn: string | null; lastOut: string | null; status: string; lateMinutes: number; leaveTypeName: string | null }>;
  } | null>('/attendance/today', null);
  if (board.loading && !board.data) return <section className="panel"><Loading /></section>;
  const data = board.data;
  if (!data) return null;
  const notArrived = data.rows.filter((row) => row.status === 'incomplete' && !row.firstIn);
  return (
    <>
      <div className="stat-row">
        <Stat label="خاضعون للبصمة" value={formatNumber(data.totals.tracked)} />
        <Stat label="داخل الدوام" value={formatNumber(data.totals.inside)} tone="good" />
        <Stat label="متأخرون" value={formatNumber(data.totals.late)} tone={data.totals.late ? 'warn' : undefined} />
        <Stat label="في إجازة" value={formatNumber(data.totals.onLeave)} />
        <Stat label="لم يبصموا بعد" value={formatNumber(data.totals.notArrived)} tone={data.totals.notArrived ? 'bad' : undefined} />
      </div>
      <section className="panel">
        <div className="panel-head"><div><h3>حضور اليوم</h3><p>يتحدث مع وصول البصمات من الأجهزة أو عند استيراد ملف.</p></div><button className="button button-quiet" onClick={board.reload}><RefreshCw size={15} />تحديث</button></div>
        {data.rows.length ? <div className="table-scroll"><table className="dense">
          <thead><tr><th>الموظف</th><th>الفرع</th><th>الدخول</th><th>الخروج</th><th>الحالة</th><th>تأخير</th></tr></thead>
          <tbody>{[...notArrived, ...data.rows.filter((row) => !notArrived.includes(row))].map((row) => <tr key={row.employeeId}>
            <td><button className="text-button" onClick={() => navigate('employees', row.employeeId)}>{row.employeeName}</button><small className="table-sub">{row.employeeNo}</small></td>
            <td>{row.branchName}</td>
            <td dir="ltr">{row.firstIn ?? '—'}</td>
            <td dir="ltr">{row.lastOut ?? '—'}</td>
            <td>{row.status === 'incomplete' && !row.firstIn ? <Tone tone="bad">لم يبصم</Tone> : row.status === 'incomplete' ? <Tone tone="good">داخل الدوام</Tone> : <StatusTag map={DAY_STATUS} value={row.status} />}{row.leaveTypeName && <small className="table-sub">{row.leaveTypeName}</small>}</td>
            <td className={row.lateMinutes ? 'num-bad' : ''}>{formatMinutes(row.lateMinutes)}</td>
          </tr>)}</tbody>
        </table></div> : <Empty icon={<Sun size={22} />} title="لا يوجد موظفون خاضعون للبصمة" text="أسند دواماً للموظفين من تبويب الدوامات أو من ملف الموظف." />}
      </section>
    </>
  );
}

function DaysView({ branches, canManage }: { branches: Array<{ id: string; name: string }>; canManage: boolean }) {
  const session = useSession();
  const [from, setFrom] = useState(addDays(today(), -7));
  const [to, setTo] = useState(today());
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState('');
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [overriding, setOverriding] = useState<{ employeeId: string; workDate: string; employeeName?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const query = new URLSearchParams({ from, to, ...(branchId ? { branchId } : {}), ...(status ? { status } : {}), ...(employee ? { employeeId: employee.id } : {}) });
  const days = useLoad<Array<Parameters<typeof AttendanceDaysTable>[0]['rows'][number]>>(`/attendance/days?${query}`, []);

  async function recompute() {
    setBusy(true);
    try {
      const result = await session.call<{ data: { employees: number; days: number } }>('/attendance/compute', {
        body: { from, to, ...(branchId ? { branchId } : {}), ...(employee ? { employeeId: employee.id } : {}) },
      });
      session.notify(`أعيد احتساب ${formatNumber(result.data.days)} يوم لـ ${formatNumber(result.data.employees)} موظف.`);
      days.reload();
    } catch (error) {
      session.fail(error, 'تعذر الاحتساب.');
    } finally {
      setBusy(false);
    }
  }

  async function saveOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!overriding) return;
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = { reason: form.get('reason') };
    if (form.get('status')) body.status = form.get('status');
    if (form.get('lateMinutes') !== '') body.lateMinutes = Number(form.get('lateMinutes'));
    if (form.get('overtimeMinutes') !== '') body.overtimeMinutes = Number(form.get('overtimeMinutes'));
    try {
      await session.call(`/attendance/days/${overriding.employeeId}/${overriding.workDate}`, { method: 'PUT', body });
      session.notify('تم تصحيح اليوم.');
      setOverriding(null);
      days.reload();
    } catch (error) {
      session.fail(error, 'تعذر التصحيح.');
    }
  }

  async function clearOverride() {
    if (!overriding) return;
    try {
      await session.call(`/attendance/days/${overriding.employeeId}/${overriding.workDate}`, { method: 'PUT', body: { clear: true } });
      session.notify('أُلغي التصحيح وعادت القيم المحتسبة.');
      setOverriding(null);
      days.reload();
    } catch (error) {
      session.fail(error, 'تعذر إلغاء التصحيح.');
    }
  }

  return (
    <section className="panel">
      <div className="toolbar">
        <label className="field"><span>من</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label className="field"><span>إلى</span><input type="date" value={to} max={today()} onChange={(event) => setTo(event.target.value)} /></label>
        {session.user.role !== 'branch_manager' && <label className="field"><span>الفرع</span><select value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">كل الفروع</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}
        <label className="field"><span>الحالة</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">الكل</option>{Object.entries(DAY_STATUS).filter(([key]) => key !== 'not_employed').map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
        <EmployeePicker label="موظف" value={employee} onChange={setEmployee} />
        {canManage && <button className="button button-quiet toolbar-action" disabled={busy} onClick={() => void recompute()}><RefreshCw size={15} />{busy ? 'جارٍ الاحتساب…' : 'إعادة الاحتساب'}</button>}
      </div>
      {days.loading ? <Loading /> : days.data.length
        ? <AttendanceDaysTable rows={days.data} showEmployee onOverride={canManage ? (row) => setOverriding({ employeeId: row.employeeId!, workDate: row.workDate, employeeName: (row as { employeeName?: string }).employeeName }) : undefined} />
        : <Empty icon={<Clock3 size={22} />} title="لا توجد سجلات في هذه الفترة" text="جرّب فترة أخرى، أو اضغط إعادة الاحتساب بعد استيراد البصمات." />}
      <Dialog open={Boolean(overriding)} title={`تصحيح يوم ${overriding?.workDate ?? ''}`} subtitle={`${overriding?.employeeName ?? ''} — تبقى القيم المحتسبة ظاهرة بجانب التصحيح، والسبب يُسجل في التدقيق.`} onClose={() => setOverriding(null)}>
        <form onSubmit={saveOverride} key={`${overriding?.employeeId}-${overriding?.workDate}`}>
          <div className="form-grid form-grid-2">
            <label className="field"><span>الحالة</span><select name="status" defaultValue=""><option value="">بدون تغيير</option>{['present', 'absent', 'leave', 'unpaid_leave', 'holiday', 'weekend'].map((key) => <option key={key} value={key}>{DAY_STATUS[key].label}</option>)}</select></label>
            <label className="field"><span>دقائق التأخير</span><input name="lateMinutes" type="number" min={0} max={1440} /></label>
            <label className="field"><span>دقائق الإضافي</span><input name="overtimeMinutes" type="number" min={0} max={1440} /></label>
            <label className="field settings-wide"><span>السبب *</span><textarea name="reason" rows={2} required maxLength={500} placeholder="عطل جهاز البصمة / مهمة خارج الشركة بتأييد المدير…" /></label>
          </div>
          <div className="dialog-actions"><button className="button button-primary">حفظ التصحيح</button><button type="button" className="button button-quiet" onClick={() => void clearOverride()}>إلغاء تصحيح سابق</button></div>
        </form>
      </Dialog>
    </section>
  );
}

function SummaryView({ branches }: { branches: Array<{ id: string; name: string }> }) {
  const session = useSession();
  const [period, setPeriod] = useState(previousPeriod());
  const [branchId, setBranchId] = useState('');
  const range = periodRange(period);
  const summary = useLoad<Array<{ employeeId: string; employeeName: string; employeeNo: string; branchName: string; present: number; absent: number; leave: number; unpaidLeave: number; incomplete: number; lateMinutes: number; earlyLeaveMinutes: number; overtimeMinutes: number }>>(
    `/attendance/summary?from=${range.from}&to=${range.to}${branchId ? `&branchId=${branchId}` : ''}`, [],
  );
  return (
    <section className="panel">
      <div className="toolbar">
        <label className="field"><span>الشهر</span><input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} /></label>
        {session.user.role !== 'branch_manager' && <label className="field"><span>الفرع</span><select value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">كل الفروع</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}
      </div>
      {summary.loading ? <Loading /> : summary.data.length ? <div className="table-scroll"><table className="dense">
        <thead><tr><th>الموظف</th><th>الفرع</th><th>حضور</th><th>غياب</th><th>إجازة</th><th>بدون راتب</th><th>بصمة ناقصة</th><th>تأخير</th><th>خروج مبكر</th><th>إضافي</th></tr></thead>
        <tbody>{summary.data.map((row) => <tr key={row.employeeId}>
          <td><button className="text-button" onClick={() => navigate('employees', row.employeeId)}>{row.employeeName}</button><small className="table-sub">{row.employeeNo}</small></td>
          <td>{row.branchName}</td><td>{row.present}</td>
          <td className={row.absent ? 'num-bad' : ''}>{row.absent}</td><td>{row.leave}</td>
          <td className={row.unpaidLeave ? 'num-bad' : ''}>{row.unpaidLeave}</td>
          <td className={row.incomplete ? 'num-warn' : ''}>{row.incomplete}</td>
          <td>{formatMinutes(row.lateMinutes)}</td><td>{formatMinutes(row.earlyLeaveMinutes)}</td>
          <td className={row.overtimeMinutes ? 'num-good' : ''}>{formatMinutes(row.overtimeMinutes)}</td>
        </tr>)}</tbody>
      </table></div> : <Empty icon={<Users size={22} />} title="لا توجد بيانات لهذا الشهر" text="الملخص يعتمد على الأيام المحتسبة. استورد البصمات ثم أعد الاحتساب." />}
    </section>
  );
}

function ImportView() {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: number; duplicate: number; unmatched: number; invalid: number; from: string | null; to: string | null; format: string } | null>(null);
  const imports = useLoad<Array<{ id: string; fileName: string | null; deviceName: string | null; source: string; rowsTotal: number; rowsImported: number; rowsDuplicate: number; rowsUnmatched: number; rowsInvalid: number; createdAt: string; createdByName: string | null }>>('/attendance/imports', []);
  const unmatched = useLoad<Array<{ pin: string; punches: number; firstSeen: string; lastSeen: string }>>('/attendance/unmatched', []);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [assignee, setAssignee] = useState<PickedEmployee | null>(null);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setResult(null);
    try {
      const response = await session.call<{ data: NonNullable<typeof result> }>('/attendance/imports', { form });
      setResult(response.data);
      session.notify(`استُورد ${formatNumber(response.data.imported)} بصمة.`);
      imports.reload();
      unmatched.reload();
      (event.target as HTMLFormElement).reset();
    } catch (error) {
      session.fail(error, 'تعذر استيراد الملف.');
    } finally {
      setBusy(false);
    }
  }

  async function assign() {
    if (!assigning || !assignee) return;
    try {
      await session.call('/attendance/unmatched/assign', { body: { pin: assigning, employeeId: assignee.id } });
      session.notify(`رُبط رقم البصمة ${assigning} بـ ${assignee.fullName} وأعيد احتساب أيامه.`);
      setAssigning(null);
      setAssignee(null);
      unmatched.reload();
    } catch (error) {
      session.fail(error, 'تعذر الربط.');
    }
  }

  return (
    <div className="split">
      <section className="panel">
        <div className="panel-head"><div><h3>استيراد ملف بصمات</h3><p>ملف ZKTeco (attlog.dat) أو تصدير CSV / Excel من برنامج البصمة. إعادة رفع الملف نفسه لا تكرر البصمات.</p></div></div>
        <form className="panel-pad" onSubmit={upload}>
          <div className="form-grid form-grid-2">
            <label className="field settings-wide"><span>الملف *</span><input type="file" name="file" required accept=".dat,.txt,.csv,.xlsx" /></label>
            <label className="field"><span>ترتيب التاريخ في الملف</span><select name="dateOrder" defaultValue="dmy"><option value="dmy">يوم/شهر/سنة</option><option value="mdy">شهر/يوم/سنة</option></select><small>لا يؤثر على صيغة 2026-10-01.</small></label>
          </div>
          <div className="form-actions"><button className="button button-primary" disabled={busy}><FileUp size={16} />{busy ? 'جارٍ الاستيراد والاحتساب…' : 'استيراد'}</button></div>
        </form>
        {result && <div className="import-result">
          <Stat label="مستوردة" value={formatNumber(result.imported)} tone="good" />
          <Stat label="مكررة (موجودة)" value={formatNumber(result.duplicate)} />
          <Stat label="أرقام غير مربوطة" value={formatNumber(result.unmatched)} tone={result.unmatched ? 'warn' : undefined} />
          <Stat label="أسطر غير صالحة" value={formatNumber(result.invalid)} tone={result.invalid ? 'bad' : undefined} />
        </div>}
        <div className="panel-head subtle"><div><h3>آخر عمليات الاستيراد</h3></div></div>
        {imports.loading ? <Loading /> : imports.data.length ? <div className="table-scroll"><table className="dense">
          <thead><tr><th>المصدر</th><th>الوقت</th><th>مستوردة</th><th>مكررة</th><th>غير مربوطة</th><th>غير صالحة</th></tr></thead>
          <tbody>{imports.data.map((row) => <tr key={row.id}>
            <td>{row.source === 'device' ? <><Cpu size={13} /> {row.deviceName}</> : row.fileName}<small className="table-sub">{row.createdByName ?? 'جهاز'}</small></td>
            <td>{formatDateTime(row.createdAt)}</td><td>{row.rowsImported}</td><td>{row.rowsDuplicate}</td>
            <td className={row.rowsUnmatched ? 'num-warn' : ''}>{row.rowsUnmatched}</td><td className={row.rowsInvalid ? 'num-bad' : ''}>{row.rowsInvalid}</td>
          </tr>)}</tbody>
        </table></div> : <Empty icon={<FileUp size={22} />} title="لم تُستورد ملفات بعد" text="ابدأ برفع تصدير الشهر الحالي من جهاز البصمة." />}
      </section>
      <section className="panel">
        <div className="panel-head"><div><h3>أرقام بصمة غير مربوطة</h3><p>بصمات وصلت برقم لا يطابق أي موظف. اربطها لتدخل في الحضور.</p></div></div>
        {unmatched.data.length ? <div className="table-scroll"><table className="dense">
          <thead><tr><th>رقم البصمة</th><th>عدد البصمات</th><th>الفترة</th><th /></tr></thead>
          <tbody>{unmatched.data.map((row) => <tr key={row.pin}>
            <td dir="ltr"><span className="code-tag">{row.pin}</span></td><td>{row.punches}</td><td>{row.firstSeen} → {row.lastSeen}</td>
            <td><button className="text-button" onClick={() => setAssigning(row.pin)}><Link2 size={13} />ربط بموظف</button></td>
          </tr>)}</tbody>
        </table></div> : <Empty icon={<Fingerprint size={22} />} title="كل البصمات مربوطة" text="جميع أرقام البصمة الواردة تطابق موظفين." />}
      </section>
      <Dialog open={Boolean(assigning)} title={`ربط رقم البصمة ${assigning ?? ''}`} subtitle="يُحفظ الرقم في ملف الموظف وتُضاف بصماته السابقة إلى حضوره." onClose={() => setAssigning(null)}>
        <EmployeePicker label="الموظف" value={assignee} onChange={setAssignee} />
        <div className="dialog-actions"><button className="button button-primary" disabled={!assignee} onClick={() => void assign()}>ربط</button><button className="button button-quiet" onClick={() => setAssigning(null)}>إلغاء</button></div>
      </Dialog>
    </div>
  );
}

function ShiftsView({ canManage }: { canManage: boolean }) {
  const session = useSession();
  const shifts = useLoad<Shift[]>('/attendance/shifts', []);
  const [editing, setEditing] = useState<Shift | 'new' | null>(null);
  const current = editing && editing !== 'new' ? editing : null;
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 6]);

  function open(shift: Shift | 'new') {
    setDays(shift === 'new' ? [0, 1, 2, 3, 4, 6] : shift.workingDays);
    setEditing(shift);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      name: form.get('name'), startTime: form.get('startTime'), endTime: form.get('endTime'),
      breakMinutes: Number(form.get('breakMinutes')), graceMinutes: Number(form.get('graceMinutes')),
      earlyLeaveGraceMinutes: Number(form.get('earlyLeaveGraceMinutes')), workingDays: days,
      isDefault: form.get('isDefault') === 'on',
    };
    if (!current) body.code = form.get('code');
    else body.isActive = form.get('isActive') === 'on';
    try {
      await session.call(current ? `/attendance/shifts/${current.id}` : '/attendance/shifts', { method: current ? 'PUT' : 'POST', body });
      session.notify('تم حفظ الدوام.');
      setEditing(null);
      shifts.reload();
    } catch (error) {
      session.fail(error, 'تعذر حفظ الدوام.');
    }
  }

  return (
    <section className="panel">
      <div className="panel-head"><div><h3>الدوامات</h3><p>الموظف بدون دوام لا يخضع لاحتساب الحضور ولا تُخصم منه أيام غياب. الدوام الليلي يُسجل بوقت نهاية أصغر من البداية.</p></div>
        {canManage && <button className="button button-primary" onClick={() => open('new')}><Plus size={16} />دوام جديد</button>}</div>
      {shifts.loading ? <Loading /> : shifts.data.length ? <div className="table-scroll"><table>
        <thead><tr><th>الدوام</th><th>الوقت</th><th>الاستراحة</th><th>سماح التأخير</th><th>أيام العمل</th><th>الموظفون</th><th>الحالة</th>{canManage && <th />}</tr></thead>
        <tbody>{shifts.data.map((shift) => <tr key={shift.id}>
          <td><strong>{shift.name}</strong><small className="table-sub">{shift.code}{shift.isDefault ? ' · الافتراضي' : ''}</small></td>
          <td dir="ltr">{shift.startTime} – {shift.endTime}{shift.endTime <= shift.startTime ? ' (+1)' : ''}</td>
          <td>{shift.breakMinutes} د</td><td>{shift.graceMinutes} د</td>
          <td className="wrap">{shift.workingDays.map((day) => WEEKDAYS[day]).join('، ')}</td>
          <td>{shift.employeeCount}</td>
          <td><Tone tone={shift.isActive ? 'good' : 'muted'}>{shift.isActive ? 'نشط' : 'معطل'}</Tone></td>
          {canManage && <td><button className="text-button" onClick={() => open(shift)}>تعديل</button></td>}
        </tr>)}</tbody>
      </table></div> : <Empty icon={<Clock3 size={22} />} title="لا توجد دوامات" text="عرّف الدوام الصباحي والمسائي ثم أسندهما للموظفين." action={canManage ? 'دوام جديد' : undefined} onAction={() => open('new')} />}
      <Dialog open={editing !== null} title={current ? `تعديل ${current.name}` : 'دوام جديد'} onClose={() => setEditing(null)}>
        <form onSubmit={submit} key={current?.id ?? 'new'}>
          <div className="form-grid form-grid-2">
            <label className="field"><span>الاسم *</span><input name="name" required maxLength={120} defaultValue={current?.name} placeholder="الدوام الصباحي" /></label>
            <label className="field"><span>الرمز *</span><input name="code" required={!current} disabled={Boolean(current)} dir="ltr" maxLength={24} pattern="[A-Za-z0-9._\-]+" defaultValue={current?.code} placeholder="MORNING" /></label>
            <label className="field"><span>البداية *</span><input name="startTime" type="time" required defaultValue={current?.startTime ?? '08:00'} /></label>
            <label className="field"><span>النهاية *</span><input name="endTime" type="time" required defaultValue={current?.endTime ?? '16:00'} /></label>
            <label className="field"><span>الاستراحة (دقيقة)</span><input name="breakMinutes" type="number" min={0} max={480} defaultValue={current?.breakMinutes ?? 30} /></label>
            <label className="field"><span>سماح التأخير (دقيقة)</span><input name="graceMinutes" type="number" min={0} max={240} defaultValue={current?.graceMinutes ?? 10} /><small>بعد تجاوزه يُحتسب التأخير كاملاً من بداية الدوام.</small></label>
            <label className="field"><span>سماح الخروج المبكر (دقيقة)</span><input name="earlyLeaveGraceMinutes" type="number" min={0} max={240} defaultValue={current?.earlyLeaveGraceMinutes ?? 5} /></label>
            <div className="working-days settings-wide"><span className="field-caption">أيام العمل</span>{WEEKDAYS.map((label, day) => <label className="settings-check" key={day}><input type="checkbox" checked={days.includes(day)} onChange={(event) => setDays(event.target.checked ? [...days, day].sort() : days.filter((item) => item !== day))} />{label}</label>)}</div>
            <label className="settings-check"><input type="checkbox" name="isDefault" defaultChecked={current?.isDefault} />الدوام الافتراضي للموظفين الجدد</label>
            {current && <label className="settings-check"><input type="checkbox" name="isActive" defaultChecked={current.isActive} />نشط</label>}
          </div>
          <div className="dialog-actions"><button className="button button-primary" disabled={!days.length}>حفظ</button><button type="button" className="button button-quiet" onClick={() => setEditing(null)}>إلغاء</button></div>
        </form>
      </Dialog>
    </section>
  );
}

function DevicesView({ branches, canManage }: { branches: Array<{ id: string; name: string }>; canManage: boolean }) {
  const session = useSession();
  const devices = useLoad<Array<{ id: string; name: string; serialNo: string; branchId: string | null; branchName: string | null; ipAllowlist: string | null; isActive: boolean; lastSeenAt: string | null; lastPunchAt: string | null }>>('/attendance/devices', []);
  const [editing, setEditing] = useState<(typeof devices.data)[number] | 'new' | null>(null);
  const current = editing && editing !== 'new' ? editing : null;
  const serverAddress = window.location.host;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      name: form.get('name'), serialNo: form.get('serialNo'), branchId: form.get('branchId') || null,
      ipAllowlist: String(form.get('ipAllowlist') || '') || null,
    };
    if (current) body.isActive = form.get('isActive') === 'on';
    try {
      await session.call(current ? `/attendance/devices/${current.id}` : '/attendance/devices', { method: current ? 'PUT' : 'POST', body });
      session.notify('تم حفظ الجهاز.');
      setEditing(null);
      devices.reload();
    } catch (error) {
      session.fail(error, 'تعذر حفظ الجهاز.');
    }
  }

  const online = (date: string | null) => date && Date.now() - new Date(date).getTime() < 15 * 60000;

  return (
    <section className="panel">
      <div className="panel-head"><div><h3>أجهزة البصمة المتصلة</h3><p>أجهزة ZKTeco التي ترسل البصمات مباشرة إلى الخادم (Cloud / ADMS).</p></div>
        {canManage && <button className="button button-primary" onClick={() => setEditing('new')}><Plus size={16} />تسجيل جهاز</button>}</div>
      <div className="panel-pad"><Warning title="إعداد الجهاز">
        من قائمة الجهاز: Comm → Cloud Server Setting، ضع عنوان الخادم <b dir="ltr">{serverAddress.split(':')[0]}</b> والمنفذ <b dir="ltr">{window.location.port || (window.location.protocol === 'https:' ? '443' : '80')}</b>. يقبل الخادم الأجهزة المسجلة هنا فقط، ويُنصح بتحديد عناوين IP الفرع أو ربط الفروع بالخادم عبر VPN.
      </Warning></div>
      {devices.loading ? <Loading /> : devices.data.length ? <div className="table-scroll"><table>
        <thead><tr><th>الجهاز</th><th>الرقم التسلسلي</th><th>الفرع</th><th>آخر اتصال</th><th>آخر بصمة</th><th>الحالة</th>{canManage && <th />}</tr></thead>
        <tbody>{devices.data.map((device) => <tr key={device.id}>
          <td><strong>{device.name}</strong>{device.ipAllowlist && <small className="table-sub" dir="ltr">{device.ipAllowlist}</small>}</td>
          <td dir="ltr"><span className="code-tag">{device.serialNo}</span></td>
          <td>{device.branchName ?? '—'}</td>
          <td>{device.lastSeenAt ? <>{online(device.lastSeenAt) ? <Tone tone="good">متصل</Tone> : <Tone tone="warn">منقطع</Tone>}<small className="table-sub">{formatDateTime(device.lastSeenAt)}</small></> : 'لم يتصل بعد'}</td>
          <td dir="ltr">{device.lastPunchAt?.replace('T', ' ') ?? '—'}</td>
          <td><Tone tone={device.isActive ? 'good' : 'muted'}>{device.isActive ? 'مفعّل' : 'معطل'}</Tone></td>
          {canManage && <td><button className="text-button" onClick={() => setEditing(device)}>تعديل</button></td>}
        </tr>)}</tbody>
      </table></div> : <Empty icon={<Cpu size={22} />} title="لا توجد أجهزة مسجلة" text="سجّل أجهزة الفروع بأرقامها التسلسلية لتستقبل بصماتها مباشرة، أو استخدم استيراد الملفات." action={canManage ? 'تسجيل جهاز' : undefined} onAction={() => setEditing('new')} />}
      <Dialog open={editing !== null} title={current ? `تعديل ${current.name}` : 'تسجيل جهاز بصمة'} onClose={() => setEditing(null)}>
        <form onSubmit={submit} key={current?.id ?? 'new'}>
          <div className="form-grid form-grid-2">
            <label className="field"><span>اسم الجهاز *</span><input name="name" required maxLength={120} defaultValue={current?.name} placeholder="بصمة فرع الكرادة - المدخل" /></label>
            <label className="field"><span>الرقم التسلسلي (SN) *</span><input name="serialNo" required dir="ltr" maxLength={60} pattern="[A-Za-z0-9_\-]+" defaultValue={current?.serialNo} /></label>
            <label className="field"><span>الفرع</span><select name="branchId" defaultValue={current?.branchId ?? ''}><option value="">—</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
            <label className="field"><span>عناوين IP المسموحة</span><input name="ipAllowlist" dir="ltr" maxLength={400} defaultValue={current?.ipAllowlist ?? ''} placeholder="185.12.4.20, 10.10.0.0/16" /><small>اتركه فارغاً للقبول من أي عنوان.</small></label>
            {current && <label className="settings-check"><input type="checkbox" name="isActive" defaultChecked={current.isActive} />مفعّل</label>}
          </div>
          <div className="dialog-actions"><button className="button button-primary">حفظ</button><button type="button" className="button button-quiet" onClick={() => setEditing(null)}>إلغاء</button></div>
        </form>
      </Dialog>
    </section>
  );
}
