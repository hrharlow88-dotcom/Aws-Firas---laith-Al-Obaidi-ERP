import { FormEvent, useState } from 'react';
import { Ban, Banknote, Check, ChevronLeft, Paperclip, Plus, Receipt, Send, Stamp, Trash2, X } from 'lucide-react';
import { Bi } from '../components/Brand';
import { Dialog, Empty, Loading, Stat, Tabs, Tone } from '../components/ui';
import { openFile } from '../lib/api';
import { formatDate, formatDateTime, formatMoney, formatNumber } from '../lib/format';
import { navigate } from '../lib/router';
import { useCrumb } from '../lib/breadcrumbs';
import { useLoad, useSession } from '../lib/session';

interface Step { type: string; role?: string; label: string; approvers: string[] }
interface RequestRow {
  id: string; number: string; entityType: 'approval' | 'expense'; title: string; status: string; amount: number | null; currency: string | null;
  dateFrom: string | null; dateTo: string | null; currentStep: number; steps: Step[]; createdAt: string; categoryName: string | null;
  requesterName: string; employeeName: string | null; attachmentName: string | null; paymentMode: string | null; paidAt: string | null;
}
interface Detail extends RequestRow {
  details: string | null; requesterId: string; canDecide: boolean; canPay: boolean; isMine: boolean;
  actions: Array<{ step: number; decision: string; note: string | null; at: string; userName: string }>;
  lines: Array<{ id: string; expenseDate: string; category: string; description: string; amount: number; receiptName: string | null }>;
}
interface Category { id: string; code: string; nameAr: string; nameEn: string | null; description: string | null; steps: Array<{ type: string; role?: string; userId?: string }>; needsAmount: boolean; needsDates: boolean; needsAttachment: boolean; isActive: boolean; sortOrder: number }

export const REQUEST_STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: 'مسودة', tone: 'muted' }, pending: { label: 'بانتظار الموافقة', tone: 'warn' }, approved: { label: 'معتمد', tone: 'good' },
  refused: { label: 'مرفوض', tone: 'bad' }, cancelled: { label: 'ملغى', tone: 'muted' }, paid: { label: 'مصروف', tone: 'good' },
};
const DECISION: Record<string, string> = { submitted: 'قدّم الطلب', approved: 'وافق', refused: 'رفض', paid: 'صرف', cancelled: 'ألغى' };
const ROLE_OPTIONS: Record<string, string> = { manager: 'المدير المباشر', finance: 'المالية', hr_manager: 'مدير الموارد البشرية', executive: 'الإدارة العليا', super_admin: 'مالك النظام', payroll_officer: 'مسؤول الرواتب', auditor: 'التدقيق' };

function StatusTag({ status }: { status: string }) {
  const item = REQUEST_STATUS[status] ?? { label: status, tone: 'muted' };
  return <Tone tone={item.tone}>{item.label}</Tone>;
}

/** The approval path as a row of steps: done, current, waiting. */
function StepTrail({ row }: { row: RequestRow }) {
  return <ol className="approval-trail">{row.steps.map((step, index) => {
    const state = row.status === 'refused' && index === row.currentStep ? 'is-refused'
      : index < row.currentStep || ['approved', 'paid'].includes(row.status) ? 'is-done' : index === row.currentStep && row.status === 'pending' ? 'is-current' : '';
    return <li key={index} className={state}><span>{index + 1}</span>{step.label}</li>;
  })}</ol>;
}

function useBox(kind: 'approval' | 'expense') {
  const session = useSession();
  const canAll = session.user.role === 'super_admin' || (kind === 'expense' && session.can('payroll.disburse'));
  const [box, setBox] = useState<'mine' | 'todo' | 'all' | 'topay'>('mine');
  const data = useLoad<{ rows: RequestRow[]; counts: { todo: number; mine: number } }>(`/${kind === 'expense' ? 'expenses' : 'approval-requests'}?box=${box}`, { rows: [], counts: { todo: 0, mine: 0 } });
  const tabs: Array<{ id: typeof box; label: string; badge?: number }> = [
    { id: 'mine', label: 'طلباتي · Mine', badge: data.data.counts.mine }, { id: 'todo', label: 'بانتظار موافقتي · To approve', badge: data.data.counts.todo },
    ...(kind === 'expense' && canAll ? [{ id: 'topay' as const, label: 'للصرف · To pay' }] : []),
    ...(canAll ? [{ id: 'all' as const, label: 'الكل · All' }] : []),
  ];
  return { box, setBox, data, tabs };
}

