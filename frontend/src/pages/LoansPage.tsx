import { FormEvent, useState } from 'react';
import { CalendarClock, HandCoins, Pencil, Plus, Trash2 } from 'lucide-react';
import { Dialog, Empty, Loading, Stat, Tabs, Tone, useReasonPrompt } from '../components/ui';
import { EmployeePicker, PickedEmployee } from '../components/EmployeePicker';
import { formatMoney, formatNumber, monthLabel, previousPeriod } from '../lib/format';
import { navigate } from '../lib/router';
import { useLoad, useSession } from '../lib/session';

interface Loan {
  id: string; employeeId: string; employeeNo: string; employeeName: string; currency: string; principal: number;
  installment: number; paidBefore: number; installmentsTotal: number | null; installmentsPaid: number; startPeriod: string;
  status: 'active' | 'suspended' | 'closed'; reference: string | null; notes: string | null; repaidByPayroll: number;
  pendingDeduction: number;
  remaining: number; lastPeriod: string | null;
}

const LOAN_STATUS: Record<Loan['status'], { label: string; tone: string }> = {
  active: { label: 'قيد الاستقطاع', tone: 'warn' },
  suspended: { label: 'موقوفة', tone: 'muted' },
  closed: { label: 'مغلقة', tone: 'good' },
};

