import { useState } from 'react';
import { Check, Copy, Eye, FileText, Link2, MessageCircle, Paperclip, Search, Wallet, X } from 'lucide-react';
import { Bi } from '../components/Brand';
import { Dialog, Empty, Loading, Stat, StatusTag, Tabs } from '../components/ui';
import { ViewSwitch, useViewMode } from '../components/ViewSwitch';
import { formatDate, formatDateTime, formatMoney, formatNumber, monthLabel } from '../lib/format';
import { useLoad, useSession } from '../lib/session';
import { REQUEST_STATUS } from './MySpacePage';

interface Row {
  id: string; employeeId: string; employeeNo: string; employeeName: string; branchName: string; kind: 'loan' | 'expense';
  amount: number; currency: string; months: number | null; startPeriod: string | null; expenseDate: string | null;
  description: string; receiptName: string | null; hasReceipt: boolean; status: string; decisionNote: string | null;
  decidedAt: string | null; decidedByName: string | null; decisionSignature: string | null; loanId: string | null;
  paidAt: string | null; paidByName: string | null; createdAt: string;
}

const KANBAN: Array<{ status: string; ar: string }> = [
  { status: 'pending', ar: 'بانتظار القرار' }, { status: 'approved', ar: 'موافق عليها' },
  { status: 'paid', ar: 'مصروفة' }, { status: 'rejected', ar: 'مرفوضة' },
];

/** Loan requests and work-expense claims from the employee portal. */
export function RequestsPage() {
  const session = useSession();
  const [kind, setKind] = useState<'all' | 'loan' | 'expense'>('all');
  const rows = useLoad<Row[]>(`/requests${kind === 'all' ? '' : `?kind=${kind}`}`, []);
  const [view, setView] = useViewMode('requests', 'kanban');
  const [open, setOpen] = useState<Row | null>(null);
  const pending = rows.data.filter((row) => row.status === 'pending');

  async function receipt(row: Row) {
    try {
      const response = await fetch(`/api/requests/${row.id}/receipt?inline=1`, { headers: { Authorization: `Bearer ${session.token}` } });
      if (!response.ok) throw new Error('تعذر فتح الوصل.');
      window.open(URL.createObjectURL(await response.blob()), '_blank', 'noopener');
    } catch (error) {
      session.fail(error, 'تعذر فتح الوصل.');
    }
  }

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="طلبات الموظفين" en="Employee Requests" /></h2><p>السلف وتكاليف العمل المقدمة من بوابة الموظف. الموافقة على السلفة تنشئها وتُقسَّط على المسيرات تلقائياً.</p></div></div>
      <div className="stat-row">
        <Stat label="بانتظار القرار" value={formatNumber(pending.length)} tone={pending.length ? 'warn' : undefined} />
        <Stat label="سلف مطلوبة" value={formatNumber(pending.filter((row) => row.kind === 'loan').length)} />
        <Stat label="تكاليف عمل" value={formatNumber(pending.filter((row) => row.kind === 'expense').length)} />
      </div>
      <section className="panel">
        <div className="filter-bar">
          <Tabs<'all' | 'loan' | 'expense'> value={kind} onChange={setKind} items={[{ id: 'all', label: 'الكل · All' }, { id: 'loan', label: 'السلف · Loans' }, { id: 'expense', label: 'تكاليف العمل · Expenses' }]} />
          <ViewSwitch value={view} onChange={setView} modes={['kanban', 'list']} />
        </div>
        {rows.loading ? <Loading /> : !rows.data.length ? <Empty icon={<FileText size={22} />} title="لا توجد طلبات" text="تظهر هنا طلبات الموظفين من البوابة." />
          : view === 'kanban' ? <div className="kanban-board">{KANBAN.map((column) => {
            const items = rows.data.filter((row) => row.status === column.status);
            return <div className="kanban-column" key={column.status}>
              <div className="kanban-column-head">{column.ar}<span>{items.length}</span></div>
              {items.map((row) => <button key={row.id} className="kanban-card" onClick={() => setOpen(row)}>
                <strong>{row.employeeName}</strong>
                <small>{row.kind === 'loan' ? `سلفة · ${row.months} أشهر` : 'تكاليف عمل'} · {row.branchName}</small>
                <b>{formatMoney(row.amount, row.currency)}</b>
                <small>{formatDateTime(row.createdAt)}{row.hasReceipt ? ' · وصل مرفق' : ''}</small>
              </button>)}
            </div>;
          })}</div>
          : <div className="table-scroll"><table className="dense">
            <thead><tr><th>الموظف</th><th>الطلب</th><th>المبلغ</th><th>الحالة</th><th /></tr></thead>
            <tbody>{rows.data.map((row) => <tr key={row.id} className="row-link" onClick={() => setOpen(row)}>
              <td><strong>{row.employeeName}</strong><small className="table-sub">{row.employeeNo} · {row.branchName}</small></td>
              <td>{row.kind === 'loan' ? 'سلفة' : 'تكاليف عمل'}<small className="table-sub">{row.description}</small></td>
              <td><strong>{formatMoney(row.amount, row.currency)}</strong></td>
              <td><StatusTag map={REQUEST_STATUS} value={row.status} /></td>
              <td><Eye size={14} /></td>
            </tr>)}</tbody>
          </table></div>}
      </section>
      <Dialog open={Boolean(open)} title={open ? `${open.kind === 'loan' ? 'طلب سلفة' : 'تكاليف عمل'} — ${open.employeeName}` : ''} subtitle={open ? `${open.employeeNo} · ${open.branchName} · ${formatDateTime(open.createdAt)}` : ''} onClose={() => setOpen(null)}>
        {open && <Decision row={open} onReceipt={() => void receipt(open)} onDone={() => { setOpen(null); rows.reload(); }} />}
      </Dialog>
    </section>
  );
}