function RequestTable({ rows, kind }: { rows: RequestRow[]; kind: 'approval' | 'expense' }) {
  return <div className="table-scroll"><table className="dense"><thead><tr><th>الرقم</th><th>{kind === 'expense' ? 'التقرير' : 'الطلب'}</th><th>مقدم الطلب</th><th>المبلغ</th><th>المسار</th><th>الحالة</th><th /></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.id} className="row-link" onClick={() => navigate(kind === 'expense' ? 'expenses' : 'approval-requests', row.id)}>
      <td dir="ltr">{row.number}</td>
      <td><strong>{row.title}</strong>{row.categoryName && <small className="table-sub">{row.categoryName}</small>}</td>
      <td>{row.requesterName}<small className="table-sub">{formatDate(row.createdAt)}</small></td>
      <td>{row.amount ? formatMoney(row.amount, row.currency ?? 'IQD') : '—'}</td>
      <td>{row.steps.length ? <StepTrail row={row} /> : '—'}</td>
      <td><StatusTag status={row.status} /></td><td><ChevronLeft size={16} /></td></tr>)}</tbody></table></div>;
}

function DecisionBox({ detail, base, onDone }: { detail: Detail; base: string; onDone: () => void }) {
  const session = useSession();
  const [note, setNote] = useState('');
  async function act(path: string, body: Record<string, unknown>, message: string) {
    try { await session.call(`${base}/${detail.id}/${path}`, { method: 'POST', body }); session.notify(message); setNote(''); onDone(); }
    catch (error) { session.fail(error, 'تعذر التنفيذ.'); }
  }
  return <div className="decision-box no-print">
    {detail.canDecide && <>
      <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="ملاحظة (إلزامية عند الرفض)" />
      <div className="row-actions">
        <button className="button button-primary" onClick={() => void act('decide', { decision: 'approved', note: note || undefined }, 'تمت الموافقة.')}><Check size={15} />موافقة</button>
        <button className="button button-danger" onClick={() => void act('decide', { decision: 'refused', note }, 'رُفض الطلب.')}><X size={15} />رفض</button></div></>}
    {detail.canPay && <div className="row-actions">
      <button className="button button-primary" onClick={() => void act('pay', { mode: 'cash' }, 'سُجل الصرف.')}><Banknote size={15} />صرف نقداً / تحويل</button>
      <button className="button button-quiet" onClick={() => void act('pay', { mode: 'payroll' }, 'سيُضاف مع الراتب.')}>مع الراتب</button></div>}
    {detail.isMine && ['draft', 'pending'].includes(detail.status) && <button className="button button-quiet" onClick={() => void act('cancel', {}, 'أُلغي الطلب.')}><Ban size={14} />إلغاء الطلب</button>}
  </div>;
}

function History({ detail }: { detail: Detail }) {
  return <ul className="approval-history">{detail.actions.map((action, index) => <li key={index} className={`is-${action.decision}`}>
    <strong>{action.userName}</strong> {DECISION[action.decision] ?? action.decision}{action.note ? `: «${action.note}»` : ''}<small>{formatDateTime(action.at)}</small></li>)}</ul>;
}

/** Expense reports (like Odoo Expenses): lines with receipts, approval by the manager then finance, then reimbursement. */
export function ExpensesPage({ id }: { id?: string }) {
  if (id) return <ExpenseDetail id={id} />;
  return <ExpenseList />;
}

