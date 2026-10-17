import { FormEvent, useState } from 'react';
import { CalendarCheck2, CalendarPlus, Check, Gift, Sparkles, Trash2 } from 'lucide-react';
import { Bi } from '../components/Brand';
import { EmployeePicker, PickedEmployee } from '../components/EmployeePicker';
import { Dialog, Empty, Loading, Stat, Tone } from '../components/ui';
import { formatDate, formatDateTime, formatNumber, previousPeriod, WEEKDAYS } from '../lib/format';
import { useLoad, useSession } from '../lib/session';

interface Holiday { date: string; nameAr: string; nameEn: string | null; source: string; confirmed: boolean; confirmedByName?: string | null; confirmedAt?: string | null }

const SOURCE: Record<string, string> = { fixed: 'تاريخ ثابت', hijri: 'هجري (تقريبي)', manual: 'أُضيف يدوياً' };

/**
 * The official holiday calendar. The system proposes each year's holidays
 * (fixed dates, and Hijri ones by the Umm al-Qura calendar, which move with
 * the moon sighting); nothing counts until the owner confirms it as the
 * government announces it. Confirmed days feed leave, attendance and payroll.
 */
export function HolidaysPage() {
  const session = useSession();
  const [year, setYear] = useState(new Date().getFullYear());
  const data = useLoad<{ year: number; holidays: Holiday[]; compDays: number }>(`/holidays?year=${year}`, { year, holidays: [], compDays: 1 });
  const [adding, setAdding] = useState(false);
  const owner = session.user.role === 'super_admin';
  const manage = session.can('calendar.manage');
  const holidays = data.data.holidays;

  async function propose() {
    try { const result = await session.call<{ data: { added: number } }>('/holidays/propose', { method: 'POST', body: { year } }); session.notify(`أُضيف ${result.data.added} عطلة مقترحة لسنة ${year}.`); data.reload(); }
    catch (error) { session.fail(error, 'تعذر الاقتراح.'); }
  }
  async function confirm(holiday: Holiday, on: boolean) {
    try { await session.call(`/holidays/${holiday.date}/confirm`, { method: 'POST', body: { confirmed: on } }); session.notify(on ? 'أُكدت العطلة.' : 'أُلغي التأكيد.'); data.reload(); session.refreshSettings(); }
    catch (error) { session.fail(error, 'تعذر التنفيذ.'); }
  }
  async function remove(holiday: Holiday) {
    if (!window.confirm(`حذف ${holiday.nameAr} (${holiday.date})؟`)) return;
    try { await session.call(`/holidays/${holiday.date}`, { method: 'DELETE' }); data.reload(); session.refreshSettings(); }
    catch (error) { session.fail(error, 'تعذر الحذف.'); }
  }
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await session.call('/holidays', { method: 'POST', body: { date: form.get('date'), nameAr: form.get('nameAr'), nameEn: form.get('nameEn') || null, confirmed: owner && form.get('confirmed') === 'on' } });
      setAdding(false); data.reload(); session.refreshSettings();
    } catch (error) { session.fail(error, 'تعذر الحفظ.'); }
  }

  return (
    <section className="screen">
      <div className="screen-heading">
        <div><h2><Bi ar="العطل الرسمية" en="Official holidays" /></h2>
          <p>جدول العطل الرسمية لكل سنة. يقترح النظام العطل الثابتة والعطل الهجرية بتواريخ تقريبية، وتبقى «بانتظار التأكيد» حتى يثبّتها المالك حسب إعلان الحكومة. من يعمل في عطلة رسمية مؤكدة يُمنح إجازة تعويضية ({data.data.compDays} يوم) خارج رصيد إجازته السنوية.</p></div>
        <div className="row-actions">
          <input type="number" className="year-input" value={year} min={2020} max={2100} onChange={(event) => setYear(Number(event.target.value) || year)} />
          {manage && <button className="button button-quiet" onClick={() => void propose()}><Sparkles size={15} />اقتراح عطل {year}</button>}
          {manage && <button className="button button-primary" onClick={() => setAdding(true)}><CalendarPlus size={15} />عطلة</button>}
        </div>
      </div>
      <div className="stat-row"><Stat label="العطل المؤكدة" value={formatNumber(holidays.filter((item) => item.confirmed).length)} tone="good" />
        <Stat label="بانتظار التأكيد" value={formatNumber(holidays.filter((item) => !item.confirmed).length)} tone={holidays.some((item) => !item.confirmed) ? 'warn' : undefined} /></div>
      <section className="panel">
        {data.loading ? <Loading /> : !holidays.length
          ? <Empty icon={<CalendarCheck2 size={22} />} title={`لا توجد عطل لسنة ${year}`} text="اضغط «اقتراح العطل» ليملأ النظام السنة، ثم أكّد كل عطلة عند إعلانها." />
          : <div className="table-scroll"><table className="dense"><thead><tr><th>التاريخ</th><th>اليوم</th><th>العطلة</th><th>المصدر</th><th>الحالة</th><th /></tr></thead>
            <tbody>{holidays.map((holiday) => <tr key={holiday.date}>
              <td dir="ltr">{holiday.date}</td><td>{WEEKDAYS[new Date(`${holiday.date}T00:00:00Z`).getUTCDay()]}</td>
              <td><strong>{holiday.nameAr}</strong>{holiday.nameEn && <small className="table-sub" dir="ltr">{holiday.nameEn}</small>}</td>
              <td>{SOURCE[holiday.source] ?? holiday.source}</td>
              <td>{holiday.confirmed ? <Tone tone="good">مؤكدة{holiday.confirmedByName ? ` · ${holiday.confirmedByName}` : ''}</Tone> : <Tone tone="warn">بانتظار التأكيد</Tone>}
                {holiday.confirmedAt && <small className="table-sub">{formatDateTime(holiday.confirmedAt)}</small>}</td>
              <td className="row-actions">
                {owner && (holiday.confirmed
                  ? <button className="button button-quiet button-small" onClick={() => void confirm(holiday, false)}>إلغاء التأكيد</button>
                  : <button className="button button-primary button-small" onClick={() => void confirm(holiday, true)}><Check size={13} />تأكيد</button>)}
                {manage && <button className="icon-button" aria-label="حذف" onClick={() => void remove(holiday)}><Trash2 size={15} /></button>}
              </td></tr>)}</tbody></table></div>}
      </section>
      <Dialog open={adding} title="إضافة عطلة" onClose={() => setAdding(false)}>
        <form className="form-grid" onSubmit={(event) => void add(event)}>
          <label className="field"><span>التاريخ *</span><input name="date" type="date" required /></label>
          <label className="field"><span>الاسم بالعربي *</span><input name="nameAr" required maxLength={120} /></label>
          <label className="field"><span>Name (English)</span><input name="nameEn" maxLength={120} dir="ltr" /></label>
          {owner && <label className="settings-check"><input type="checkbox" name="confirmed" defaultChecked />عطلة مؤكدة</label>}
          <div className="dialog-actions settings-wide"><button className="button button-primary">حفظ</button></div>
        </form>
      </Dialog>
    </section>
  );
}