/** Instalment loans: what was lent, what payroll has taken back, what is left. */
export function LoansPage() {
  const session = useSession();
  const [status, setStatus] = useState<'active' | 'all'>('active');
  const loans = useLoad<Loan[]>(`/payroll/loans${status === 'active' ? '?status=active' : ''}`, []);
  const [creating, setCreating] = useState(false);
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [editing, setEditing] = useState<Loan | null>(null);
  const reason = useReasonPrompt();
  const canEdit = session.can('payroll.prepare');

  const open = loans.data.filter((loan) => loan.status === 'active');
  const owed = (currency: string) => open.filter((loan) => loan.currency === currency).reduce((sum, loan) => sum + Math.max(0, loan.remaining), 0);
  const monthly = (currency: string) => open.filter((loan) => loan.currency === currency && loan.remaining > 0)
    .reduce((sum, loan) => sum + Math.min(loan.installment, loan.remaining), 0);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!employee) return;
    const form = new FormData(event.currentTarget);
    const number = (key: string) => (form.get(key) ? Number(form.get(key)) : undefined);
    try {
      await session.call('/payroll/loans', {
        body: {
          employeeId: employee.id, currency: form.get('currency') || undefined, principal: number('principal'),
          installment: number('installment'), installmentsTotal: number('installmentsTotal'), paidBefore: number('paidBefore') ?? 0,
          startPeriod: form.get('startPeriod'), reference: String(form.get('reference') || '') || null,
          notes: String(form.get('notes') || '') || null,
        },
      });
      session.notify('سُجلت السلفة وستُستقطع أقساطها من المسيرات.');
      setCreating(false);
      setEmployee(null);
      loans.reload();
    } catch (error) {
      session.fail(error, 'تعذر تسجيل السلفة.');
    }
  }

  async function update(loan: Loan, changes: { status?: Loan['status']; installment?: number }) {
    const why = await reason.ask(changes.status === 'closed' ? 'سبب إغلاق السلفة' : changes.status === 'suspended' ? 'سبب إيقاف الاستقطاع' : 'سبب التعديل');
    if (!why) return;
    try {
      await session.call(`/payroll/loans/${loan.id}`, { method: 'PATCH', body: { ...changes, reason: why } });
      session.notify('حُدّثت السلفة.');
      setEditing(null);
      loans.reload();
    } catch (error) {
      session.fail(error, 'تعذر التحديث.');
    }
  }

  return (
    <section className="screen">
      <div className="screen-heading">
        <div><h2>السلف والقروض</h2><p>تُستقطع الأقساط تلقائياً في كل مسير، ولا يتجاوز القسط ما يتبقى من الراتب بعد الاستقطاعات الأخرى.</p></div>
        {canEdit && <div className="heading-actions"><button className="button button-primary" onClick={() => setCreating(true)}><Plus size={16} />سلفة جديدة</button></div>}
      </div>
      <div className="stat-row">
        <Stat label="سلف قيد الاستقطاع" value={formatNumber(open.length)} />
        <Stat label="المتبقي بالدينار" value={formatMoney(owed('IQD'), 'IQD')} foot={`قسط الشهر ${formatMoney(monthly('IQD'), 'IQD')}`} />
        <Stat label="المتبقي بالدولار" value={formatMoney(owed('USD'), 'USD')} foot={`قسط الشهر ${formatMoney(monthly('USD'), 'USD')}`} />
      </div>
      <section className="panel">
        <div className="panel-head"><Tabs<'active' | 'all'> value={status} onChange={setStatus} items={[{ id: 'active', label: 'قيد الاستقطاع' }, { id: 'all', label: 'كل السلف' }]} /></div>
        {loans.loading ? <Loading /> : loans.data.length ? <div className="table-scroll"><table className="dense">
          <thead><tr><th>الموظف</th><th>مبلغ السلفة</th><th>القسط</th><th>الأقساط</th><th>المسدد</th><th>المتبقي</th><th>آخر استقطاع</th><th>الحالة</th>{canEdit && <th />}</tr></thead>
          <tbody>{loans.data.map((loan) => {
            const paid = loan.paidBefore + loan.repaidByPayroll;
            const progress = Math.min(100, Math.round((paid / loan.principal) * 100));
            return <tr key={loan.id}>
              <td><button className="text-button" onClick={() => navigate('employees', loan.employeeId)}><strong>{loan.employeeName}</strong></button><small className="table-sub">{loan.employeeNo}{loan.notes ? ` · ${loan.notes.slice(0, 60)}` : ''}</small></td>
              <td><strong>{formatMoney(loan.principal, loan.currency)}</strong><small className="table-sub">من {monthLabel(loan.startPeriod)}</small></td>
              <td>{formatMoney(loan.installment, loan.currency)}</td>
              <td>{loan.installmentsTotal ? `${formatNumber(loan.installmentsPaid)} من ${formatNumber(loan.installmentsTotal)}` : formatNumber(loan.installmentsPaid)}</td>
              <td><span className="progress" aria-label={`${progress}%`}><i style={{ width: `${progress}%` }} /></span><small className="table-sub">{formatMoney(paid, loan.currency)}</small></td>
              <td><strong className={loan.remaining > 0 ? 'num-warn' : ''}>{formatMoney(Math.max(0, loan.remaining), loan.currency)}</strong>{loan.pendingDeduction > 0 && <small className="table-sub">يُستقطع {formatMoney(loan.pendingDeduction, loan.currency)} بمسير غير معتمد</small>}</td>
              <td>{loan.lastPeriod ? monthLabel(loan.lastPeriod) : '—'}</td>
              <td>{loan.status === 'active' && loan.remaining <= 0.004 ? <Tone tone="good">مسددة</Tone> : <Tone tone={LOAN_STATUS[loan.status].tone}>{LOAN_STATUS[loan.status].label}</Tone>}</td>
              {canEdit && <td><button className="icon-link" aria-label="تعديل" onClick={() => setEditing(loan)}><Pencil size={14} /></button></td>}
            </tr>;
          })}</tbody>
        </table></div> : <Empty icon={<HandCoins size={22} />} title="لا توجد سلف" text="سجّل السلفة هنا وستُستقطع أقساطها من مسيرات الرواتب." />}
      </section>

      <Dialog open={creating} title="سلفة جديدة" subtitle="تبدأ الأقساط من الشهر المحدد. للسلف القديمة أدخل ما سُدد قبل النظام." onClose={() => setCreating(false)}>
        <form onSubmit={create}>
          <div className="form-grid">
            <EmployeePicker label="الموظف *" value={employee} onChange={setEmployee} />
            <label className="field"><span>العملة</span><select name="currency" defaultValue=""><option value="">عملة راتب الموظف</option><option value="IQD">دينار عراقي</option><option value="USD">دولار أمريكي</option></select></label>
            <label className="field"><span>مبلغ السلفة *</span><input name="principal" type="number" min={0.01} step="0.01" required /></label>
            <label className="field"><span>القسط الشهري *</span><input name="installment" type="number" min={0.01} step="0.01" required /></label>
            <label className="field"><span>عدد الأقساط</span><input name="installmentsTotal" type="number" min={1} max={240} step={1} /></label>
            <label className="field"><span>أول شهر استقطاع *</span><input name="startPeriod" type="month" required defaultValue={previousPeriod()} /></label>
            <label className="field"><span>مسدد سابقاً</span><input name="paidBefore" type="number" min={0} step="0.01" defaultValue={0} /></label>
            <label className="field"><span>رقم المستند</span><input name="reference" maxLength={60} /></label>
            <label className="field field-wide"><span>ملاحظات</span><input name="notes" maxLength={1000} /></label>
          </div>
          <div className="dialog-actions"><button className="button button-primary" disabled={!employee}>حفظ</button><button type="button" className="button button-quiet" onClick={() => setCreating(false)}>إلغاء</button></div>
        </form>
      </Dialog>

      <Dialog open={Boolean(editing)} title="تعديل السلفة" subtitle={editing ? `${editing.employeeName} · ${formatMoney(editing.principal, editing.currency)}` : ''} onClose={() => setEditing(null)}>
        {editing && <form onSubmit={(event) => { event.preventDefault(); const value = Number(new FormData(event.currentTarget).get('installment')); if (value && value !== editing.installment) void update(editing, { installment: value }); }}>
          <div className="form-grid">
            <label className="field"><span>القسط الشهري</span><input name="installment" type="number" min={0.01} step="0.01" defaultValue={editing.installment} /></label>
          </div>
          <div className="dialog-actions">
            <button className="button button-primary">حفظ القسط</button>
            {editing.status === 'active' && <button type="button" className="button button-quiet" onClick={() => void update(editing, { status: 'suspended' })}>إيقاف الاستقطاع</button>}
            {editing.status !== 'active' && <button type="button" className="button button-quiet" onClick={() => void update(editing, { status: 'active' })}>استئناف الاستقطاع</button>}
            {editing.status !== 'closed' && <button type="button" className="button button-quiet danger" onClick={() => void update(editing, { status: 'closed' })}>إغلاق السلفة</button>}
          </div>
        </form>}
      </Dialog>
      {reason.element}
    </section>
  );
}

