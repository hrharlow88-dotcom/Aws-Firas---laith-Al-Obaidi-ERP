import { FormEvent, useRef, useState } from 'react';
import { exportWord } from '../components/DocumentFrame';
import { DEVELOPER } from '../components/Brand';
import { Gavel, Plus, Printer, Search, ShieldAlert, X } from 'lucide-react';
import { Bi } from '../components/Brand';
import { EmployeePicker, PickedEmployee } from '../components/EmployeePicker';
import { Dialog, Empty, Loading, Stat, StatusTag, Tone, useReasonPrompt } from '../components/ui';
import { ViewSwitch, useViewMode } from '../components/ViewSwitch';
import { currentPeriod, formatDate, formatDateTime, formatMoney, formatNumber, monthLabel, today } from '../lib/format';
import { navigate } from '../lib/router';
import { useLoad, useSession } from '../lib/session';

export interface DisciplineRecord {
  id: string; refNo: string; employeeId: string; employeeNo: string; employeeName: string; branchName: string; department: string;
  category: string; action: string; title: string; description: string; incidentDate: string; deductionAmount: number | null;
  deductionCurrency: string | null; deductionPeriod: string | null; suspensionDays: number | null; status: string;
  signature: string | null; issuedByName: string; issuedAt: string; acknowledgedAt: string | null; employeeComment: string | null;
  cancelReason: string | null; cancelledAt: string | null;
}

export const CATEGORY: Record<string, string> = {
  lateness: 'تأخير', absence: 'غياب', conduct: 'سلوك', performance: 'أداء', safety: 'سلامة مهنية',
  policy: 'مخالفة سياسة', property: 'ممتلكات الشركة', other: 'أخرى',
};
export const ACTION: Record<string, { label: string; tone: string }> = {
  note: { label: 'ملاحظة', tone: 'muted' },
  verbal_warning: { label: 'تنبيه شفهي', tone: 'info' },
  written_warning: { label: 'إنذار كتابي', tone: 'warn' },
  final_warning: { label: 'إنذار نهائي', tone: 'bad' },
  deduction: { label: 'خصم من الراتب', tone: 'bad' },
  suspension: { label: 'إيقاف عن العمل', tone: 'bad' },
  termination: { label: 'إنهاء خدمة', tone: 'bad' },
};
export const RECORD_STATUS: Record<string, { label: string; tone: string }> = {
  issued: { label: 'صادر · بانتظار تأكيد الموظف', tone: 'warn' },
  acknowledged: { label: 'اطّلع الموظف', tone: 'good' },
  cancelled: { label: 'ملغى', tone: 'muted' },
};

