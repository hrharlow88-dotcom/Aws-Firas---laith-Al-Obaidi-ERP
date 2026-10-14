import { FormEvent, useState } from 'react';
import {
  AlertTriangle, ArrowRight, Calculator, Check, ChevronDown, ChevronLeft, Download, FileSpreadsheet, Landmark, Plus,
  Printer, RotateCcw, Trash2, Upload, Wallet, X,
} from 'lucide-react';
import { EmployeePicker, PickedEmployee } from '../components/EmployeePicker';
import { Dialog, Empty, Loading, Stat, StatusTag, Tabs, Tone, Warning, useReasonPrompt } from '../components/ui';
import { ApiError, downloadFile } from '../lib/api';
import {
  JOURNAL_STATUS, RUN_STATUS, WARNING_LABELS, currentPeriod, formatDateTime, formatMinutes, formatMoney, formatNumber,
  monthLabel, previousPeriod,
} from '../lib/format';
import { navigate } from '../lib/router';
import { useLoad, useSession } from '../lib/session';

interface RunSummary {
  id: string; period: string; status: string; currency: string; branchId: string | null; branchName: string | null;
  employeeCount: number; totalEarnings: number; totalDeductions: number; totalNet: number; warningCount: number;
  calculatedAt: string | null; approvedAt: string | null; postedAt: string | null; createdByName: string;
  calculatedByName: string | null; approvedByName: string | null; journalStatus: string | null;
}

interface Item { componentId: string; name: string; amount: number; basis: string }
interface Line {
  employeeId: string; employeeNo: string; employeeName: string; branchName: string; department: string;
  grossSalary: number; employedDays: number; presentDays: number; absentDays: number; unpaidLeaveDays: number;
  lateMinutes: number; overtimeMinutes: number; attendanceTracked: boolean; earnings: Item[]; deductions: Item[];
  totalEarnings: number; totalDeductions: number; netPay: number; paymentMethod: string;
  warnings: Array<{ code: string; blocking: boolean; detail?: string }>;
}
interface RunDetail extends RunSummary {
  startsOn: string; endsOn: string; notes: string | null; cancelledReason: string | null; createdBy: string;
  calculatedBy: string | null; lines: Line[]; journalId: string | null;
}

type Tab = 'runs' | 'inputs';

export function PayrollPage({ runId, branches }: { runId?: string; branches: Array<{ id: string; name: string }> }) {
  const [tab, setTab] = useState<Tab>('runs');
  if (runId) return <RunView runId={runId} />;
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2>الرواتب</h2><p>مسير شهري لكل فرع وعملة. يُعد ويحتسب من الموارد البشرية، ويعتمده شخص آخر، ثم يُرحّل قيده إلى SAP.</p></div></div>
      <Tabs<Tab> value={tab} onChange={setTab} items={[{ id: 'runs', label: 'المسيرات' }, { id: 'inputs', label: 'المبالغ المتغيرة' }]} />
      {tab === 'runs' && <RunsList branches={branches} />}
      {tab === 'inputs' && <InputsView />}
    </section>
  );
}