function Decision({ row, onReceipt, onDone }: { row: Row; onReceipt: () => void; onDone: () => void }) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [installment, setInstallment] = useState(row.months ? Math.floor(row.amount / row.months) : row.amount);
  const [startPeriod, setStartPeriod] = useState(row.startPeriod ?? '');
  const [note, setNote] = useState('');
  async function decide(action: 'approve' | 'reject') {
    setBusy(true);
    try {
      await session.call(`/requests/${row.id}/decision`, { body: { action, note: note.trim() || undefined, ...(row.kind === 'loan' && action === 'approve' ? { installment, startPeriod } : {}) } });
      session.notify(action === 'approve' ? (row.kind === 'loan' ? 'وافقت على السلفة وأُنشئت بأقساطها.' : 'وافقت على تكاليف العمل؛ بانتظار الصرف من المالية.') : 'رُفض الطلب.');
      onDone();
    } catch (error) {
      session.fail(error, 'تعذر حفظ القرار.');
    } finally {
      setBusy(false);
    }
  }
  async function paid() {
    setBusy(true);
    try {
      await session.call(`/requests/${row.id}/paid`, { method: 'POST' });
      session.notify('سُجّل الصرف.');
      onDone();
    } catch (error) {
      session.fail(error, 'تعذر التسجيل.');
    } finally {
      setBusy(false);
    }
  }
  return <div className="decision">
    <dl className="facts">
      <div><dt>المبلغ</dt><dd><strong>{formatMoney(row.amount, row.currency)}</strong></dd></div>
      {row.kind === 'loan' ? <>
        <div><dt>عدد الأشهر</dt><dd>{row.months}</dd></div>
        <div><dt>من شهر</dt><dd>{row.startPeriod ? monthLabel(row.startPeriod) : '—'}</dd></div>
      </> : <div><dt>تاريخ المصروف</dt><dd>{row.expenseDate ? formatDate(row.expenseDate) : '—'}</dd></div>}
      <div className="facts-wide"><dt>السبب / الوصف</dt><dd>{row.description}</dd></div>
      <div><dt>الحالة</dt><dd><StatusTag map={REQUEST_STATUS} value={row.status} /></dd></div>
      {row.hasReceipt && <div><dt>الوصل</dt><dd><button className="text-button" onClick={onReceipt}><Paperclip size={13} />{row.receiptName ?? 'فتح'}</button></dd></div>}
    </dl>
    {row.decidedAt && <div className="decision-signed">
      <span>{row.status === 'rejected' ? 'رفضه' : 'وافق عليه'} {row.decidedByName} · {formatDateTime(row.decidedAt)}{row.decisionNote ? ` — ${row.decisionNote}` : ''}</span>
      {row.decisionSignature && <img src={row.decisionSignature} alt="التوقيع" />}
      {row.paidAt && <span>صُرف بواسطة {row.paidByName} · {formatDateTime(row.paidAt)}</span>}
    </div>}
    {row.status === 'pending' && session.can('requests.manage') && <>
      {row.kind === 'loan' && <div className="form-grid form-grid-2">
        <label className="field"><span>القسط الشهري المعتمد</span><input type="number" min={1} value={installment} onChange={(event) => setInstallment(Number(event.target.value))} /></label>
        <label className="field"><span>أول شهر استقطاع</span><input type="month" value={startPeriod} onChange={(event) => setStartPeriod(event.target.value)} /></label>
      </div>}
      <label className="field"><span>ملاحظة (إلزامية عند الرفض)</span><input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label>
      <p className="muted small">يُرفق توقيعك الإلكتروني المحفوظ بالقرار.</p>
      <div className="dialog-actions">
        <button className="button button-primary" disabled={busy} onClick={() => void decide('approve')}><Check size={15} />موافقة</button>
        <button className="button button-quiet danger" disabled={busy || !note.trim()} onClick={() => void decide('reject')}><X size={15} />رفض</button>
      </div>
    </>}
    {row.status === 'approved' && row.kind === 'expense' && session.can('payroll.disburse') && <div className="dialog-actions">
      <button className="button button-primary" disabled={busy} onClick={() => void paid()}><Wallet size={15} />تسجيل الصرف</button>
    </div>}
  </div>;
}