/** HR register: warnings, penalties and violations with reference numbers. */
export function DisciplinePage() {
  const session = useSession();
  const records = useLoad<DisciplineRecord[]>('/discipline', []);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<DisciplineRecord | null>(null);
  const [view, setView] = useViewMode('discipline', 'list');
  const rows = records.data.filter((row) => !query.trim() || `${row.employeeName} ${row.employeeNo} ${row.refNo} ${row.title}`.includes(query.trim()));
  const live = records.data.filter((row) => row.status !== 'cancelled');
  const thisYear = live.filter((row) => row.incidentDate.startsWith(today().slice(0, 4)));
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="سجل الموارد البشرية" en="HR Register" /></h2><p>الإنذارات والعقوبات والمخالفات، لكل سجل رقم مرجعي وتوقيع من أصدره، ويؤكد الموظف اطلاعه من بوابته.</p></div>
        {session.can('discipline.manage') && <button className="button button-primary" onClick={() => setCreating(true)}><Plus size={16} />تسجيل مخالفة</button>}</div>
      <div className="stat-row">
        <Stat label={`سجلات ${today().slice(0, 4)}`} value={formatNumber(thisYear.length)} />
        <Stat label="إنذارات كتابية ونهائية" value={formatNumber(thisYear.filter((row) => ['written_warning', 'final_warning'].includes(row.action)).length)} />
        <Stat label="خصومات" value={formatNumber(thisYear.filter((row) => row.action === 'deduction').length)} />
        <Stat label="بانتظار اطلاع الموظف" value={formatNumber(live.filter((row) => row.status === 'issued').length)} tone="warn" />
      </div>
      <section className="panel">
        <div className="filter-bar"><label className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث بالاسم أو الرقم المرجعي…" /></label>
          <span className="result-count">{rows.length}</span><ViewSwitch value={view} onChange={setView} modes={['list', 'grid']} /></div>
        {records.loading ? <Loading /> : !rows.length ? <Empty icon={<ShieldAlert size={22} />} title="السجل فارغ" text="تظهر هنا الإنذارات والعقوبات بعد تسجيلها." />
          : view === 'grid' ? <div className="card-grid">{rows.map((row) => <button key={row.id} className={`record-card ${row.status === 'cancelled' ? 'is-cancelled' : ''}`} onClick={() => setOpen(row)}>
            <span className="record-ref" dir="ltr">{row.refNo}</span>
            <strong>{row.employeeName}</strong>
            <Tone tone={ACTION[row.action].tone}>{ACTION[row.action].label}</Tone>
            <small>{CATEGORY[row.category]} · {formatDate(row.incidentDate)}</small>
            <small>{row.title}</small>
          </button>)}</div>
          : <div className="table-scroll"><table className="dense">
            <thead><tr><th>المرجع</th><th>الموظف</th><th>المخالفة</th><th>الإجراء</th><th>التاريخ</th><th>الحالة</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.id} className={`row-link ${row.status === 'cancelled' ? 'row-muted' : ''}`} onClick={() => setOpen(row)}>
              <td dir="ltr"><strong>{row.refNo}</strong></td>
              <td><strong>{row.employeeName}</strong><small className="table-sub">{row.employeeNo} · {row.branchName}</small></td>
              <td>{row.title}<small className="table-sub">{CATEGORY[row.category]}</small></td>
              <td><Tone tone={ACTION[row.action].tone}>{ACTION[row.action].label}</Tone>{row.deductionAmount && <small className="table-sub">{formatMoney(row.deductionAmount, row.deductionCurrency ?? 'IQD')} · {row.deductionPeriod ? monthLabel(row.deductionPeriod) : ''}</small>}</td>
              <td>{formatDate(row.incidentDate)}</td>
              <td><StatusTag map={RECORD_STATUS} value={row.status} /></td>
            </tr>)}</tbody>
          </table></div>}
      </section>
      <NewRecord open={creating} onClose={() => setCreating(false)} onDone={() => { setCreating(false); records.reload(); }} />
      <Dialog open={Boolean(open)} title={open ? `${ACTION[open.action].label} — ${open.refNo}` : ''} subtitle={open ? `${open.employeeName} · ${open.employeeNo}` : ''} onClose={() => setOpen(null)} wide>
        {open && <RecordView record={open} onChanged={() => { setOpen(null); records.reload(); }} />}
      </Dialog>
    </section>
  );
}