function RunsList({ branches }: { branches: Array<{ id: string; name: string }> }) {
  const session = useSession();
  const runs = useLoad<RunSummary[]>('/payroll/runs', []);
  const [creating, setCreating] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await session.call<{ data: { id: string } }>('/payroll/runs', {
        body: { period: form.get('period'), branchId: form.get('branchId') || null, currency: form.get('currency'), notes: String(form.get('notes') || '') || null },
      });
      session.notify('أُنشئ المسير. احسبه الآن لمراجعة الرواتب.');
      navigate('payroll', result.data.id);
    } catch (error) {
      session.fail(error, 'تعذر إنشاء المسير.');
    }
  }

  return (
    <section className="panel">
      <div className="panel-head"><div><h3>مسيرات الرواتب</h3><p>{runs.data.length} مسير</p></div>
        {session.can('payroll.prepare') && <button className="button button-primary" onClick={() => setCreating(true)}><Plus size={16} />مسير جديد</button>}</div>
      {runs.loading ? <Loading /> : runs.data.length ? <div className="table-scroll"><table>
        <thead><tr><th>الشهر</th><th>النطاق</th><th>الحالة</th><th>الموظفون</th><th>الإجمالي</th><th>الصافي</th><th>المالية</th><th /></tr></thead>
        <tbody>{runs.data.map((run) => <tr key={run.id} className={run.status === 'cancelled' ? 'row-muted' : ''}>
          <td><strong>{monthLabel(run.period)}</strong><small className="table-sub">{run.currency}</small></td>
          <td>{run.branchName ?? 'كل الفروع'}</td>
          <td><StatusTag map={RUN_STATUS} value={run.status} />{run.warningCount > 0 && run.status === 'calculated' && <small className="table-sub warn-text">{run.warningCount} تنبيه</small>}</td>
          <td>{formatNumber(run.employeeCount)}</td>
          <td>{formatMoney(run.totalEarnings, run.currency)}</td>
          <td><strong>{formatMoney(run.totalNet, run.currency)}</strong></td>
          <td>{run.journalStatus ? <StatusTag map={JOURNAL_STATUS} value={run.journalStatus} /> : '—'}</td>
          <td><button className="text-button" onClick={() => navigate('payroll', run.id)}>فتح<ChevronLeft size={14} /></button></td>
        </tr>)}</tbody>
      </table></div> : <Empty icon={<Wallet size={22} />} title="لا توجد مسيرات بعد" text="سجّل رواتب الموظفين من ملفاتهم، ثم أنشئ مسير الشهر." action={session.can('payroll.prepare') ? 'مسير جديد' : undefined} onAction={() => setCreating(true)} />}
      <Dialog open={creating} title="مسير رواتب جديد" subtitle="يشمل الموظفين الذين لهم راتب بالعملة المختارة ولم يدخلوا مسيراً آخر لنفس الشهر." onClose={() => setCreating(false)}>
        <form onSubmit={create}>
          <div className="form-grid form-grid-2">
            <label className="field"><span>الشهر *</span><input name="period" type="month" required defaultValue={previousPeriod()} max={currentPeriod()} /></label>
            <label className="field"><span>العملة</span><select name="currency" defaultValue={session.settings.payrollRules.baseCurrency}><option value="IQD">دينار عراقي</option><option value="USD">دولار أمريكي</option></select></label>
            <label className="field"><span>الفرع</span><select name="branchId" defaultValue=""><option value="">كل الفروع</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
            <label className="field"><span>ملاحظة</span><input name="notes" maxLength={1000} /></label>
          </div>
          <div className="dialog-actions"><button className="button button-primary">إنشاء</button><button type="button" className="button button-quiet" onClick={() => setCreating(false)}>إلغاء</button></div>
        </form>
      </Dialog>
    </section>
  );
}