interface Account { id: string; employeeNo: string; fullName: string; phone: string | null; branchName: string; userId: string | null; username: string | null; role: string | null; isActive: boolean | null; lastLoginAt: string | null; invitePending: boolean }

/** Portal accounts: one invitation link per employee, sent by HR (nothing is sent automatically). */
export function PortalAccountsPage() {
  const session = useSession();
  const accounts = useLoad<Account[]>('/portal/accounts', []);
  const [query, setQuery] = useState('');
  const [link, setLink] = useState<{ account: Account; url: string } | null>(null);
  const base = window.location.origin;
  const rows = accounts.data.filter((row) => !query.trim() || `${row.fullName} ${row.employeeNo} ${row.branchName}`.includes(query.trim()));

  async function invite(account: Account) {
    try {
      const result = await session.call<{ data: { path: string } }>(`/portal/accounts/${account.id}/invite`, { method: 'POST' });
      setLink({ account, url: `${base}${result.data.path}` });
      accounts.reload();
    } catch (error) {
      session.fail(error, 'تعذر إنشاء الرابط.');
    }
  }
  const message = (account: Account, url: string) => `مرحباً ${account.fullName}،\nهذا رابط تفعيل حسابك في بوابة موظفي مجموعة الليث العبيدي. اختر كلمة مرورك من الرابط (صالح 7 أيام)، ثم ادخل برقمك الوظيفي ${account.employeeNo}.\n${url}`;
  const whatsapp = (account: Account, url: string) => {
    const phone = (account.phone ?? '').replace(/\D/g, '').replace(/^0/, '964');
    return `https://wa.me/${phone}?text=${encodeURIComponent(message(account, url))}`;
  };

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="حسابات بوابة الموظفين" en="Employee Portal Accounts" /></h2><p>أنشئ رابط تفعيل لكل موظف وأرسله له. يدخل الموظف برقمه الوظيفي وكلمة المرور التي يختارها.</p></div></div>
      <div className="stat-row">
        <Stat label="الموظفون" value={formatNumber(accounts.data.length)} />
        <Stat label="لهم حساب" value={formatNumber(accounts.data.filter((row) => row.userId).length)} tone="good" />
        <Stat label="دخلوا فعلاً" value={formatNumber(accounts.data.filter((row) => row.lastLoginAt).length)} />
      </div>
      <section className="panel">
        <div className="filter-bar"><label className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث بالاسم أو الرقم أو الفرع…" /></label><span className="result-count">{rows.length}</span></div>
        {accounts.loading ? <Loading /> : <div className="table-scroll"><table className="dense">
          <thead><tr><th>الموظف</th><th>الفرع</th><th>اسم الدخول</th><th>الحالة</th><th /></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}>
            <td><strong>{row.fullName}</strong><small className="table-sub">{row.phone ?? 'لا يوجد هاتف'}</small></td>
            <td>{row.branchName}</td>
            <td dir="ltr">{row.username ?? (row.userId ? '—' : row.employeeNo)}</td>
            <td>{!row.userId ? <span className="muted">بلا حساب</span> : row.lastLoginAt ? <span className="good-text">دخل · {formatDateTime(row.lastLoginAt)}</span> : row.invitePending ? <span className="warn-text">دعوة مرسلة</span> : <span className="muted">لم يدخل بعد</span>}</td>
            <td>{row.role && row.role !== 'employee' ? <span className="muted">حساب موظفين</span> : <button className="button button-quiet" onClick={() => void invite(row)}><Link2 size={14} />{row.userId ? 'رابط جديد' : 'إنشاء ودعوة'}</button>}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>
      <Dialog open={Boolean(link)} title="رابط تفعيل البوابة" subtitle={link ? `${link.account.fullName} · يدخل بالرقم ${link.account.employeeNo}` : ''} onClose={() => setLink(null)}>
        {link && <div className="invite-link">
          <textarea readOnly rows={5} value={message(link.account, link.url)} />
          <div className="dialog-actions">
            <button className="button button-primary" onClick={() => void navigator.clipboard.writeText(message(link.account, link.url)).then(() => session.notify('نُسخت الرسالة.'))}><Copy size={15} />نسخ الرسالة</button>
            {link.account.phone && <a className="button button-quiet" href={whatsapp(link.account, link.url)} target="_blank" rel="noopener noreferrer"><MessageCircle size={15} />فتح في واتساب</a>}
          </div>
          <p className="muted small">الرابط صالح 7 أيام ويعمل مرة واحدة. إنشاء رابط جديد يلغي السابق.</p>
        </div>}
      </Dialog>
    </section>
  );
}