function ExpenseList() {
  const session = useSession();
  const { box, setBox, data, tabs } = useBox('expense');
  const [creating, setCreating] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await session.call<{ data: { id: string } }>('/expenses', { method: 'POST', body: { title: form.get('title'), currency: form.get('currency'), details: form.get('details') || undefined } });
      navigate('expenses', result.data.id);
    } catch (error) { session.fail(error, 'تعذر الإنشاء.'); }
  }
  const rows = data.data.rows;
  return <section className="screen">
    <div className="screen-heading"><div><h2><Receipt size={22} /> <Bi ar="تقارير المصاريف" en="Expense reports" /></h2>
      <p>سجّل مصاريف العمل بإيصالاتها، ثم أرسل التقرير: يوافق المدير المباشر ثم المالية، وتُصرف لك نقداً أو مع الراتب. تتابع كل خطوة وتصلك الإشعارات.</p></div>
      <button className="button button-primary" onClick={() => setCreating(true)}><Plus size={16} />تقرير جديد</button></div>
    <div className="stat-row"><Stat label="بانتظار موافقتي" value={formatNumber(data.data.counts.todo)} tone={data.data.counts.todo ? 'warn' : undefined} />
      <Stat label="طلباتي المفتوحة" value={formatNumber(data.data.counts.mine)} /></div>
    <Tabs value={box} onChange={setBox} items={tabs} />
    <section className="panel">{data.loading ? <Loading /> : !rows.length ? <Empty icon={<Receipt size={22} />} title="لا توجد تقارير" text="—" /> : <RequestTable rows={rows} kind="expense" />}</section>
    <Dialog open={creating} title="تقرير مصاريف جديد" onClose={() => setCreating(false)}>
      <form className="form-grid" onSubmit={(event) => void create(event)}>
        <label className="field settings-wide"><span>عنوان التقرير *</span><input name="title" required maxLength={200} placeholder="زيارة فرع أربيل — تشرين الأول" /></label>
        <label className="field"><span>العملة</span><select name="currency" defaultValue="IQD"><option value="IQD">دينار · IQD</option><option value="USD">دولار · USD</option></select></label>
        <label className="field settings-wide"><span>تفاصيل</span><textarea name="details" rows={2} maxLength={2000} /></label>
        <div className="dialog-actions settings-wide"><button className="button button-primary">إنشاء وإضافة المصاريف</button></div>
      </form>
    </Dialog>
  </section>;
}