function RunView({ runId }: { runId: string }) {
  const session = useSession();
  const run = useLoad<RunDetail | null>(`/payroll/runs/${runId}`, null);
  const [busy, setBusy] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'warnings'>('all');
  const reason = useReasonPrompt();
  const data = run.data;

  async function act(action: string, label: string, body?: unknown) {
    setBusy(action);
    try {
      await session.call(`/payroll/runs/${runId}/${action}`, { method: 'POST', body: body ?? {} });
      session.notify(label);
      run.reload();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && action === 'approve') {
        session.notify(error.message, true);
      } else {
        session.fail(error, 'تعذر تنفيذ الإجراء.');
      }
    } finally {
      setBusy('');
    }
  }

  async function createJournal() {
    setBusy('journal');
    try {
      const result = await session.call<{ data: { id: string } }>(`/finance/journals/from-payroll/${runId}`, { method: 'POST' });
      session.notify('أُنشئ قيد الرواتب. راجعه ثم رحّله إلى SAP.');
      navigate('finance', 'journal', result.data.id);
    } catch (error) {
      session.fail(error, 'تعذر إنشاء القيد.');
    } finally {
      setBusy('');
    }
  }

  if (run.loading && !data) return <section className="screen"><Loading /></section>;
  if (!data) return <section className="screen"><Empty icon={<Wallet size={22} />} title="المسير غير موجود" text="" /></section>;

  const blocking = data.lines.filter((line) => line.warnings.some((warning) => warning.blocking));
  const withWarnings = data.lines.filter((line) => line.warnings.length);
  const isPreparer = data.calculatedBy === session.user.id || data.createdBy === session.user.id;
  const lines = filter === 'warnings' ? withWarnings : data.lines;
  const totals = data.lines.reduce((sum, line) => ({
    absent: sum.absent + line.absentDays + line.unpaidLeaveDays, overtime: sum.overtime + line.overtimeMinutes,
  }), { absent: 0, overtime: 0 });

  return (
    <section className="screen">
      <button className="back-link" onClick={() => navigate('payroll')}><ArrowRight size={15} />كل المسيرات</button>
      <div className="screen-heading">
        <div><h2>رواتب {monthLabel(data.period)} {data.branchName ? `— ${data.branchName}` : '— كل الفروع'}</h2>
          <p><StatusTag map={RUN_STATUS} value={data.status} /> · {data.currency} · أعده {data.createdByName}{data.calculatedByName ? ` · احتسبه ${data.calculatedByName} ${formatDateTime(data.calculatedAt)}` : ''}{data.approvedByName ? ` · اعتمده ${data.approvedByName}` : ''}</p></div>
        <div className="heading-actions">
          {['draft', 'calculated'].includes(data.status) && session.can('payroll.prepare') && <button className="button button-quiet" disabled={Boolean(busy)} onClick={() => void act('calculate', 'تم احتساب المسير.')}><Calculator size={16} />{busy === 'calculate' ? 'جارٍ الاحتساب…' : data.status === 'draft' ? 'احتساب' : 'إعادة احتساب'}</button>}
          {data.status === 'calculated' && session.can('payroll.approve') && <button className="button button-primary" disabled={Boolean(busy) || isPreparer || blocking.length > 0} title={isPreparer ? 'يعتمد المسير شخص غير الذي أعده' : undefined} onClick={() => void act('approve', 'تم اعتماد المسير وقفل حضور الشهر.')}><Check size={16} />{busy === 'approve' ? 'جارٍ التحقق…' : 'اعتماد'}</button>}
          {data.status === 'approved' && session.can('finance.post') && !data.journalId && <button className="button button-primary" disabled={Boolean(busy)} onClick={() => void createJournal()}><Landmark size={16} />إنشاء قيد SAP</button>}
          {data.journalId && session.can('finance.view') && <button className="button button-quiet" onClick={() => navigate('finance', 'journal', data.journalId!)}><Landmark size={16} />القيد · {JOURNAL_STATUS[data.journalStatus ?? '']?.label ?? ''}</button>}
          {data.status !== 'draft' && data.status !== 'cancelled' && <button className="button button-quiet" onClick={() => void downloadFile(`/payroll/runs/${runId}/register.xlsx`, session.token, `payroll-${data.period}.xlsx`).catch((error) => session.fail(error, 'تعذر التصدير.'))}><FileSpreadsheet size={16} />كشف Excel</button>}
          {['approved', 'posted'].includes(data.status) && session.can('compensation.view') && <button className="button button-quiet" onClick={() => void downloadFile(`/payroll/runs/${runId}/bank.csv`, session.token, `bank-${data.period}.csv`).catch((error) => session.fail(error, 'تعذر التصدير.'))}><Download size={16} />ملف المصرف</button>}
          {data.status === 'approved' && session.can('payroll.approve') && <button className="button button-quiet" onClick={() => void reason.ask('سبب إعادة فتح المسير').then((value) => { if (value) void act('reopen', 'أُعيد فتح المسير.', { reason: value }); })}><RotateCcw size={16} />إعادة فتح</button>}
          {['draft', 'calculated'].includes(data.status) && session.can('payroll.prepare') && <button className="button button-quiet danger" onClick={() => void reason.ask('سبب إلغاء المسير').then((value) => { if (value) void act('cancel', 'أُلغي المسير.', { reason: value }); })}><X size={16} />إلغاء</button>}
        </div>
      </div>

      {data.status === 'calculated' && isPreparer && session.can('payroll.approve') && <Warning title="فصل المهام">لا يمكنك اعتماد مسير أعددته أو احتسبته. يعتمده مستخدم آخر بصلاحية الاعتماد (مثلاً المالية).</Warning>}
      {blocking.length > 0 && <Warning title={`${blocking.length} موظف يمنعون الاعتماد`}>صافي سالب أو أجر يومي بلا حضور. صحح المبالغ المتغيرة أو بيانات الموظف ثم أعد الاحتساب.</Warning>}
      {data.status === 'cancelled' && <Warning title="مسير ملغى">{data.cancelledReason}</Warning>}

      {data.status !== 'draft' && <div className="stat-row">
        <Stat label="الموظفون" value={formatNumber(data.employeeCount)} />
        <Stat label="مجموع الاستحقاقات" value={formatMoney(data.totalEarnings, data.currency)} />
        <Stat label="مجموع الاستقطاعات" value={formatMoney(data.totalDeductions, data.currency)} />
        <Stat label="صافي الرواتب" value={formatMoney(data.totalNet, data.currency)} tone="good" />
        <Stat label="أيام غياب وبدون راتب" value={formatNumber(totals.absent)} foot={`إضافي ${formatMinutes(totals.overtime)}`} />
      </div>}

      <section className="panel">
        {data.status === 'draft' ? <Empty icon={<Calculator size={22} />} title="المسير لم يُحتسب بعد" text="الاحتساب يعيد حساب حضور الشهر ثم يبني قسيمة لكل موظف. يمكنك إعادة الاحتساب حتى الاعتماد." /> : <>
          <div className="filter-bar">
            <Tabs<'all' | 'warnings'> value={filter} onChange={setFilter} items={[{ id: 'all', label: 'كل الموظفين', badge: data.lines.length }, { id: 'warnings', label: 'بتنبيهات', badge: withWarnings.length }]} />
          </div>
          <div className="table-scroll"><table className="dense payroll-table">
            <thead><tr><th /><th>الموظف</th><th>الراتب الكلي</th><th>أيام</th><th>غياب</th><th>الاستحقاقات</th><th>الاستقطاعات</th><th>الصافي</th><th /></tr></thead>
            <tbody>{lines.map((line) => <PayrollRow key={line.employeeId} line={line} currency={data.currency} runId={runId} open={expanded === line.employeeId} onToggle={() => setExpanded(expanded === line.employeeId ? null : line.employeeId)} />)}</tbody>
          </table></div>
        </>}
      </section>
      {reason.element}
    </section>
  );
}

