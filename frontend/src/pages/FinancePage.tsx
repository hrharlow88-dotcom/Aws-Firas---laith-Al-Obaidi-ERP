import { useEffect, useState } from 'react';
import { CheckCircle2, Download, Landmark, Link2, PlugZap, RefreshCw, Save, Send, XCircle } from 'lucide-react';
import { Dialog, Empty, Loading, StatusTag, Tabs, Tone, Warning, useReasonPrompt } from '../components/ui';
import { downloadFile } from '../lib/api';
import { JOURNAL_STATUS, formatDateTime, formatMoney, formatNumber, monthLabel } from '../lib/format';
import { navigate } from '../lib/router';
import { useCrumb } from '../lib/breadcrumbs';
import { useLoad, useSession } from '../lib/session';

type Tab = 'journals' | 'mappings' | 'sap';

interface Mapping {
  mappingKey: string; label: string; category: 'earning' | 'deduction' | 'net'; active: boolean; side: 'debit' | 'credit';
  debitAccount: string | null; creditAccount: string | null; useCostCenter: boolean;
}

export function FinancePage({ params }: { params: string[] }) {
  const [tab, setTab] = useState<Tab>('journals');
  if (params[0] === 'journal' && params[1]) return <JournalView id={params[1]} />;
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2>المالية والربط مع SAP Business One</h2><p>قيود الرواتب تُبنى من المسيرات المعتمدة وتُرحّل إلى SAP عبر Service Layer، مع منع التكرار وإعادة المحاولة تلقائياً.</p></div></div>
      <Tabs<Tab> value={tab} onChange={setTab} items={[
        { id: 'journals', label: 'القيود' },
        { id: 'mappings', label: 'ربط الحسابات' },
        { id: 'sap', label: 'اتصال SAP' },
      ]} />
      {tab === 'journals' && <JournalsList />}
      {tab === 'mappings' && <MappingsView />}
      {tab === 'sap' && <SapStatus />}
    </section>
  );
}

function JournalsList() {
  const journals = useLoad<Array<{ id: string; reference: string; period: string | null; entryDate: string; memo: string; currency: string; total: number; status: string; attempts: number; lastError: string | null; sapTransId: number | null; postedAt: string | null; createdByName: string }>>('/finance/journals', []);
  return (
    <section className="panel">
      {journals.loading ? <Loading /> : journals.data.length ? <div className="table-scroll"><table>
        <thead><tr><th>المرجع</th><th>البيان</th><th>التاريخ</th><th>المبلغ</th><th>الحالة</th><th>رقم SAP</th><th /></tr></thead>
        <tbody>{journals.data.map((row) => <tr key={row.id} className={row.status === 'cancelled' ? 'row-muted' : ''}>
          <td dir="ltr"><span className="code-tag">{row.reference}</span></td>
          <td>{row.memo}<small className="table-sub">{row.createdByName}</small></td>
          <td>{row.entryDate}</td>
          <td>{formatMoney(row.total, row.currency)}</td>
          <td><StatusTag map={JOURNAL_STATUS} value={row.status} />{row.lastError && row.status !== 'posted' && <small className="table-sub bad-text wrap">{row.lastError}</small>}</td>
          <td>{row.sapTransId ?? '—'}</td>
          <td><button className="text-button" onClick={() => navigate('finance', 'journal', row.id)}>فتح</button></td>
        </tr>)}</tbody>
      </table></div> : <Empty icon={<Landmark size={22} />} title="لا توجد قيود بعد" text="بعد اعتماد مسير رواتب، أنشئ قيده من صفحة المسير." />}
    </section>
  );
}

