import { FormEvent, useMemo, useState } from 'react';
import {
  CalendarDays, ChevronLeft, ChevronRight, ClipboardCheck, Copy, Inbox, Mail, Megaphone, MessageCircle, Plus, Send, Smartphone, Trash2, X,
} from 'lucide-react';
import { Bi, BiText } from '../components/Brand';
import { EmployeePicker, PickedEmployee } from '../components/EmployeePicker';
import { ANNOUNCEMENT_KIND, goTo } from '../components/Shell';
import { DocumentFrame } from '../components/DocumentFrame';
import { Dialog, Empty, Loading, Stat, Tabs, Tone } from '../components/ui';
import { formatDate, formatDateTime, formatNumber, today } from '../lib/format';
import { useLoad, useSession } from '../lib/session';

// --- My approvals -----------------------------------------------------------

interface InboxGroup { id: string; module: string; title: string; link: string; items: Array<{ id: string; title: string; detail?: string | null; at?: string | null; link?: string }> }

/** Everything waiting for me, from every app. */
export function ApprovalsPage() {
  const inbox = useLoad<{ groups: InboxGroup[]; total: number }>('/approvals/inbox', { groups: [], total: 0 });
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="اعتماداتي ومهامي" en="My approvals & to-dos" /></h2><p>كل ما ينتظر قرارك أو توقيعك أو إقرارك من كل التطبيقات في مكان واحد.</p></div>
        <button className="button button-quiet" onClick={inbox.reload}><Bi ar={"تحديث"} en={"Refresh"} /></button></div>
      <div className="stat-row"><Stat label="بانتظارك · Waiting for you" value={formatNumber(inbox.data.total)} tone={inbox.data.total ? 'warn' : undefined} />
        {inbox.data.groups.slice(0, 3).map((group) => <Stat key={group.id} label={group.title} value={formatNumber(group.items.length)} />)}</div>
      {inbox.loading ? <Loading /> : !inbox.data.groups.length
        ? <section className="panel"><Empty icon={<ClipboardCheck size={22} />} title="لا شيء بانتظارك" text="أنجزت كل الاعتمادات. · Nothing waiting for you." /></section>
        : <div className="inbox-groups">{inbox.data.groups.map((group) => <section key={group.id} className="panel inbox-group">
          <div className="panel-head"><div><h3>{group.title}</h3></div><button className="button button-quiet" onClick={() => goTo(group.link)}><Bi ar={"فتح"} en={"Open"} /><ChevronLeft size={15} /></button></div>
          <ul className="inbox-list">{group.items.map((item) => <li key={item.id}><button onClick={() => goTo(item.link ?? group.link)}>
            <strong>{item.title}</strong>{item.detail && <span>{item.detail}</span>}{item.at && <small>{formatDateTime(item.at)}</small>}
          </button></li>)}</ul>
        </section>)}</div>}
    </section>
  );
}

// --- Calendar ---------------------------------------------------------------

interface CalendarItem {
  id: string; source: string; title: string; start: string; end: string; allDay: boolean; category?: string; color?: string | null;
  editable?: boolean; link?: string | null; detail?: string | null;
}