function PayrollRow({ line, currency, runId, open, onToggle }: { line: Line; currency: string; runId: string; open: boolean; onToggle: () => void }) {
  const blocking = line.warnings.some((warning) => warning.blocking);
  return <>
    <tr className={blocking ? 'row-danger' : ''}>
      <td><button className="icon-button" aria-label="التفاصيل" onClick={onToggle}>{open ? <ChevronDown size={15} /> : <ChevronLeft size={15} />}</button></td>
      <td><strong>{line.employeeName}</strong><small className="table-sub">{line.employeeNo} · {line.department}</small>
        {line.warnings.map((warning) => <small key={warning.code} className={`table-sub ${warning.blocking ? 'bad-text' : 'warn-text'}`}><AlertTriangle size={11} /> {WARNING_LABELS[warning.code] ?? warning.code}{warning.detail ? `: ${warning.detail}` : ''}</small>)}</td>
      <td>{formatMoney(line.grossSalary, currency)}</td>
      <td>{line.employedDays}{!line.attendanceTracked && <small className="table-sub">بدون بصمة</small>}</td>
      <td className={line.absentDays + line.unpaidLeaveDays ? 'num-bad' : ''}>{line.absentDays + line.unpaidLeaveDays || '—'}</td>
      <td>{formatMoney(line.totalEarnings, currency)}</td>
      <td>{formatMoney(line.totalDeductions, currency)}</td>
      <td><strong>{formatMoney(line.netPay, currency)}</strong></td>
      <td><button className="icon-link" aria-label="القسيمة" onClick={() => navigate('payslip', runId, line.employeeId)}><Printer size={14} /></button></td>
    </tr>
    {open && <tr className="row-detail"><td /><td colSpan={8}>
      <div className="payslip-mini">
        <div><h4>الاستحقاقات</h4>{line.earnings.map((item) => <p key={item.componentId}><span>{item.name}<small>{item.basis}</small></span><b>{formatMoney(item.amount, currency)}</b></p>)}</div>
        <div><h4>الاستقطاعات</h4>{line.deductions.length ? line.deductions.map((item) => <p key={item.componentId}><span>{item.name}<small>{item.basis}</small></span><b>{formatMoney(item.amount, currency)}</b></p>) : <p><span>لا يوجد</span></p>}</div>
        <div><h4>الحضور</h4><p><span>حضور</span><b>{line.attendanceTracked ? line.presentDays : '—'}</b></p><p><span>غياب</span><b>{line.absentDays}</b></p><p><span>بدون راتب</span><b>{line.unpaidLeaveDays}</b></p><p><span>تأخير وخروج مبكر</span><b>{formatMinutes(line.lateMinutes)}</b></p><p><span>إضافي</span><b>{formatMinutes(line.overtimeMinutes)}</b></p></div>
      </div>
    </td></tr>}
  </>;
}