interface CompCredit { id: string; employeeId: string; employeeNo: string; employeeName: string; workDate: string; days: number; reason: string | null; createdAt: string; createdByName: string }
interface Suggestion { employeeId: string; employeeNo: string; employeeName: string; workDate: string }

/** Compensatory leave: who worked on an official holiday, and the days credited to a balance apart from annual leave. */
export function CompLeavePage() {
  const session = useSession();
  const manage = session.can('leaves.manage_balances');
  const credits = useLoad<CompCredit[]>('/leaves/comp-credits', []);
  const [period, setPeriod] = useState(previousPeriod());
  const suggestions = useLoad<{ holidays: string[]; rows: Suggestion[]; compDays: number }>(manage ? `/leaves/comp-credits/suggestions?period=${period}` : null, { holidays: [], rows: [], compDays: 1 });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState(false);
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const key = (row: Suggestion) => `${row.employeeId}|${row.workDate}`;

  async function grant(items: Array<{ employeeId: string; workDate: string; days?: number; reason?: string }>) {
    try {
      const result = await session.call<{ data: { granted: number } }>('/leaves/comp-credits', { method: 'POST', body: { items } });
      session.notify(`مُنحت ${result.data.granted} إجازة تعويضية.`);
      setPicked(new Set()); credits.reload(); suggestions.reload();
    } catch (error) { session.fail(error, 'تعذر المنح.'); }
  }

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="الإجازة التعويضية" en="Compensatory leave" /></h2>
        <p>من عمل في يوم عطلة رسمية مؤكدة يُمنح أيام إجازة تعويضية في رصيد مستقل عن الإجازة السنوية، ويطلبها لاحقاً من «طلب إجازة» باختيار «إجازة تعويضية».</p></div>
        {manage && <button className="button button-primary" onClick={() => setManual(true)}><Gift size={15} />منح يدوي</button>}</div>
      {manage && <section className="panel">
        <div className="panel-head"><div><h3>عملوا في عطلة رسمية (من البصمة)</h3><p>{suggestions.data.holidays.length ? `العطل المؤكدة في الشهر: ${suggestions.data.holidays.join('، ')}` : 'لا توجد عطل مؤكدة في هذا الشهر.'}</p></div>
          <div className="row-actions"><input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} />
            {picked.size > 0 && <button className="button button-primary" onClick={() => void grant(suggestions.data.rows.filter((row) => picked.has(key(row))).map((row) => ({ employeeId: row.employeeId, workDate: row.workDate })))}>
              <Gift size={14} />منح {picked.size} ({suggestions.data.compDays} يوم لكل عطلة)</button>}</div></div>
        {suggestions.loading ? <Loading /> : !suggestions.data.rows.length ? <p className="muted">لا يوجد من بصم في عطلة رسمية بلا تعويض.</p>
          : <div className="table-scroll"><table className="dense"><thead><tr><th><input type="checkbox" checked={picked.size === suggestions.data.rows.length} onChange={(event) => setPicked(event.target.checked ? new Set(suggestions.data.rows.map(key)) : new Set())} /></th><th>الموظف</th><th>يوم العمل</th></tr></thead>
            <tbody>{suggestions.data.rows.map((row) => <tr key={key(row)}><td><input type="checkbox" checked={picked.has(key(row))} onChange={(event) => { const next = new Set(picked); if (event.target.checked) next.add(key(row)); else next.delete(key(row)); setPicked(next); }} /></td>
              <td><strong>{row.employeeName}</strong><small className="table-sub">{row.employeeNo}</small></td><td>{formatDate(row.workDate)}</td></tr>)}</tbody></table></div>}
      </section>}
      <section className="panel">
        <div className="panel-head"><div><h3>الأيام الممنوحة</h3></div></div>
        {credits.loading ? <Loading /> : !credits.data.length ? <Empty icon={<Gift size={22} />} title="لا توجد إجازات تعويضية بعد" text="—" />
          : <div className="table-scroll"><table className="dense"><thead><tr><th>الموظف</th><th>عمل يوم</th><th>الأيام</th><th>السبب</th><th>منحها</th></tr></thead>
            <tbody>{credits.data.map((row) => <tr key={row.id}><td><strong>{row.employeeName}</strong><small className="table-sub">{row.employeeNo}</small></td>
              <td>{formatDate(row.workDate)}</td><td><strong>{row.days}</strong></td><td>{row.reason ?? '—'}</td><td>{row.createdByName}<small className="table-sub">{formatDateTime(row.createdAt)}</small></td></tr>)}</tbody></table></div>}
      </section>
      <Dialog open={manual} title="منح إجازة تعويضية" onClose={() => setManual(false)}>
        <form className="form-grid" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          if (!employee) { session.notify('اختر الموظف.', true); return; }
          void grant([{ employeeId: employee.id, workDate: String(form.get('workDate')), days: Number(form.get('days')) || undefined, reason: String(form.get('reason') || '') || undefined }]).then(() => setManual(false));
        }}>
          <div className="settings-wide"><EmployeePicker label="الموظف" value={employee} onChange={setEmployee} /></div>
          <label className="field"><span>يوم العطلة الذي عمل فيه *</span><input name="workDate" type="date" required /></label>
          <label className="field"><span>الأيام</span><input name="days" type="number" min={0.5} max={5} step={0.5} placeholder={String(suggestions.data.compDays)} /></label>
          <label className="field settings-wide"><span>السبب</span><input name="reason" maxLength={300} /></label>
          <div className="dialog-actions settings-wide"><button className="button button-primary">منح</button></div>
        </form>
      </Dialog>
    </section>
  );
}