const SOURCES: Record<string, { label: string; color: string }> = {
  event: { label: 'مواعيد · Events', color: '#E15532' },
  holiday: { label: 'عطل رسمية · Holidays', color: '#c0392b' },
  leave: { label: 'إجازات · Leave', color: '#5b8def' },
  payroll: { label: 'رواتب · Payroll', color: '#9b6bd6' },
  interview: { label: 'مقابلات · Interviews', color: '#4f7cc9' },
  expiry: { label: 'انتهاء مستمسكات · Expiries', color: '#e3a83b' },
  contract: { label: 'عقود وتجربة · Contracts', color: '#16a3a3' },
  birthday: { label: 'أعياد ميلاد · Birthdays', color: '#d4657d' },
};
const CATEGORY_LABEL: Record<string, string> = {
  meeting: 'اجتماع · Meeting', training: 'تدريب · Training', event: 'فعالية · Event', deadline: 'موعد نهائي · Deadline',
  holiday: 'عطلة · Holiday', visit: 'زيارة · Visit', other: 'أخرى · Other',
};
const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function iso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Month / week / agenda calendar over everything with a date; company events are added and edited here. */
export function CalendarPage() {
  const session = useSession();
  const [cursor, setCursor] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const [view, setView] = useState<'month' | 'agenda'>('month');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Partial<CalendarItem> & { visibility?: string; description?: string; location?: string } | null>(null);
  const gridStart = new Date(cursor); gridStart.setDate(1 - cursor.getDay());
  const gridEnd = new Date(gridStart); gridEnd.setDate(gridStart.getDate() + 41);
  const data = useLoad<{ items: CalendarItem[]; canManage: boolean }>(`/calendar?from=${iso(gridStart)}&to=${iso(gridEnd)}`, { items: [], canManage: false });
  const items = data.data.items.filter((item) => !hidden.has(item.source));
  const days = Array.from({ length: 42 }, (_, index) => { const day = new Date(gridStart); day.setDate(gridStart.getDate() + index); return day; });
  const on = (date: string) => items.filter((item) => item.start.slice(0, 10) <= date && item.end.slice(0, 10) >= date);
  const monthName = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { month: 'long', year: 'numeric' }).format(cursor);
  const monthEn = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(cursor);
  const move = (months: number) => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + months, 1));
  const agenda = useMemo(() => [...items].filter((item) => item.start.slice(0, 7) === iso(cursor).slice(0, 7) || item.end.slice(0, 7) === iso(cursor).slice(0, 7))
    .sort((a, b) => a.start.localeCompare(b.start)), [items, cursor]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const allDay = form.get('allDay') === 'on';
    const date = String(form.get('date'));
    const endDate = String(form.get('endDate') || date);
    const body = {
      title: form.get('title'), description: form.get('description') || null, category: form.get('category'), location: form.get('location') || null,
      allDay, visibility: form.get('visibility') || 'private', color: form.get('color') || null,
      start: allDay ? date : `${date}T${form.get('startTime') || '09:00'}`, end: allDay ? endDate : `${endDate}T${form.get('endTime') || '10:00'}`,
    };
    try {
      if (editing.id && editing.source === 'event') await session.call(`/calendar/events/${editing.id}`, { method: 'PUT', body });
      else await session.call('/calendar/events', { method: 'POST', body });
      session.notify('حُفظ الموعد.');
      setEditing(null);
      data.reload();
    } catch (error) { session.fail(error, 'تعذر حفظ الموعد.'); }
  }
  async function cancel() {
    if (!editing?.id) return;
    try {
      await session.call(`/calendar/events/${editing.id}/cancel`, { method: 'POST' });
      session.notify('أُلغي الموعد (يمكن استرجاعه من سلة المحذوفات).');
      setEditing(null);
      data.reload();
    } catch (error) { session.fail(error, 'تعذر الإلغاء.'); }
  }
  async function toggleHoliday(date: string, on: boolean) {
    try {
      await session.call(`/calendar/holidays/${date}`, { method: 'PUT', body: { holiday: on } });
      session.notify(on ? 'أُضيفت عطلة رسمية.' : 'أُزيلت العطلة.');
      data.reload();
    } catch (error) { session.fail(error, 'تعذر التعديل.'); }
  }
  const open = (item: CalendarItem) => {
    if (item.source === 'event' && item.editable) setEditing(item);
    else if (item.link) goTo(item.link);
  };

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="التقويم" en="Calendar" /></h2><p>الإجازات والعطل والرواتب والمقابلات وانتهاء المستمسكات والعقود ومواعيد الشركة في تقويم واحد. اضغط على أي يوم لإضافة موعد.</p></div>
        <button className="button button-primary" onClick={() => setEditing({ start: today(), end: today(), allDay: false, visibility: data.data.canManage ? 'company' : 'private', category: 'meeting' })}><Plus size={16} /><Bi ar={"موعد جديد"} en={"New"} /></button></div>
      <section className="panel">
        <div className="calendar-bar">
          <div className="calendar-nav">
            <button className="icon-button" aria-label="الشهر السابق" onClick={() => move(-1)}><ChevronRight size={18} /></button>
            <strong>{monthName}</strong><span className="muted" dir="ltr">{monthEn}</span>
            <button className="icon-button" aria-label="الشهر التالي" onClick={() => move(1)}><ChevronLeft size={18} /></button>
            <button className="button button-quiet button-small" onClick={() => { const now = new Date(); setCursor(new Date(now.getFullYear(), now.getMonth(), 1)); }}><Bi ar={"اليوم"} en={"Today"} /></button>
          </div>
          <div className="segmented"><button aria-pressed={view === 'month'} onClick={() => setView('month')}><Bi ar={"شهر"} en={"Month"} /></button><button aria-pressed={view === 'agenda'} onClick={() => setView('agenda')}><Bi ar={"جدول"} en={"Agenda"} /></button></div>
        </div>
        <div className="calendar-legend">{Object.entries(SOURCES).map(([key, value]) => <label key={key} className={hidden.has(key) ? 'is-off' : ''}>
          <input type="checkbox" checked={!hidden.has(key)} onChange={() => setHidden((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} />
          <i style={{ background: value.color }} /><BiText text={value.label} />
        </label>)}</div>
        {data.loading && <Loading />}
        {view === 'month' ? <div className="calendar-grid">
          {WEEKDAYS.map((day) => <div key={day} className="calendar-weekday">{day}</div>)}
          {days.map((day) => {
            const date = iso(day);
            const dayItems = on(date);
            const holiday = dayItems.some((item) => item.source === 'holiday');
            return <div key={date} className={`calendar-day ${day.getMonth() !== cursor.getMonth() ? 'is-other' : ''} ${date === today() ? 'is-today' : ''} ${holiday ? 'is-holiday' : ''}`}
              onDoubleClick={() => setEditing({ start: date, end: date, allDay: true, visibility: data.data.canManage ? 'company' : 'private', category: 'event' })}>
              <div className="calendar-day-head"><span>{day.getDate()}</span>
                {data.data.canManage && <button className="calendar-holiday-toggle" title={holiday ? 'إزالة العطلة' : 'تعيين عطلة رسمية'} onClick={() => void toggleHoliday(date, !holiday)}>{holiday ? '−' : '＋'}</button>}
              </div>
              {dayItems.slice(0, 4).map((item) => <button key={item.id} className="calendar-chip" style={{ borderInlineStartColor: item.color || SOURCES[item.source]?.color }}
                title={`${item.title}${item.detail ? ` — ${item.detail}` : ''}`} onClick={(event) => { event.stopPropagation(); open(item); }}>
                {!item.allDay && <b dir="ltr">{item.start.slice(11, 16)}</b>}{item.title}
              </button>)}
              {dayItems.length > 4 && <small className="calendar-more">+{dayItems.length - 4}</small>}
            </div>;
          })}
        </div> : <div className="table-scroll"><table className="dense">
          <thead><tr><th>التاريخ</th><th>الوقت</th><th>البند</th><th>النوع</th></tr></thead>
          <tbody>{agenda.map((item) => <tr key={item.id} className="row-link" onClick={() => open(item)}>
            <td>{formatDate(item.start.slice(0, 10))}{item.end.slice(0, 10) !== item.start.slice(0, 10) && <> → {formatDate(item.end.slice(0, 10))}</>}</td>
            <td dir="ltr">{item.allDay ? '—' : `${item.start.slice(11, 16)}–${item.end.slice(11, 16)}`}</td>
            <td><strong>{item.title}</strong>{item.detail && <small className="table-sub">{item.detail}</small>}</td>
            <td><span className="calendar-dot" style={{ background: item.color || SOURCES[item.source]?.color }} /><BiText text={SOURCES[item.source]?.label} /></td>
          </tr>)}</tbody>
        </table></div>}
      </section>
      <Dialog open={Boolean(editing)} title={editing?.id ? 'تعديل موعد · Edit event' : 'موعد جديد · New event'} onClose={() => setEditing(null)}>
        {editing && <form className="form-grid" onSubmit={(event) => void save(event)}>
          <label className="field settings-wide"><span><Bi ar={"العنوان *"} en={"Title *"} /></span><input name="title" required maxLength={200} defaultValue={editing.title ?? ''} /></label>
          <label className="field"><span><Bi ar={"النوع"} en={"Type"} /></span><select name="category" defaultValue={editing.category ?? 'meeting'}>{Object.entries(CATEGORY_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label className="field"><span><Bi ar={"من يراه"} en={"Visibility"} /></span><select name="visibility" defaultValue={editing.visibility ?? 'private'} disabled={!data.data.canManage}>
            <option value="private">أنا فقط · Only me</option><option value="branch">فرعي · My branch</option><option value="company">كل الشركة · Company</option></select></label>
          <label className="field"><span><Bi ar={"التاريخ"} en={"Date"} /></span><input type="date" name="date" required defaultValue={(editing.start ?? today()).slice(0, 10)} /></label>
          <label className="field"><span><Bi ar={"إلى تاريخ"} en={"Until"} /></span><input type="date" name="endDate" defaultValue={(editing.end ?? editing.start ?? today()).slice(0, 10)} /></label>
          <label className="field"><span><Bi ar={"من الساعة"} en={"From"} /></span><input type="time" name="startTime" defaultValue={editing.start?.slice(11, 16) || '09:00'} /></label>
          <label className="field"><span><Bi ar={"إلى الساعة"} en={"To"} /></span><input type="time" name="endTime" defaultValue={editing.end?.slice(11, 16) || '10:00'} /></label>
          <label className="settings-check"><input type="checkbox" name="allDay" defaultChecked={editing.allDay} /><Bi ar={"طوال اليوم"} en={"All day"} /></label>
          <label className="field"><span><Bi ar={"اللون"} en={"Colour"} /></span><input type="color" name="color" defaultValue={editing.color || '#E15532'} /></label>
          <label className="field settings-wide"><span><Bi ar={"المكان"} en={"Location"} /></span><input name="location" maxLength={200} defaultValue={editing.location ?? ''} /></label>
          <label className="field settings-wide"><span><Bi ar={"التفاصيل"} en={"Details"} /></span><textarea name="description" rows={3} maxLength={2000} defaultValue={editing.description ?? editing.detail ?? ''} /></label>
          <div className="dialog-actions settings-wide">
            <button className="button button-primary" type="submit"><Bi ar={"حفظ"} en={"Save"} /></button>
            {editing.id && <button className="button button-danger" type="button" onClick={() => void cancel()}><Trash2 size={15} />إلغاء الموعد</button>}
            <button className="button button-quiet" type="button" onClick={() => setEditing(null)}>إغلاق</button>
          </div>
        </form>}
      </Dialog>
    </section>
  );
}

// --- Announcements ----------------------------------------------------------

interface AnnouncementRow {
  id: string; titleAr: string; titleEn: string | null; bodyAr: string; bodyEn: string | null; kind: string; severity: string; audience: string;
  branchName: string | null; departmentName: string | null; employeeCount: number | null; requireAck: boolean; startsAt: string; endsAt: string | null;
  createdByName: string; audience_size: string; seen: string; acknowledged: string; signedByTitle: string | null;
}
const SEVERITY: Record<string, { label: string; tone: string }> = {
  info: { label: 'عادي · Info', tone: 'info' }, important: { label: 'مهم · Important', tone: 'warn' }, urgent: { label: 'عاجل · Urgent', tone: 'bad' },
};
const AUDIENCE: Record<string, string> = { all: 'كل الموظفين · Everyone', branch: 'فرع · Branch', department: 'قسم · Department', employees: 'موظفون محددون · Selected' };

/** HR publishes announcements, alerts, notices, invitations and circulars shown full screen to their audience. */
export function AnnouncementsPage() {
  const session = useSession();
  const list = useLoad<AnnouncementRow[]>('/announcements', []);
  const branches = useLoad<Array<{ id: string; name: string }>>('/branches', []);
  const departments = useLoad<Array<{ id: string; name: string }>>('/org/departments', []);
  const [creating, setCreating] = useState(false);
  const [audience, setAudience] = useState('all');
  const [people, setPeople] = useState<PickedEmployee[]>([]);
  const [picker, setPicker] = useState<PickedEmployee | null>(null);
  const [viewing, setViewing] = useState<AnnouncementRow | null>(null);
  const receipts = useLoad<Array<{ name: string; employeeNo: string | null; seenAt: string | null; acknowledgedAt: string | null }>>(viewing ? `/announcements/${viewing.id}/receipts` : null, []);

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await session.call('/announcements', { method: 'POST', body: {
        titleAr: form.get('titleAr'), titleEn: form.get('titleEn') || null, bodyAr: form.get('bodyAr'), bodyEn: form.get('bodyEn') || null,
        kind: form.get('kind'), severity: form.get('severity'), audience, branchId: form.get('branchId') || null, departmentId: form.get('departmentId') || null,
        employeeIds: people.map((person) => person.id), requireAck: form.get('requireAck') === 'on',
        startsAt: form.get('startsAt') ? new Date(String(form.get('startsAt'))).toISOString() : null,
        endsAt: form.get('endsAt') ? new Date(String(form.get('endsAt'))).toISOString() : null, signedByTitle: form.get('signedByTitle') || null,
      } });
      session.notify('نُشر الإعلان، وسيظهر بشاشة كاملة لكل موظف في الجمهور المحدد.');
      setCreating(false);
      setPeople([]);
      list.reload();
    } catch (error) { session.fail(error, 'تعذر النشر.'); }
  }

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="الإعلانات والتعاميم" en="Announcements & circulars" /></h2><p>يظهر الإعلان بشاشة كاملة لكل موظف في الجمهور عند فتح النظام أو البوابة، ويمكن طلب الإقرار بالاطلاع ومتابعة من اطّلع.</p></div>
        <button className="button button-primary" onClick={() => setCreating(true)}><Megaphone size={16} /><Bi ar={"إعلان جديد"} en={"New"} /></button></div>
      <section className="panel">
        {list.loading ? <Loading /> : !list.data.length ? <Empty icon={<Megaphone size={22} />} title="لا توجد إعلانات" text="انشر أول تعميم للموظفين." />
          : <div className="table-scroll"><table className="dense">
            <thead><tr><th>العنوان</th><th>النوع</th><th>الجمهور</th><th>الاطلاع</th><th>النشر</th></tr></thead>
            <tbody>{list.data.map((row) => <tr key={row.id} className="row-link" onClick={() => setViewing(row)}>
              <td><strong>{row.titleAr}</strong>{row.titleEn && <small className="table-sub" dir="ltr">{row.titleEn}</small>}</td>
              <td><BiText text={ANNOUNCEMENT_KIND[row.kind]} /><br /><Tone tone={SEVERITY[row.severity].tone}><BiText text={SEVERITY[row.severity].label} /></Tone></td>
              <td><BiText text={AUDIENCE[row.audience]} />{row.branchName && <small className="table-sub">{row.branchName}</small>}{row.departmentName && <small className="table-sub">{row.departmentName}</small>}</td>
              <td>{row.seen}/{row.audience_size}{row.requireAck && <small className="table-sub">أقرّ: {row.acknowledged}</small>}</td>
              <td>{formatDateTime(row.startsAt)}<small className="table-sub">{row.createdByName}</small></td>
            </tr>)}</tbody>
          </table></div>}
      </section>
      <Dialog wide open={creating} title="إعلان جديد · New announcement" subtitle="اكتب النص بالعربي والإنكليزي ليظهر باللغتين." onClose={() => setCreating(false)}>
        <form className="form-grid" onSubmit={(event) => void publish(event)}>
          <label className="field"><span>النوع</span><select name="kind" defaultValue="announcement">{Object.entries(ANNOUNCEMENT_KIND).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label className="field"><span>الأهمية</span><select name="severity" defaultValue="info">{Object.entries(SEVERITY).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
          <label className="field settings-wide"><span>العنوان بالعربي *</span><input name="titleAr" required maxLength={200} /></label>
          <label className="field settings-wide"><span>Title (English)</span><input name="titleEn" dir="ltr" maxLength={200} /></label>
          <label className="field settings-wide"><span>النص بالعربي *</span><textarea name="bodyAr" required rows={5} /></label>
          <label className="field settings-wide"><span>Text (English)</span><textarea name="bodyEn" dir="ltr" rows={4} /></label>
          <label className="field"><span>الجمهور</span><select value={audience} onChange={(event) => setAudience(event.target.value)}>{Object.entries(AUDIENCE).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          {audience === 'branch' && <label className="field"><span>الفرع</span><select name="branchId" required>{branches.data.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}
          {audience === 'department' && <label className="field"><span>القسم</span><select name="departmentId" required>{departments.data.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>}
          {audience === 'employees' && <div className="settings-wide">
            <EmployeePicker label="أضف موظفاً" value={picker} onChange={(employee) => { if (employee && !people.some((person) => person.id === employee.id)) setPeople([...people, employee]); setPicker(null); }} />
            <div className="chip-list">{people.map((person) => <span key={person.id} className="chip">{person.fullName}<button type="button" aria-label="إزالة" onClick={() => setPeople(people.filter((item) => item.id !== person.id))}><X size={12} /></button></span>)}</div>
          </div>}
          <label className="field"><span>يبدأ الظهور</span><input type="datetime-local" name="startsAt" /></label>
          <label className="field"><span>ينتهي الظهور</span><input type="datetime-local" name="endsAt" /></label>
          <label className="field"><span>التوقيع</span><input name="signedByTitle" defaultValue="إدارة النظام — الموارد البشرية" maxLength={120} /></label>
          <label className="settings-check"><input type="checkbox" name="requireAck" /><Bi ar={"يطلب إقراراً بالاطلاع"} en={"Require acknowledgement"} /></label>
          <div className="dialog-actions settings-wide"><button className="button button-primary" type="submit"><Send size={15} /><Bi ar={"نشر"} en={"Publish"} /></button></div>
        </form>
      </Dialog>
      <Dialog wide open={Boolean(viewing)} title={viewing?.titleAr ?? ''} onClose={() => setViewing(null)}>
        {viewing && <>
          <DocumentFrame title={viewing.titleAr} titleEn={viewing.titleEn ?? undefined} preparedBy={viewing.createdByName} fileName={viewing.titleAr}>
            <p style={{ whiteSpace: 'pre-wrap' }}>{viewing.bodyAr}</p>
            {viewing.bodyEn && <p dir="ltr" style={{ whiteSpace: 'pre-wrap' }}>{viewing.bodyEn}</p>}
            <p><b>{viewing.signedByTitle}</b></p>
          </DocumentFrame>
          <h4><Bi ar={"من اطّلع"} en={"Who has seen it"} /></h4>
          <div className="table-scroll"><table className="dense"><thead><tr><th>الاسم</th><th>اطّلع</th><th>أقرّ</th></tr></thead>
            <tbody>{receipts.data.map((row, index) => <tr key={index}><td>{row.name}<small className="table-sub">{row.employeeNo}</small></td>
              <td>{row.seenAt ? formatDateTime(row.seenAt) : <Tone tone="warn">لم يطّلع</Tone>}</td><td>{row.acknowledgedAt ? formatDateTime(row.acknowledgedAt) : '—'}</td></tr>)}</tbody></table></div>
          <div className="dialog-actions"><button className="button button-danger" onClick={async () => {
            try { await session.call(`/announcements/${viewing.id}/withdraw`, { method: 'POST' }); setViewing(null); list.reload(); session.notify('سُحب الإعلان إلى سلة المحذوفات.'); }
            catch (error) { session.fail(error, 'تعذر السحب.'); }
          }}><Trash2 size={15} />سحب الإعلان</button></div>
        </>}
      </Dialog>
    </section>
  );
}

/** The employee's notice board: every announcement that reached them. */
export function NoticeBoardPage() {
  const list = useLoad<Array<{ id: string; titleAr: string; titleEn: string | null; bodyAr: string; bodyEn: string | null; kind: string; severity: string; startsAt: string; acknowledgedAt: string | null; seenAt: string | null; signedByTitle: string | null }>>('/me/announcements', []);
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="لوحة الإعلانات" en="Notice board" /></h2><p>التعاميم والتبليغات والدعوات الموجهة إليك.</p></div></div>
      {list.loading ? <Loading /> : !list.data.length ? <section className="panel"><Empty icon={<Megaphone size={22} />} title="لا توجد إعلانات" text="ستظهر هنا التعاميم الموجهة إليك." /></section>
        : <div className="notice-board">{list.data.map((row) => <article key={row.id} className={`notice-card notice-${row.severity}`}>
          <header><span><BiText text={ANNOUNCEMENT_KIND[row.kind]} /></span><small>{formatDateTime(row.startsAt)}</small></header>
          <h3>{row.titleAr}</h3>{row.titleEn && <h4 dir="ltr">{row.titleEn}</h4>}
          <p>{row.bodyAr}</p>{row.bodyEn && <p dir="ltr">{row.bodyEn}</p>}
          <footer><span>{row.signedByTitle}</span>{row.acknowledgedAt ? <Tone tone="good">أقررت بالاطلاع</Tone> : row.seenAt ? <Tone tone="info">اطلعت</Tone> : <Tone tone="warn">جديد</Tone>}</footer>
        </article>)}</div>}
    </section>
  );
}

// --- Messages (e-mail / WhatsApp / SMS) ------------------------------------

interface Template { id: string; label: string; subject: string; body: string; fields: string[] }
interface Prepared { employeeId: string; name: string; email: string | null; phone: string | null; subject: string; body: string; links: { email: string | null; whatsapp: string | null; sms: string | null } }
const FIELD_LABEL: Record<string, string> = {
  link: 'الرابط · Link', title: 'العنوان / الوظيفة · Title', date: 'التاريخ · Date', time: 'الوقت · Time', place: 'المكان · Venue', details: 'التفاصيل · Details',
};

/** Invitations and messages from ready bilingual templates, by e-mail, WhatsApp or SMS. */
export function MessagesPage() {
  const session = useSession();
  const templates = useLoad<Template[]>('/messages/templates', []);
  const channels = useLoad<Array<{ channel: string; enabled: boolean }>>('/messages/channels', []);
  const outbox = useLoad<Array<{ id: string; channel: string; recipient: string; subject: string | null; status: string; error: string | null; createdAt: string; sentAt: string | null; employeeName: string | null }>>('/messages/outbox', []);
  const [tab, setTab] = useState<'compose' | 'outbox'>('compose');
  const [templateId, setTemplateId] = useState('meeting_invite');
  const [people, setPeople] = useState<PickedEmployee[]>([]);
  const [picker, setPicker] = useState<PickedEmployee | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [use, setUse] = useState<Set<string>>(new Set(['email', 'whatsapp']));
  const [result, setResult] = useState<{ prepared: Prepared[]; queued: number; disabledChannels: string[] } | null>(null);
  const template = templates.data.find((item) => item.id === templateId);
  const enabled = new Set(channels.data.filter((item) => item.enabled).map((item) => item.channel));

  async function send() {
    try {
      const response = await session.call<{ data: typeof result }>('/messages/send', { method: 'POST', body: { templateId, employeeIds: people.map((person) => person.id), channels: [...use], values } });
      setResult(response.data);
      outbox.reload();
      session.notify(response.data!.queued ? `أُرسلت ${response.data!.queued} رسالة إلى طابور الإرسال.` : 'جُهّزت الرسائل؛ أرسلها من الروابط أدناه.');
    } catch (error) { session.fail(error, 'تعذر تجهيز الرسائل.'); }
  }

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="الدعوات والرسائل" en="Invitations & messages" /></h2><p>نماذج جاهزة باللغتين باسم إدارة النظام والموارد البشرية. القنوات المفعّلة من مالك النظام تُرسل تلقائياً، وغيرها يُرسل بزر واحد من بريدك أو واتسابك.</p></div></div>
      <div className="stat-row">
        <Stat label="البريد · E-mail" value={enabled.has('email') ? 'مفعّل' : 'يدوي'} tone={enabled.has('email') ? 'good' : undefined} />
        <Stat label="واتساب · WhatsApp" value={enabled.has('whatsapp') ? 'مفعّل' : 'يدوي'} tone={enabled.has('whatsapp') ? 'good' : undefined} />
        <Stat label="رسالة نصية · SMS" value={enabled.has('sms') ? 'مفعّل' : 'يدوي'} tone={enabled.has('sms') ? 'good' : undefined} />
      </div>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'compose', label: 'رسالة جديدة · Compose' }, { id: 'outbox', label: 'سجل الإرسال · Outbox', badge: outbox.data.filter((row) => row.status === 'queued').length }]} />
      {tab === 'compose' && <section className="panel">
        <div className="form-grid">
          <label className="field settings-wide"><span><Bi ar={"النموذج"} en={"Template"} /></span><select value={templateId} onChange={(event) => { setTemplateId(event.target.value); setResult(null); }}>{templates.data.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          {template?.fields.map((field) => <label key={field} className={`field ${field === 'details' ? 'settings-wide' : ''}`}><span><BiText text={FIELD_LABEL[field] ?? field} /></span>
            {field === 'details' ? <textarea rows={4} value={values[field] ?? ''} onChange={(event) => setValues({ ...values, [field]: event.target.value })} />
              : <input value={values[field] ?? ''} type={field === 'date' ? 'date' : field === 'time' ? 'time' : 'text'} dir={field === 'link' ? 'ltr' : undefined} onChange={(event) => setValues({ ...values, [field]: event.target.value })} />}
          </label>)}
          <div className="settings-wide">
            <EmployeePicker label="المستلمون · Recipients" value={picker} onChange={(employee) => { if (employee && !people.some((person) => person.id === employee.id)) setPeople([...people, employee]); setPicker(null); }} />
            <div className="chip-list">{people.map((person) => <span key={person.id} className="chip">{person.fullName}<button type="button" aria-label="إزالة" onClick={() => setPeople(people.filter((item) => item.id !== person.id))}><X size={12} /></button></span>)}</div>
          </div>
          <div className="settings-wide channel-picks">{[['email', 'بريد · E-mail', Mail], ['whatsapp', 'واتساب · WhatsApp', MessageCircle], ['sms', 'رسالة نصية · SMS', Smartphone]].map(([id, label, Icon]) => {
            const IconComponent = Icon as typeof Mail;
            return <label key={id as string} className="settings-check"><input type="checkbox" checked={use.has(id as string)} onChange={() => setUse((current) => { const next = new Set(current); if (next.has(id as string)) next.delete(id as string); else next.add(id as string); return next; })} /><IconComponent size={15} />{label as string}{!enabled.has(id as string) && <small className="muted"> (يدوي)</small>}</label>;
          })}</div>
        </div>
        {template && <details className="message-preview"><summary><Bi ar={"معاينة النص"} en={"Preview"} /></summary><pre>{template.body}</pre></details>}
        <div className="dialog-actions"><button className="button button-primary" disabled={!people.length} onClick={() => void send()}><Send size={15} />تجهيز وإرسال · Prepare & send</button></div>
        {result && <div className="prepared-list">
          {result.disabledChannels.length > 0 && <p className="muted">القنوات غير المفعّلة ({result.disabledChannels.join('، ')}) تُرسل يدوياً من الأزرار. يفعّلها مالك النظام من «لوحة المالك ← القنوات».</p>}
          {result.prepared.map((item) => <div key={item.employeeId} className="prepared-row">
            <strong>{item.name}</strong><small dir="ltr">{item.email ?? '—'} · {item.phone ?? '—'}</small>
            <div className="prepared-actions">
              {item.links.email && <a className="button button-quiet button-small" href={item.links.email}><Mail size={14} />بريد</a>}
              {item.links.whatsapp && <a className="button button-quiet button-small" href={item.links.whatsapp} target="_blank" rel="noreferrer"><MessageCircle size={14} />واتساب</a>}
              {item.links.sms && <a className="button button-quiet button-small" href={item.links.sms}><Smartphone size={14} />SMS</a>}
              <button className="button button-quiet button-small" onClick={() => { void navigator.clipboard.writeText(item.body); session.notify('نُسخ النص.'); }}><Copy size={14} />نسخ</button>
            </div>
          </div>)}
        </div>}
      </section>}
      {tab === 'outbox' && <section className="panel">{!outbox.data.length ? <Empty icon={<Inbox size={22} />} title="لا توجد رسائل" text="تظهر هنا الرسائل المرسلة عبر القنوات المفعّلة." />
        : <div className="table-scroll"><table className="dense"><thead><tr><th>المستلم</th><th>القناة</th><th>الموضوع</th><th>الحالة</th><th>الوقت</th></tr></thead>
          <tbody>{outbox.data.map((row) => <tr key={row.id}><td>{row.employeeName}<small className="table-sub" dir="ltr">{row.recipient}</small></td><td>{row.channel}</td><td>{row.subject}</td>
            <td><Tone tone={row.status === 'sent' ? 'good' : row.status === 'failed' ? 'bad' : 'warn'}>{row.status}</Tone>{row.error && <small className="table-sub">{row.error}</small>}</td>
            <td>{formatDateTime(row.sentAt ?? row.createdAt)}</td></tr>)}</tbody></table></div>}
      </section>}
      <p className="muted"><CalendarDays size={13} /> لإضافة موعد للاجتماع في التقويم استخدم تطبيق «التقويم».</p>
    </section>
  );
}