function InputsView() {
  const session = useSession();
  const [period, setPeriod] = useState(currentPeriod());
  const inputs = useLoad<Array<{ id: string; employeeId: string; employeeNo: string; employeeName: string; componentId: string; amount: number; note: string | null; createdAt: string; createdByName: string }>>(`/payroll/inputs?period=${period}`, []);
  const manual = session.settings.payrollRules.components.filter((item) => item.calculation === 'manual' && item.active);
  const canEdit = session.can('payroll.prepare');
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [importErrors, setImportErrors] = useState<Array<{ row: number; message: string }>>([]);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!employee) return;
    const form = new FormData(event.currentTarget);
    try {
      await session.call('/payroll/inputs', { body: { period, employeeId: employee.id, componentId: form.get('componentId'), amount: Number(form.get('amount')), note: String(form.get('note') || '') || null } });
      session.notify('أُضيف المبلغ.');
      setEmployee(null);
      (event.target as HTMLFormElement).reset();
      inputs.reload();
    } catch (error) {
      session.fail(error, 'تعذرت الإضافة.');
    }
  }

  async function remove(id: string) {
    try {
      await session.call(`/payroll/inputs/${id}`, { method: 'DELETE' });
      inputs.reload();
    } catch (error) {
      session.fail(error, 'تعذر الحذف.');
    }
  }

  async function importFile(file: File) {
    const form = new FormData();
    form.append('period', period);
    form.append('file', file);
    setImportErrors([]);
    try {
      const result = await session.call<{ data: { imported: number } }>('/payroll/inputs/import', { form });
      session.notify(`استُورد ${result.data.imported} مبلغ.`);
      inputs.reload();
    } catch (error) {
      if (error instanceof ApiError && error.details && typeof error.details === 'object' && 'errors' in error.details) {
        setImportErrors((error.details as { errors: Array<{ row: number; message: string }> }).errors);
      }
      session.fail(error, 'تعذر الاستيراد.');
    }
  }

  const total = (id: string) => inputs.data.filter((item) => item.componentId === id).reduce((sum, item) => sum + item.amount, 0);

  return (
    <section className="panel">
      <div className="panel-head"><div><h3>المبالغ المتغيرة للشهر</h3><p>العمولات والمكافآت والسلف والغرامات. تُقفل بعد اعتماد مسير الشهر.</p></div>
        <label className="field inline-field"><span>الشهر</span><input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} /></label></div>
      {canEdit && <form className="toolbar" onSubmit={add}>
        <EmployeePicker label="الموظف" value={employee} onChange={setEmployee} />
        <label className="field"><span>المكوّن</span><select name="componentId" required>{manual.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.category === 'earning' ? 'استحقاق' : 'استقطاع'})</option>)}</select></label>
        <label className="field"><span>المبلغ</span><input name="amount" type="number" min={0.01} step="0.01" required /></label>
        <label className="field"><span>ملاحظة</span><input name="note" maxLength={500} /></label>
        <button className="button button-primary toolbar-action" disabled={!employee}><Plus size={15} />إضافة</button>
        <label className="button button-quiet toolbar-action file-button"><Upload size={15} />استيراد Excel<input type="file" accept=".xlsx" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} /></label>
      </form>}
      {canEdit && <p className="hint">ملف Excel بالأعمدة: رقم الموظف · اسم المكوّن كما في الإعدادات · المبلغ · ملاحظة. إن وُجد خطأ في أي سطر لا يُحفظ شيء.</p>}
      {importErrors.length > 0 && <div className="panel-pad"><Warning title="أخطاء في الملف">{importErrors.slice(0, 10).map((item) => `سطر ${item.row}: ${item.message}`).join(' · ')}</Warning></div>}
      {manual.length > 0 && inputs.data.length > 0 && <div className="chips">{manual.filter((item) => total(item.id)).map((item) => <span key={item.id} className="chip">{item.name}: <b>{formatNumber(total(item.id), 2)}</b></span>)}</div>}
      {inputs.loading ? <Loading /> : inputs.data.length ? <div className="table-scroll"><table className="dense">
        <thead><tr><th>الموظف</th><th>المكوّن</th><th>المبلغ</th><th>ملاحظة</th><th>أدخله</th>{canEdit && <th />}</tr></thead>
        <tbody>{inputs.data.map((row) => <tr key={row.id}>
          <td><strong>{row.employeeName}</strong><small className="table-sub">{row.employeeNo}</small></td>
          <td>{session.settings.payrollRules.components.find((item) => item.id === row.componentId)?.name}</td>
          <td><strong>{formatNumber(row.amount, 2)}</strong></td>
          <td className="wrap">{row.note || '—'}</td>
          <td>{row.createdByName}<small className="table-sub">{formatDateTime(row.createdAt)}</small></td>
          {canEdit && <td><button className="icon-link danger" aria-label="حذف" onClick={() => void remove(row.id)}><Trash2 size={14} /></button></td>}
        </tr>)}</tbody>
      </table></div> : <Empty icon={<Wallet size={22} />} title="لا توجد مبالغ لهذا الشهر" text="أضف العمولات والسلف قبل احتساب المسير." />}
    </section>
  );
}