function ExpenseDetail({ id }: { id: string }) {
  const session = useSession();
  const data = useLoad<Detail | null>(`/expenses/${id}`, null);
  const [adding, setAdding] = useState(false);
  const detail = data.data;
  useCrumb({ label: detail?.number ?? '…' });
  async function addLine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    try { await session.call(`/expenses/${id}/lines`, { form: new FormData(element) }); element.reset(); setAdding(false); data.reload(); }
    catch (error) { session.fail(error, 'تعذر الإضافة.'); }
  }
  async function removeLine(lineId: string) {
    try { await session.call(`/expenses/${id}/lines/${lineId}`, { method: 'DELETE' }); data.reload(); } catch (error) { session.fail(error, 'تعذر الحذف.'); }
  }
  async function submit() {
    try { await session.call(`/expenses/${id}/submit`, { method: 'POST' }); session.notify('أُرسل التقرير للموافقة.'); data.reload(); } catch (error) { session.fail(error, 'تعذر الإرسال.'); }
  }
  if (data.loading || !detail) return <Loading />;
  const draft = detail.status === 'draft' && detail.isMine;
  return <section className="screen">
    <div className="screen-heading"><div><h2>{detail.title} <small dir="ltr">{detail.number}</small></h2><p>{detail.requesterName}{detail.employeeName && detail.employeeName !== detail.requesterName ? ` · ${detail.employeeName}` : ''} · {formatDateTime(detail.createdAt)}</p></div>
      <StatusTag status={detail.status} /></div>
    {detail.steps.length > 0 && <StepTrail row={detail} />}
    <section className="panel">
      <div className="panel-head"><div><h3>المصاريف</h3></div>
        <div className="row-actions">{draft && <button className="button button-quiet" onClick={() => setAdding(true)}><Plus size={15} />مصروف</button>}
          {draft && <button className="button button-primary" disabled={!detail.lines.length} onClick={() => void submit()}><Send size={15} />إرسال للموافقة</button>}</div></div>
      {!detail.lines.length ? <Empty icon={<Receipt size={22} />} title="لا توجد مصاريف بعد" text="أضف كل مصروف بإيصاله." />
        : <div className="table-scroll"><table className="dense"><thead><tr><th>التاريخ</th><th>الفئة</th><th>الوصف</th><th>المبلغ</th><th>الإيصال</th><th /></tr></thead>
          <tbody>{detail.lines.map((line) => <tr key={line.id}><td>{formatDate(line.expenseDate)}</td><td>{line.category}</td><td>{line.description}</td><td>{formatMoney(line.amount, detail.currency ?? 'IQD')}</td>
            <td>{line.receiptName ? <button className="text-button" onClick={() => void openFile(`/expenses/${id}/lines/${line.id}/file`, session.token).catch((error) => session.fail(error, 'تعذر الفتح.'))}><Paperclip size={13} />{line.receiptName}</button> : '—'}</td>
            <td>{draft && <button className="icon-button" aria-label="حذف" onClick={() => void removeLine(line.id)}><Trash2 size={14} /></button>}</td></tr>)}
            <tr className="table-total"><td colSpan={3}><strong>المجموع</strong></td><td><strong>{formatMoney(detail.amount ?? 0, detail.currency ?? 'IQD')}</strong></td><td colSpan={2} /></tr></tbody></table></div>}
    </section>
    <DecisionBox detail={detail} base="/expenses" onDone={data.reload} />
    {detail.actions.length > 0 && <section className="panel"><div className="panel-head"><div><h3>سير الطلب</h3></div></div><History detail={detail} /></section>}
    <Dialog open={adding} title="مصروف جديد" onClose={() => setAdding(false)}>
      <form className="form-grid" onSubmit={(event) => void addLine(event)}>
        <label className="field"><span>التاريخ *</span><input name="expenseDate" type="date" required /></label>
        <label className="field"><span>الفئة *</span><select name="category" required>{session.settings.hr?.expenseCategories?.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="field settings-wide"><span>الوصف *</span><input name="description" required maxLength={300} /></label>
        <label className="field"><span>المبلغ ({detail.currency}) *</span><input name="amount" type="number" min={0.01} step="0.01" required /></label>
        <label className="field"><span>الإيصال (PDF أو صورة)</span><input name="file" type="file" accept="application/pdf,image/*" /></label>
        <div className="dialog-actions settings-wide"><button className="button button-primary">إضافة</button></div>
      </form>
    </Dialog>
  </section>;
}

/** Approvals (like Odoo Approvals): purchase, business trip, borrowed items or any request, through its approvers in order. */
export function ApprovalRequestsPage({ id }: { id?: string }) {
  if (id) return <ApprovalDetail id={id} />;
  return <ApprovalList />;
}

function ApprovalList() {
  const session = useSession();
  const { box, setBox, data, tabs } = useBox('approval');
  const categories = useLoad<Category[]>('/approval-categories', []);
  const [category, setCategory] = useState<Category | null>(null);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set('categoryId', category!.id);
    try {
      const result = await session.call<{ data: { id: string } }>('/approval-requests', { form });
      setCategory(null);
      navigate('approval-requests', result.data.id);
    } catch (error) { session.fail(error, 'تعذر الإرسال.'); }
  }
  return <section className="screen">
    <div className="screen-heading"><div><h2><Stamp size={22} /> <Bi ar="الموافقات" en="Approvals" /></h2>
      <p>اختر نوع الطلب وقدّمه؛ يمر على الموافقين بالترتيب (المدير المباشر ثم الجهة المختصة)، ويصل كل واحد إشعار عندما يأتي دوره، وتتابع أنت كل خطوة.</p></div></div>
    <div className="approval-cards">{categories.data.filter((item) => item.isActive).map((item) => <button key={item.id} className="approval-card" onClick={() => setCategory(item)}>
      <Stamp size={20} /><strong>{item.nameAr}</strong>{item.nameEn && <small dir="ltr">{item.nameEn}</small>}<span>{item.steps.map((step) => ROLE_OPTIONS[step.type === 'role' ? step.role! : step.type] ?? 'شخص محدد').join(' ← ')}</span></button>)}</div>
    <Tabs value={box} onChange={setBox} items={tabs} />
    <section className="panel">{data.loading ? <Loading /> : !data.data.rows.length ? <Empty icon={<Stamp size={22} />} title="لا توجد طلبات" text="—" /> : <RequestTable rows={data.data.rows} kind="approval" />}</section>
    <Dialog open={Boolean(category)} title={category ? `طلب: ${category.nameAr}` : ''} subtitle={category?.description ?? ''} onClose={() => setCategory(null)}>
      {category && <form className="form-grid" onSubmit={(event) => void create(event)}>
        <label className="field settings-wide"><span>العنوان *</span><input name="title" required maxLength={200} /></label>
        <label className="field settings-wide"><span>التفاصيل</span><textarea name="details" rows={3} maxLength={4000} /></label>
        {category.needsAmount && <><label className="field"><span>المبلغ *</span><input name="amount" type="number" min={0.01} step="0.01" required /></label>
          <label className="field"><span>العملة</span><select name="currency" defaultValue="IQD"><option>IQD</option><option>USD</option></select></label></>}
        {category.needsDates && <><label className="field"><span>من *</span><input name="dateFrom" type="date" required /></label><label className="field"><span>إلى</span><input name="dateTo" type="date" /></label></>}
        <label className="field settings-wide"><span>مرفق {category.needsAttachment ? '*' : '(اختياري)'} — PDF أو صورة</span><input name="file" type="file" accept="application/pdf,image/*" required={category.needsAttachment} /></label>
        <div className="dialog-actions settings-wide"><button className="button button-primary"><Send size={15} />إرسال</button></div>
      </form>}
    </Dialog>
  </section>;
}