function JournalView({ id }: { id: string }) {
  const session = useSession();
  const journal = useLoad<{
    id: string; reference: string; memo: string; currency: string; entryDate: string; totalDebit: number; totalCredit: number;
    status: string; attempts: number; lastError: string | null; sapTransId: number | null; sourceId: string;
    lines: Array<{ lineNo: number; accountCode: string; debit: number; credit: number; costCenter: string | null; memo: string | null }>;
  } | null>(`/finance/journals/${id}`, null);
  useCrumb(journal.data?.reference);
  const reason = useReasonPrompt();
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const data = journal.data;
  const canPost = session.can('finance.post');

  async function post() {
    setBusy(true);
    try {
      const result = await session.call<{ data: { status: string; lastError: string | null } }>(`/finance/journals/${id}/post`, { method: 'POST' });
      if (result.data.status === 'posted') session.notify('رُحّل القيد إلى SAP.');
      else if (result.data.status === 'failed') session.notify(`رفض SAP القيد: ${result.data.lastError}`, true);
      else session.notify('القيد في الطابور؛ سيعاد المحاولة تلقائياً عند توفر الاتصال.');
      journal.reload();
    } catch (error) {
      session.fail(error, 'تعذر الترحيل.');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    const value = await reason.ask('سبب إلغاء القيد');
    if (!value) return;
    try {
      await session.call(`/finance/journals/${id}/cancel`, { body: { reason: value } });
      session.notify('أُلغي القيد. يمكنك إنشاء قيد جديد من المسير.');
      journal.reload();
    } catch (error) {
      session.fail(error, 'تعذر الإلغاء.');
    }
  }

  async function markPosted(form: FormData) {
    try {
      await session.call(`/finance/journals/${id}/mark-posted`, { body: { sapTransId: Number(form.get('sapTransId')), note: form.get('note') } });
      session.notify('سُجل القيد كمُدخل يدوياً في SAP.');
      setManual(false);
      journal.reload();
    } catch (error) {
      session.fail(error, 'تعذر التسجيل.');
    }
  }

  if (journal.loading && !data) return <section className="screen"><Loading /></section>;
  if (!data) return null;
  return (
    <section className="screen">
      <div className="screen-heading">
        <div><h2>{data.memo}</h2><p><span className="code-tag" dir="ltr">{data.reference}</span> · {data.entryDate} · <StatusTag map={JOURNAL_STATUS} value={data.status} />{data.sapTransId ? ` · رقم القيد في SAP: ${data.sapTransId}` : ''}</p></div>
        <div className="heading-actions">
          <button className="button button-quiet" onClick={() => navigate('payroll', data.sourceId)}>المسير</button>
          <button className="button button-quiet" onClick={() => void downloadFile(`/finance/journals/${id}/export.csv`, session.token, `${data.reference}.csv`).catch((error) => session.fail(error, 'تعذر التصدير.'))}><Download size={16} />CSV</button>
          {canPost && ['draft', 'failed'].includes(data.status) && <>
            <button className="button button-quiet" onClick={() => setManual(true)}>أُدخل يدوياً</button>
            <button className="button button-quiet danger" onClick={() => void cancel()}>إلغاء</button>
            <button className="button button-primary" disabled={busy} onClick={() => void post()}><Send size={16} />{busy ? 'جارٍ الترحيل…' : 'ترحيل إلى SAP'}</button>
          </>}
        </div>
      </div>
      {data.lastError && data.status !== 'posted' && <Warning title={data.status === 'failed' ? 'رفض SAP القيد' : `محاولة ${data.attempts} لم تنجح`}>{data.lastError}</Warning>}
      <section className="panel"><div className="table-scroll"><table className="dense">
        <thead><tr><th>#</th><th>الحساب</th><th>البيان</th><th>مركز الكلفة</th><th>مدين</th><th>دائن</th></tr></thead>
        <tbody>{data.lines.map((line) => <tr key={line.lineNo}>
          <td>{line.lineNo}</td><td dir="ltr"><span className="code-tag">{line.accountCode}</span></td><td>{line.memo}</td>
          <td dir="ltr">{line.costCenter ?? '—'}</td>
          <td>{line.debit ? formatNumber(line.debit, 2) : ''}</td><td>{line.credit ? formatNumber(line.credit, 2) : ''}</td>
        </tr>)}</tbody>
        <tfoot><tr><th colSpan={4}>المجموع ({data.currency})</th><th>{formatNumber(data.totalDebit, 2)}</th><th>{formatNumber(data.totalCredit, 2)}</th></tr></tfoot>
      </table></div></section>
      <Dialog open={manual} title="تسجيل قيد مُدخل يدوياً في SAP" subtitle="استخدمه فقط إذا أدخلت القيد بنفسك في SAP (مثلاً من ملف CSV)." onClose={() => setManual(false)}>
        <form onSubmit={(event) => { event.preventDefault(); void markPosted(new FormData(event.currentTarget)); }}>
          <div className="form-grid form-grid-2">
            <label className="field"><span>رقم القيد في SAP *</span><input name="sapTransId" type="number" min={1} required /></label>
            <label className="field"><span>ملاحظة *</span><input name="note" required maxLength={500} /></label>
          </div>
          <div className="dialog-actions"><button className="button button-primary">تسجيل</button><button type="button" className="button button-quiet" onClick={() => setManual(false)}>إلغاء</button></div>
        </form>
      </Dialog>
      {reason.element}
    </section>
  );
}

function MappingsView() {
  const session = useSession();
  const mappings = useLoad<Mapping[]>('/finance/mappings', []);
  const status = useLoad<{ configured: boolean; connected?: boolean } | null>('/finance/sap/status', null);
  const accounts = useLoad<Array<{ code: string; name: string }>>(
    status.data?.connected && session.can('finance.manage') ? '/finance/sap/accounts' : null, [],
  );
  const [rows, setRows] = useState<Mapping[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => setRows(mappings.data), [mappings.data]);
  const canEdit = session.can('finance.manage');
  const accountName = (code: string | null) => (code ? accounts.data.find((item) => item.code === code)?.name : undefined);

  function update(key: string, patch: Partial<Mapping>) {
    setRows((current) => current.map((row) => (row.mappingKey === key ? { ...row, ...patch } : row)));
  }

  async function save() {
    setBusy(true);
    try {
      await session.call('/finance/mappings', {
        method: 'PUT',
        body: { mappings: rows.map(({ mappingKey, debitAccount, creditAccount, useCostCenter }) => ({ mappingKey, debitAccount, creditAccount, useCostCenter })) },
      });
      session.notify('حُفظ ربط الحسابات.');
      mappings.reload();
    } catch (error) {
      session.fail(error, 'تعذر الحفظ.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head"><div><h3>ربط مكونات الراتب بدليل حسابات SAP</h3><p>الاستحقاقات تُقيد مدينة على حسابات المصاريف (موزعة على مراكز الكلفة من الأقسام)، والاستقطاعات وصافي الرواتب دائنة.</p></div>
        {canEdit && <button className="button button-primary" disabled={busy} onClick={() => void save()}><Save size={16} />حفظ</button>}</div>
      {accounts.data.length > 0 && <datalist id="sap-accounts">{accounts.data.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</datalist>}
      {mappings.loading ? <Loading /> : <div className="table-scroll"><table className="dense">
        <thead><tr><th>المكوّن</th><th>النوع</th><th>الحساب</th><th>مركز الكلفة</th></tr></thead>
        <tbody>{rows.map((row) => {
          const field = row.side === 'debit' ? 'debitAccount' : 'creditAccount';
          const value = row[field];
          return <tr key={row.mappingKey} className={!row.active ? 'row-muted' : ''}>
            <td><strong>{row.label}</strong>{!row.active && <small className="table-sub">غير مفعّل</small>}</td>
            <td>{row.category === 'earning' ? <Tone tone="info">مدين · مصروف</Tone> : row.category === 'net' ? <Tone tone="good">دائن · رواتب مستحقة</Tone> : <Tone tone="warn">دائن · استقطاع</Tone>}</td>
            <td><input className="cell-input" dir="ltr" list="sap-accounts" disabled={!canEdit} value={value ?? ''} placeholder="رمز الحساب" pattern="[A-Za-z0-9._\-]*" onChange={(event) => update(row.mappingKey, { [field]: event.target.value.trim() || null } as Partial<Mapping>)} />
              {value && accounts.data.length > 0 && (accountName(value) ? <small className="table-sub">{accountName(value)}</small> : <small className="table-sub bad-text">غير موجود في SAP</small>)}</td>
            <td><label className="settings-check"><input type="checkbox" disabled={!canEdit} checked={row.useCostCenter} onChange={(event) => update(row.mappingKey, { useCostCenter: event.target.checked })} />حسب القسم</label></td>
          </tr>;
        })}</tbody>
      </table></div>}
    </section>
  );
}

function SapStatus() {
  const status = useLoad<{ configured: boolean; connected?: boolean; error?: string; localCurrency: string; companyDb?: string } | null>('/finance/sap/status', null);
  const data = status.data;
  return (
    <section className="panel">
      <div className="panel-head"><div><h3>اتصال SAP Business One</h3><p>بيانات الدخول تُضبط في ملف إعدادات الخادم فقط ولا تُخزن في قاعدة البيانات.</p></div>
        <button className="button button-quiet" onClick={status.reload}><RefreshCw size={15} />فحص الاتصال</button></div>
      {status.loading ? <Loading label="جارٍ الاتصال بـ SAP…" /> : data && <div className="panel-pad">
        {!data.configured && <Warning title="الاتصال غير مضبوط">أضف في ملف .env على الخادم: SAP_B1_URL (مثل https://sap-server:50000/b1s/v1) و SAP_B1_COMPANY_DB و SAP_B1_USER و SAP_B1_PASSWORD، ثم أعد تشغيل الخدمة. حتى ذلك الحين يمكن تصدير القيود CSV وإدخالها يدوياً.</Warning>}
        {data.configured && <div className="connection-card">
          {data.connected ? <CheckCircle2 size={28} className="good-text" /> : <XCircle size={28} className="bad-text" />}
          <div><strong>{data.connected ? 'متصل' : 'تعذر الاتصال'}</strong>
            <p>قاعدة الشركة: <b dir="ltr">{data.companyDb ?? '—'}</b> · العملة المحلية في SAP: <b>{data.localCurrency}</b> (قيود العملات الأخرى تُرحّل كعملة أجنبية)</p>
            {data.error && <p className="bad-text">{data.error}</p>}</div>
        </div>}
      </div>}
      <div className="panel-pad">
        <Warning title="قبل التشغيل الفعلي">جرّب الترحيل أولاً على شركة اختبار في SAP، وتأكد من صحة الحسابات ومراكز الكلفة وأن الفترة المحاسبية مفتوحة. كل قيد يحمل مرجعاً فريداً (PAY-…)، ويبحث النظام عنه في SAP قبل كل محاولة فلا يتكرر القيد.</Warning>
      </div>
    </section>
  );
}

export function AuditPage() {
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({ page: String(page), ...(action ? { action } : {}), ...(from ? { from } : {}) });
  const audit = useLoad<Array<{ id: string; createdAt: string; action: string; entityType: string; entityId: string | null; details: Record<string, unknown> | null; ip: string | null; userName: string; employeeName: string | null }>>(`/audit?${query}`, []);
  const groups: Record<string, string> = {
    '': 'كل العمليات', employee: 'الموظفون', attendance: 'الحضور', payroll: 'الرواتب', finance: 'المالية', settings: 'الإعدادات',
    department: 'الهيكل', leave: 'الإجازات', integration: 'الربط', user: 'المستخدمون',
  };
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2>سجل التدقيق</h2><p>كل عملية حساسة مسجلة باسم منفذها ووقتها. السجل غير قابل للتعديل أو الحذف حتى من قاعدة البيانات.</p></div></div>
      <section className="panel">
        <div className="toolbar">
          <label className="field"><span>النوع</span><select value={action} onChange={(event) => { setAction(event.target.value); setPage(1); }}>{Object.entries(groups).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="field"><span>منذ</span><input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></label>
        </div>
        {audit.loading ? <Loading /> : audit.data.length ? <div className="table-scroll"><table className="dense">
          <thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th><th>السجل</th><th>التفاصيل</th></tr></thead>
          <tbody>{audit.data.map((row) => <tr key={row.id}>
            <td>{formatDateTime(row.createdAt)}<small className="table-sub" dir="ltr">{row.ip ?? ''}</small></td>
            <td>{row.userName}</td>
            <td dir="ltr"><span className="code-tag">{row.action}</span></td>
            <td>{row.employeeName ? <button className="text-button" onClick={() => navigate('employees', row.entityId!)}>{row.employeeName}</button> : row.entityType}</td>
            <td className="audit-details">{row.details ? <details><summary>عرض</summary><pre dir="ltr">{JSON.stringify(row.details, null, 1)}</pre></details> : '—'}</td>
          </tr>)}</tbody>
        </table></div> : <Empty icon={<Link2 size={22} />} title="لا توجد عمليات مطابقة" text="غيّر عوامل التصفية." />}
        <div className="pagination"><span>صفحة {page}</span><div>
          <button className="button button-quiet" disabled={page <= 1} onClick={() => setPage(page - 1)}>الأحدث</button>
          <button className="button button-quiet" disabled={audit.data.length < 50} onClick={() => setPage(page + 1)}>الأقدم</button>
        </div></div>
      </section>
    </section>
  );
}

export function IntegrationsPage() {
  const session = useSession();
  const keys = useLoad<Array<{ id: string; name: string; keyPrefix: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; createdByName: string }>>('/integrations/keys', []);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const scopeLabels: Record<string, string> = { 'employees.read': 'قراءة الموظفين', 'org.read': 'قراءة الهيكل التنظيمي', 'attendance.read': 'قراءة ملخص الحضور' };

  async function create(form: FormData) {
    try {
      const result = await session.call<{ data: { key: string } }>('/integrations/keys', { body: { name: form.get('name'), scopes: form.getAll('scopes') } });
      setCreated(result.data.key);
      setCreating(false);
      keys.reload();
    } catch (error) {
      session.fail(error, 'تعذر إنشاء المفتاح.');
    }
  }

  async function revoke(id: string) {
    if (!window.confirm('إلغاء المفتاح يوقف الربط فوراً. متابعة؟')) return;
    try {
      await session.call(`/integrations/keys/${id}/revoke`, { method: 'POST' });
      keys.reload();
    } catch (error) {
      session.fail(error, 'تعذر الإلغاء.');
    }
  }

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2>الربط مع الأنظمة الأخرى</h2><p>مفاتيح للقراءة فقط لأنظمة المجموعة الأخرى (مثل بوابة الأوصاف الوظيفية ومؤشرات الأداء). لا تكشف رواتب أو أرقام هويات.</p></div>
        <button className="button button-primary" onClick={() => setCreating(true)}><PlugZap size={16} />مفتاح جديد</button></div>
      {created && <div className="callout callout-good"><CheckCircle2 size={17} /><div><strong>انسخ المفتاح الآن — لن يظهر مرة أخرى</strong><code className="secret" dir="ltr">{created}</code><span>يُرسل في الترويسة X-API-Key إلى <span dir="ltr">/api/integrations/v1/employees</span> و <span dir="ltr">/org</span> و <span dir="ltr">/attendance-summary</span>.</span></div><button className="icon-button" onClick={() => setCreated(null)} aria-label="إغلاق">×</button></div>}
      <section className="panel">
        {keys.loading ? <Loading /> : keys.data.length ? <div className="table-scroll"><table>
          <thead><tr><th>النظام</th><th>المفتاح</th><th>الصلاحيات</th><th>آخر استخدام</th><th>الحالة</th><th /></tr></thead>
          <tbody>{keys.data.map((key) => <tr key={key.id} className={key.revokedAt ? 'row-muted' : ''}>
            <td><strong>{key.name}</strong><small className="table-sub">{key.createdByName} · {formatDateTime(key.createdAt)}</small></td>
            <td dir="ltr"><span className="code-tag">lo_{key.keyPrefix}_••••</span></td>
            <td className="wrap">{key.scopes.map((scope) => scopeLabels[scope] ?? scope).join('، ')}</td>
            <td>{formatDateTime(key.lastUsedAt)}</td>
            <td>{key.revokedAt ? <Tone tone="muted">ملغى</Tone> : <Tone tone="good">فعّال</Tone>}</td>
            <td>{!key.revokedAt && <button className="table-action" onClick={() => void revoke(key.id)}>إلغاء</button>}</td>
          </tr>)}</tbody>
        </table></div> : <Empty icon={<PlugZap size={22} />} title="لا توجد مفاتيح ربط" text="أنشئ مفتاحاً لكل نظام على حدة لتتمكن من إلغائه دون التأثير على غيره." />}
      </section>
      <Dialog open={creating} title="مفتاح ربط جديد" onClose={() => setCreating(false)}>
        <form onSubmit={(event) => { event.preventDefault(); void create(new FormData(event.currentTarget)); }}>
          <label className="field"><span>اسم النظام *</span><input name="name" required maxLength={120} placeholder="بوابة الأوصاف الوظيفية" /></label>
          <div className="checks">{Object.entries(scopeLabels).map(([value, label]) => <label className="settings-check" key={value}><input type="checkbox" name="scopes" value={value} defaultChecked={value !== 'attendance.read'} />{label}</label>)}</div>
          <div className="dialog-actions"><button className="button button-primary">إنشاء</button><button type="button" className="button button-quiet" onClick={() => setCreating(false)}>إلغاء</button></div>
        </form>
      </Dialog>
    </section>
  );
}