interface Payslip {
  company: { displayName: string; legalName: string; address: string; phone: string };
  period: string; status: string; currency: string; employeeNo: string; employeeName: string; branchName: string;
  department: string; position: string; grossSalary: number; periodDays: number; employedDays: number; presentDays: number;
  absentDays: number; unpaidLeaveDays: number; lateMinutes: number; overtimeMinutes: number; attendanceTracked: boolean;
  earnings: Item[]; deductions: Item[]; totalEarnings: number; totalDeductions: number; netPay: number;
  paymentMethod: string; bankName: string | null; bankAccountTail: string | null;
}

export function PayslipPage({ runId, employeeId }: { runId: string; employeeId: string }) {
  const slip = useLoad<Payslip | null>(`/payroll/runs/${runId}/payslips/${employeeId}`, null);
  const data = slip.data;
  if (slip.loading && !data) return <section className="screen"><Loading /></section>;
  if (!data) return null;
  const rows = Math.max(data.earnings.length, data.deductions.length);
  return (
    <section className="screen">
      <div className="no-print screen-heading">
        <button className="back-link" onClick={() => window.history.back()}><ArrowRight size={15} />رجوع</button>
        <button className="button button-primary" onClick={() => window.print()}><Printer size={16} />طباعة / حفظ PDF</button>
      </div>
      <article className="payslip print-area">
        <header className="payslip-head">
          <img src="/brand/wordmark-900.png" alt={data.company.displayName} className="payslip-wordmark" />
          <img src="/brand/shield-256.png" alt="" className="payslip-shield" />
        </header>
        <div className="payslip-title"><h2>قسيمة راتب — {monthLabel(data.period)}</h2>{data.status !== 'approved' && data.status !== 'posted' && <Tone tone="warn">غير معتمدة</Tone>}</div>
        <dl className="payslip-meta">
          <div><dt>الاسم</dt><dd>{data.employeeName}</dd></div>
          <div><dt>الرقم الوظيفي</dt><dd dir="ltr">{data.employeeNo}</dd></div>
          <div><dt>القسم</dt><dd>{data.department}</dd></div>
          <div><dt>المسمى</dt><dd>{data.position}</dd></div>
          <div><dt>الفرع</dt><dd>{data.branchName}</dd></div>
          <div><dt>الراتب الكلي</dt><dd>{formatMoney(data.grossSalary, data.currency)}</dd></div>
          <div><dt>أيام الخدمة</dt><dd>{data.employedDays} من {data.periodDays}</dd></div>
          <div><dt>طريقة الدفع</dt><dd>{data.paymentMethod === 'bank' ? `مصرف ${data.bankName ?? ''}${data.bankAccountTail ? ` ••••${data.bankAccountTail}` : ''}` : data.paymentMethod === 'wallet' ? 'محفظة إلكترونية' : 'نقداً'}</dd></div>
        </dl>
        <table className="payslip-table">
          <thead><tr><th>الاستحقاقات</th><th>المبلغ</th><th>الاستقطاعات</th><th>المبلغ</th></tr></thead>
          <tbody>{Array.from({ length: rows }, (_, index) => {
            const earning = data.earnings[index];
            const deduction = data.deductions[index];
            return <tr key={index}>
              <td>{earning ? <>{earning.name}<small>{earning.basis}</small></> : ''}</td><td>{earning ? formatMoney(earning.amount, data.currency) : ''}</td>
              <td>{deduction ? <>{deduction.name}<small>{deduction.basis}</small></> : ''}</td><td>{deduction ? formatMoney(deduction.amount, data.currency) : ''}</td>
            </tr>;
          })}</tbody>
          <tfoot><tr><th>المجموع</th><th>{formatMoney(data.totalEarnings, data.currency)}</th><th>المجموع</th><th>{formatMoney(data.totalDeductions, data.currency)}</th></tr></tfoot>
        </table>
        <div className="payslip-net"><span>صافي الراتب</span><strong>{formatMoney(data.netPay, data.currency)}</strong></div>
        {data.attendanceTracked && <p className="payslip-attendance">الحضور: {data.presentDays} يوم · الغياب: {data.absentDays} · بدون راتب: {data.unpaidLeaveDays} · التأخير: {formatMinutes(data.lateMinutes)} · الإضافي: {formatMinutes(data.overtimeMinutes)}</p>}
        <footer className="payslip-foot"><span>{data.company.legalName || data.company.displayName}</span><span>{data.company.address}</span><span>وثيقة صادرة من نظام الإدارة · لا تحتاج توقيعاً</span></footer>
        <div className="payslip-stripe" />
      </article>
    </section>
  );
}