function ApprovalDetail({ id }: { id: string }) {
  const session = useSession();
  const data = useLoad<Detail | null>(`/approval-requests/${id}`, null);
  const detail = data.data;
  useCrumb({ label: detail?.number ?? '…' });
  if (data.loading || !detail) return <Loading />;
  return <section className="screen">
    <div className="screen-heading"><div><h2>{detail.title} <small dir="ltr">{detail.number}</small></h2><p>{detail.categoryName} · {detail.requesterName} · {formatDateTime(detail.createdAt)}</p></div><StatusTag status={detail.status} /></div>
    <StepTrail row={detail} />
    <section className="panel"><dl className="detail-grid">
      {detail.amount ? <><dt>المبلغ</dt><dd>{formatMoney(detail.amount, detail.currency ?? 'IQD')}</dd></> : null}
      {detail.dateFrom && <><dt>التاريخ</dt><dd>{formatDate(detail.dateFrom)}{detail.dateTo && detail.dateTo !== detail.dateFrom ? ` → ${formatDate(detail.dateTo)}` : ''}</dd></>}
      {detail.details && <><dt>التفاصيل</dt><dd className="pre-line">{detail.details}</dd></>}
      {detail.attachmentName && <><dt>المرفق</dt><dd><button className="text-button" onClick={() => void openFile(`/approval-requests/${id}/file`, session.token).catch((error) => session.fail(error, 'تعذر الفتح.'))}><Paperclip size={13} />{detail.attachmentName}</button></dd></>}
    </dl></section>
    <DecisionBox detail={detail} base="/approval-requests" onDone={data.reload} />
    <section className="panel"><div className="panel-head"><div><h3>سير الطلب</h3></div></div><History detail={detail} /></section>
  </section>;
}