interface Adjustment {
  employeeId: string; employeeNo: string; employeeName: string; payableDays: number | null; absenceDays: number;
  note: string | null; updatedAt: string; updatedByName: string;
}

/**
 * Payable and absence days typed by HR for staff whose attendance is not on a
 * fingerprint device yet. They override the calendar for that month only.
 */
export function DayAdjustmentsPage() {
  const session = useSession();
  const [period, setPeriod] = useState(previousPeriod());
  const rows = useLoad<Adjustment[]>(`/payroll/day-adjustments?period=${period}`, []);
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const canEdit = session.can('payroll.prepare');
  const divisor = session.settings.payrollRules.monthlyDivisor;

  async function save(employeeId: string, payableDays: number | null, absenceDays: number, note: string | null) {
    try {
      await session.call('/payroll/day-adjustments', { method: 'PUT', body: { period, employeeId, payableDays, absenceDays, note } });
      session.notify('حُفظت الأيام.');
      rows.reload();
    } catch (error) {
      session.fail(error, 'تعذر الحفظ.');
    }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!employee) return;
    const form = new FormData(event.currentTarget);
    const payable = String(form.get('payableDays') ?? '');
    await save(employee.id, payable === '' ? null : Number(payable), Number(form.get('absenceDays') || 0), String(form.get('note') || '') || null);
    setEmployee(null);
    event.currentTarget.reset();
  }

  const partial = rows.data.filter((row) => row.payableDays !== null && row.payableDays < divisor).length;
  const absences = rows.data.reduce((sum, row) => sum + row.absenceDays, 0);

  return (
    <section className="screen">
      <div className="screen-heading">
        <div><h2>أيام الاستحقاق والغياب</h2><p>للموظفين غير المربوطين بالبصمة: أيام الاستحقاق من {divisor}، وأيام الغياب أو التأخير أو عدم البصمة تُخصم بأجر اليوم.</p></div>
        <label className="field inline-field"><span>الشهر</span><input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} /></label>
      </div>
      <div className="stat-row">
        <Stat label="موظفون بأيام مُدخلة" value={formatNumber(rows.data.length)} />
        <Stat label="استحقاق جزئي" value={formatNumber(partial)} foot="منضمون أو منقطعون خلال الشهر" />
        <Stat label="مجموع أيام الغياب" value={formatNumber(absences, 2)} />
      </div>
      <section className="panel">
        {canEdit && <form className="toolbar" onSubmit={add}>
          <EmployeePicker label="الموظف" value={employee} onChange={setEmployee} />
          <label className="field"><span>أيام الاستحقاق</span><input name="payableDays" type="number" min={0} max={31} step="0.25" placeholder={`${divisor}`} /></label>
          <label className="field"><span>أيام الغياب</span><input name="absenceDays" type="number" min={0} max={31} step="0.25" defaultValue={0} /></label>
          <label className="field"><span>ملاحظة</span><input name="note" maxLength={500} /></label>
          <button className="button button-primary toolbar-action" disabled={!employee}><Plus size={15} />حفظ</button>
        </form>}
        {rows.loading ? <Loading /> : rows.data.length ? <div className="table-scroll"><table className="dense">
          <thead><tr><th>الموظف</th><th>أيام الاستحقاق</th><th>أيام الغياب</th><th>ملاحظة</th><th>آخر تعديل</th>{canEdit && <th />}</tr></thead>
          <tbody>{rows.data.map((row) => <tr key={row.employeeId}>
            <td><strong>{row.employeeName}</strong><small className="table-sub">{row.employeeNo}</small></td>
            <td>{canEdit ? <input className="cell-input" type="number" min={0} max={31} step="0.25" defaultValue={row.payableDays ?? ''} placeholder={`${divisor}`}
              onBlur={(event) => { const value = event.target.value === '' ? null : Number(event.target.value); if (value !== row.payableDays) void save(row.employeeId, value, row.absenceDays, row.note); }} />
              : <span className={row.payableDays !== null && row.payableDays < divisor ? 'num-warn' : ''}>{row.payableDays ?? divisor}</span>}</td>
            <td>{canEdit ? <input className="cell-input" type="number" min={0} max={31} step="0.25" defaultValue={row.absenceDays}
              onBlur={(event) => { const value = Number(event.target.value || 0); if (value !== row.absenceDays) void save(row.employeeId, row.payableDays, value, row.note); }} />
              : <span className={row.absenceDays ? 'num-bad' : ''}>{formatNumber(row.absenceDays, 2)}</span>}</td>
            <td className="wrap">{row.note || '—'}</td>
            <td>{row.updatedByName}</td>
            {canEdit && <td><button className="icon-link danger" aria-label="حذف" onClick={() => void save(row.employeeId, null, 0, null)}><Trash2 size={14} /></button></td>}
          </tr>)}</tbody>
        </table></div> : <Empty icon={<CalendarClock size={22} />} title="لا توجد أيام مُدخلة لهذا الشهر" text="من لا يُدخل له شيء يُحتسب له الشهر كاملاً أو حسب البصمة." />}
      </section>
    </section>
  );
}