function NewRecord({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [action, setAction] = useState('written_warning');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!employee) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const result = await session.call<{ data: { refNo: string } }>('/discipline', {
        body: {
          employeeId: employee.id, category: form.get('category'), action, title: form.get('title'), description: form.get('description'),
          incidentDate: form.get('incidentDate'),
          ...(action === 'deduction' ? { deductionAmount: Number(form.get('deductionAmount')), deductionPeriod: form.get('deductionPeriod'), deductionCurrency: form.get('deductionCurrency') } : {}),
          ...(action === 'suspension' ? { suspensionDays: Number(form.get('suspensionDays')) } : {}),
        },
      });
      session.notify(`سُجّل ${result.data.refNo}${action === 'deduction' ? ' وأُضيف الخصم إلى مسير الشهر' : ''}.`);
      setEmployee(null);
      onDone();
    } catch (error) {
      session.fail(error, 'تعذر التسجيل.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} title="تسجيل مخالفة أو عقوبة · New record" subtitle="يُوقّع السجل بتوقيعك الإلكتروني المحفوظ، ويصل إشعار للموظف في بوابته." onClose={onClose} wide>
      <form onSubmit={(event) => void submit(event)}>
        <div className="form-grid">
          <EmployeePicker label="الموظف *" value={employee} onChange={setEmployee} />
          <label className="field"><span>نوع المخالفة *</span><select name="category" required defaultValue="lateness">{Object.entries(CATEGORY).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="field"><span>الإجراء *</span><select value={action} onChange={(event) => setAction(event.target.value)}>{Object.entries(ACTION).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}</select></label>
          <label className="field"><span>تاريخ المخالفة *</span><input name="incidentDate" type="date" required defaultValue={today()} /></label>
          {action === 'deduction' && <>
            <label className="field"><span>مبلغ الخصم *</span><input name="deductionAmount" type="number" min={1} required /></label>
            <label className="field"><span>العملة</span><select name="deductionCurrency" defaultValue="IQD"><option value="IQD">دينار</option><option value="USD">دولار</option></select></label>
            <label className="field"><span>شهر الخصم *</span><input name="deductionPeriod" type="month" required defaultValue={currentPeriod()} /><small>يُضاف إلى «استقطاع آخر» في مسير الشهر.</small></label>
          </>}
          {action === 'suspension' && <label className="field"><span>أيام الإيقاف *</span><input name="suspensionDays" type="number" min={1} max={60} required /></label>}
          <label className="field field-wide"><span>العنوان *</span><input name="title" required maxLength={200} placeholder="مثال: تأخر متكرر عن الدوام" /></label>
          <label className="field field-wide"><span>التفاصيل والوقائع *</span><textarea name="description" required rows={4} maxLength={5000} /></label>
        </div>
        <div className="dialog-actions"><button className="button button-primary" disabled={busy || !employee}><Gavel size={15} />إصدار</button><button type="button" className="button button-quiet" onClick={onClose}>إلغاء</button></div>
      </form>
    </Dialog>
  );
}

/** One record, printable as an official notice. */
export function RecordView({ record, onChanged, own = false }: { record: DisciplineRecord; onChanged: () => void; own?: boolean }) {
  const session = useSession();
  const reason = useReasonPrompt();
  const sheet = useRef<HTMLDivElement>(null);
  async function cancel() {
    const why = await reason.ask('سبب إلغاء السجل');
    if (!why) return;
    try {
      await session.call(`/discipline/${record.id}/cancel`, { body: { reason: why } });
      session.notify('أُلغي السجل.');
      onChanged();
    } catch (error) {
      session.fail(error, 'تعذر الإلغاء.');
    }
  }
  async function acknowledge() {
    const comment = window.prompt('ملاحظتك (اختياري)') ?? '';
    try {
      await session.call(`/me/discipline/${record.id}/acknowledge`, { body: { comment: comment.trim() || undefined } });
      session.notify('سُجّل اطلاعك على الإشعار.');
      onChanged();
    } catch (error) {
      session.fail(error, 'تعذر التسجيل.');
    }
  }
  return <div className="notice-doc" ref={sheet}>
    <div className="notice-doc-head">
      <div><strong>مجموعة الليث العبيدي للسيارات — الموارد البشرية</strong><small dir="ltr">Al-Laith Al-Obaidi Automotive Group — Human Resources</small></div>
      <span dir="ltr">{record.refNo}</span>
    </div>
    <h3>{ACTION[record.action].label} · {record.title}</h3>
    <dl className="facts">
      <div><dt>الموظف</dt><dd>{record.employeeName} ({record.employeeNo})</dd></div>
      <div><dt>القسم / الفرع</dt><dd>{record.department} · {record.branchName}</dd></div>
      <div><dt>نوع المخالفة</dt><dd>{CATEGORY[record.category]}</dd></div>
      <div><dt>تاريخ المخالفة</dt><dd>{formatDate(record.incidentDate)}</dd></div>
      {record.deductionAmount && <div><dt>الخصم</dt><dd>{formatMoney(record.deductionAmount, record.deductionCurrency ?? 'IQD')} من راتب {record.deductionPeriod ? monthLabel(record.deductionPeriod) : ''}</dd></div>}
      {record.suspensionDays && <div><dt>الإيقاف</dt><dd>{record.suspensionDays} يوم</dd></div>}
      <div className="facts-wide"><dt>الوقائع</dt><dd className="pre">{record.description}</dd></div>
    </dl>
    <div className="notice-doc-sign">
      <div><small><Bi ar={"أصدره"} en={"Issued by"} /></small><strong>{record.issuedByName}</strong><small>{formatDateTime(record.issuedAt)}</small>{record.signature && <img src={record.signature} alt="التوقيع" />}</div>
      <div><small><Bi ar={"اطلاع الموظف"} en={"Employee acknowledgement"} /></small>{record.acknowledgedAt ? <><strong>{record.employeeName}</strong><small>{formatDateTime(record.acknowledgedAt)}</small>{record.employeeComment && <small>«{record.employeeComment}»</small>}</> : <span className="muted">لم يؤكد بعد</span>}</div>
    </div>
    {record.status === 'cancelled' && <p className="muted">ملغى: {record.cancelReason}</p>}
    <footer className="doc-foot"><span>أعدّه {record.issuedByName} · طُبع بواسطة {session.user.name}</span><span>{DEVELOPER.ar}</span></footer>
    <div className="dialog-actions no-print">
      <button className="button button-quiet" onClick={() => window.print()}><Printer size={15} />طباعة / PDF</button>
      <button className="button button-quiet" onClick={() => sheet.current && void exportWord(sheet.current, record.refNo)}>Word</button>
      {!own && record.status !== 'cancelled' && session.can('discipline.manage') && <button className="button button-quiet danger" onClick={() => void cancel()}><X size={15} />إلغاء السجل</button>}
      {!own && <button className="button button-quiet" onClick={() => navigate('employees', record.employeeId)}>ملف الموظف</button>}
      {own && record.status === 'issued' && <button className="button button-primary" onClick={() => void acknowledge()}>أؤكد اطلاعي</button>}
    </div>
    {reason.element}
  </div>;
}