/** The owner defines the request types and who approves each, in order. */
export function ApprovalCategoriesPage() {
  const session = useSession();
  const data = useLoad<Category[]>('/approval-categories', []);
  const [editing, setEditing] = useState<Partial<Category> | null>(null);
  const [steps, setSteps] = useState<Array<{ type: string; role?: string }>>([]);
  function open(category: Partial<Category>) { setEditing(category); setSteps(category.steps ?? [{ type: 'manager' }]); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      code: form.get('code'), nameAr: form.get('nameAr'), nameEn: form.get('nameEn') || null, description: form.get('description') || null, steps,
      needsAmount: form.get('needsAmount') === 'on', needsDates: form.get('needsDates') === 'on', needsAttachment: form.get('needsAttachment') === 'on',
      isActive: form.get('isActive') === 'on', sortOrder: Number(form.get('sortOrder')) || 0,
    };
    try {
      if (editing?.id) await session.call(`/approval-categories/${editing.id}`, { method: 'PUT', body });
      else await session.call('/approval-categories', { method: 'POST', body });
      setEditing(null); data.reload();
    } catch (error) { session.fail(error, 'تعذر الحفظ.'); }
  }
  return <section className="screen">
    <div className="screen-heading"><div><h2><Bi ar="أنواع الموافقات" en="Approval types" /></h2><p>لكل نوع طلب مساره: المدير المباشر، أو دور (المالية، الموارد البشرية، الإدارة العليا…)، بالترتيب الذي تحدده.</p></div>
      <button className="button button-primary" onClick={() => open({ isActive: true })}><Plus size={16} />نوع جديد</button></div>
    <section className="panel">{data.loading ? <Loading /> : <div className="table-scroll"><table className="dense"><thead><tr><th>النوع</th><th>المسار</th><th>يتطلب</th><th>الحالة</th><th /></tr></thead>
      <tbody>{data.data.map((item) => <tr key={item.id}><td><strong>{item.nameAr}</strong><small className="table-sub">{item.code}</small></td>
        <td>{item.steps.map((step) => ROLE_OPTIONS[step.type === 'role' ? step.role! : step.type] ?? 'شخص').join(' ← ')}</td>
        <td>{[item.needsAmount && 'مبلغ', item.needsDates && 'تاريخ', item.needsAttachment && 'مرفق'].filter(Boolean).join('، ') || '—'}</td>
        <td>{item.isActive ? <Tone tone="good">فعّال</Tone> : <Tone tone="muted">موقوف</Tone>}</td>
        <td><button className="button button-quiet button-small" onClick={() => open(item)}>تعديل</button></td></tr>)}</tbody></table></div>}</section>
    <Dialog wide open={Boolean(editing)} title={editing?.id ? 'تعديل النوع' : 'نوع موافقة جديد'} onClose={() => setEditing(null)}>
      {editing && <form className="form-grid" onSubmit={(event) => void save(event)}>
        <label className="field"><span>الرمز *</span><input name="code" required maxLength={20} dir="ltr" defaultValue={editing.code} /></label>
        <label className="field"><span>الترتيب</span><input name="sortOrder" type="number" defaultValue={editing.sortOrder ?? 0} /></label>
        <label className="field"><span>الاسم *</span><input name="nameAr" required maxLength={120} defaultValue={editing.nameAr} /></label>
        <label className="field"><span>Name</span><input name="nameEn" maxLength={120} dir="ltr" defaultValue={editing.nameEn ?? ''} /></label>
        <label className="field settings-wide"><span>الوصف</span><input name="description" maxLength={500} defaultValue={editing.description ?? ''} /></label>
        <fieldset className="settings-wide"><legend>الموافقون بالترتيب</legend>
          {steps.map((step, index) => <div key={index} className="row-actions"><span>{index + 1}.</span>
            <select value={step.type === 'role' ? step.role : 'manager'} onChange={(event) => setSteps(steps.map((item, position) => position === index ? (event.target.value === 'manager' ? { type: 'manager' } : { type: 'role', role: event.target.value }) : item))}>
              {Object.entries(ROLE_OPTIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            {steps.length > 1 && <button type="button" className="icon-button" onClick={() => setSteps(steps.filter((_, position) => position !== index))}><X size={14} /></button>}</div>)}
          {steps.length < 6 && <button type="button" className="button button-quiet button-small" onClick={() => setSteps([...steps, { type: 'role', role: 'finance' }])}><Plus size={13} />خطوة</button>}
        </fieldset>
        <label className="settings-check"><input type="checkbox" name="needsAmount" defaultChecked={editing.needsAmount} />يتطلب مبلغاً</label>
        <label className="settings-check"><input type="checkbox" name="needsDates" defaultChecked={editing.needsDates} />يتطلب تاريخاً</label>
        <label className="settings-check"><input type="checkbox" name="needsAttachment" defaultChecked={editing.needsAttachment} />يتطلب مرفقاً</label>
        <label className="settings-check"><input type="checkbox" name="isActive" defaultChecked={editing.isActive !== false} />فعّال</label>
        <div className="dialog-actions settings-wide"><button className="button button-primary">حفظ</button></div>
      </form>}
    </Dialog>
  </section>;
}
