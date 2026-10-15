import { DragEvent, FormEvent, useState } from 'react';
import { Car, Laptop, MessageSquare, Plus, Send, Truck, Wrench } from 'lucide-react';
import { Bi } from '../components/Brand';
import { Dialog, Empty, Loading, Stat, StatusTag, Tabs, Tone } from '../components/ui';
import { ViewSwitch, useViewMode } from '../components/ViewSwitch';
import { formatDateTime, formatNumber } from '../lib/format';
import { useLoad, useSession } from '../lib/session';

interface Ticket {
  id: string; refNo: string; category: Category; subtype: string | null; title: string; description: string; priority: string; status: string;
  requesterUserId: string; requesterName: string; requesterEmployeeNo: string | null; branchName: string | null; location: string | null;
  assigneeUserId: string | null; assigneeName: string | null; neededFrom: string | null; neededTo: string | null; destination: string | null;
  passengers: number | null; vehiclePlate: string | null; resolution: string | null; createdAt: string; updatedAt: string;
}
type Category = 'it' | 'maintenance' | 'vehicle' | 'transport';

export const CATEGORIES: Record<Category, { ar: string; en: string; icon: JSX.Element; subtypes: string[] }> = {
  it: { ar: 'تقنية المعلومات', en: 'IT', icon: <Laptop size={18} />, subtypes: ['حاسبة / لابتوب', 'طابعة', 'شبكة وإنترنت', 'بريد إلكتروني', 'حساب ونظام', 'كاميرات', 'جهاز بصمة', 'أخرى'] },
  maintenance: { ar: 'الصيانة', en: 'Maintenance', icon: <Wrench size={18} />, subtypes: ['كهرباء', 'تبريد وتكييف', 'سباكة', 'نجارة وأثاث', 'مولد', 'تنظيف', 'أخرى'] },
  vehicle: { ar: 'طلب سيارة', en: 'Vehicle request', icon: <Car size={18} />, subtypes: ['مهمة عمل', 'زيارة فرع', 'نقل وثائق', 'استقبال ضيوف', 'أخرى'] },
  transport: { ar: 'النقل', en: 'Transport', icon: <Truck size={18} />, subtypes: ['نقل موظفين', 'نقل بضاعة / قطع', 'نقل سيارة', 'أخرى'] },
};
const STATUS: Record<string, { label: string; tone: string }> = {
  new: { label: 'جديدة', tone: 'info' }, assigned: { label: 'مُسندة', tone: 'info' }, in_progress: { label: 'قيد التنفيذ', tone: 'warn' },
  waiting: { label: 'بانتظار', tone: 'muted' }, resolved: { label: 'محلولة', tone: 'good' }, closed: { label: 'مغلقة', tone: 'muted' },
  cancelled: { label: 'ملغاة', tone: 'muted' },
};
const PRIORITY: Record<string, { label: string; tone: string }> = {
  low: { label: 'منخفضة', tone: 'muted' }, normal: { label: 'عادية', tone: 'info' }, high: { label: 'عالية', tone: 'warn' }, urgent: { label: 'عاجلة', tone: 'bad' },
};
const COLUMNS = ['new', 'assigned', 'in_progress', 'waiting', 'resolved'];

/** Helpdesk for IT, maintenance, vehicles and transport. The desk sees all; everyone else sees their own. */
export function TicketsPage({ mine = false }: { mine?: boolean }) {
  const session = useSession();
  const desk = session.can('tickets.manage') && !mine;
  const [category, setCategory] = useState<'all' | Category>('all');
  const tickets = useLoad<Ticket[]>(`/tickets?${mine ? 'mine=1&' : ''}${category === 'all' ? '' : `category=${category}`}`, []);
  const agents = useLoad<Array<{ id: string; name: string }>>(desk ? '/tickets/agents' : null, []);
  const [view, setView] = useViewMode(mine ? 'my-tickets' : 'tickets', desk ? 'kanban' : 'list');
  const [creating, setCreating] = useState<Category | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const live = tickets.data.filter((row) => !['closed', 'cancelled'].includes(row.status));

  async function move(id: string, status: string) {
    try {
      await session.call(`/tickets/${id}`, { method: 'PATCH', body: { status } });
      tickets.reload();
    } catch (error) {
      session.fail(error, 'تعذر نقل التذكرة.');
    }
  }
  const onDrop = (event: DragEvent, status: string) => {
    event.preventDefault();
    setDropOn(null);
    const id = event.dataTransfer.getData('text/plain');
    const ticket = tickets.data.find((row) => row.id === id);
    if (ticket && ticket.status !== status) void move(id, status);
  };

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar={mine ? 'تذاكري' : 'التذاكر'} en={mine ? 'My Tickets' : 'Helpdesk'} /></h2><p>تقنية المعلومات، الصيانة، طلب السيارات، والنقل. لكل طلب رقم متابعة وسجل كامل.</p></div></div>
      <div className="portal-actions">
        {(Object.keys(CATEGORIES) as Category[]).map((key) => <button key={key} onClick={() => setCreating(key)}>{CATEGORIES[key].icon}<Bi ar={CATEGORIES[key].ar} en={CATEGORIES[key].en} block /></button>)}
      </div>
      {desk && <div className="stat-row">
        <Stat label="مفتوحة" value={formatNumber(live.length)} />
        <Stat label="عاجلة" value={formatNumber(live.filter((row) => row.priority === 'urgent').length)} tone={live.some((row) => row.priority === 'urgent') ? 'bad' : undefined} />
        <Stat label="غير مُسندة" value={formatNumber(live.filter((row) => !row.assigneeUserId).length)} tone="warn" />
        <Stat label="طلبات سيارات ونقل" value={formatNumber(live.filter((row) => row.category === 'vehicle' || row.category === 'transport').length)} />
      </div>}
      <section className="panel">
        <div className="filter-bar">
          <Tabs<'all' | Category> value={category} onChange={setCategory} items={[{ id: 'all', label: 'الكل' }, ...(Object.keys(CATEGORIES) as Category[]).map((key) => ({ id: key, label: CATEGORIES[key].ar }))]} />
          <ViewSwitch value={view} onChange={setView} modes={['kanban', 'list']} />
        </div>
        {tickets.loading ? <Loading /> : !tickets.data.length ? <Empty icon={<MessageSquare size={22} />} title="لا توجد تذاكر" text="افتح طلباً من الأزرار أعلاه." />
          : view === 'kanban' ? <div className="kanban-board">{COLUMNS.map((status) => {
            const items = tickets.data.filter((row) => row.status === status);
            return <div key={status} className={`kanban-column ${dropOn === status ? 'is-drop' : ''}`}
              onDragOver={(event) => { if (desk) { event.preventDefault(); setDropOn(status); } }} onDragLeave={() => setDropOn(null)} onDrop={(event) => onDrop(event, status)}>
              <div className="kanban-column-head">{STATUS[status].label}<span>{items.length}</span></div>
              {items.map((row) => <button key={row.id} draggable={desk} className={`kanban-card priority-${row.priority} ${dragging === row.id ? 'is-dragging' : ''}`}
                onDragStart={(event) => { event.dataTransfer.setData('text/plain', row.id); setDragging(row.id); }} onDragEnd={() => setDragging(null)} onClick={() => setOpen(row.id)}>
                <small dir="ltr" className="ticket-ref">{row.refNo}</small>
                <strong>{row.title}</strong>
                <small>{CATEGORIES[row.category].ar}{row.subtype ? ` · ${row.subtype}` : ''}</small>
                <small>{row.requesterName}{row.branchName ? ` · ${row.branchName}` : ''}</small>
                <span className="ticket-meta"><Tone tone={PRIORITY[row.priority].tone}>{PRIORITY[row.priority].label}</Tone>{row.assigneeName && <small>← {row.assigneeName}</small>}</span>
              </button>)}
            </div>;
          })}</div>
          : <div className="table-scroll"><table className="dense">
            <thead><tr><th>الرقم</th><th>الطلب</th><th>النوع</th><th>الطالب</th><th>الأولوية</th><th>المكلّف</th><th>الحالة</th></tr></thead>
            <tbody>{tickets.data.map((row) => <tr key={row.id} className="row-link" onClick={() => setOpen(row.id)}>
              <td dir="ltr"><strong>{row.refNo}</strong></td><td>{row.title}<small className="table-sub">{formatDateTime(row.createdAt)}</small></td>
              <td>{CATEGORIES[row.category].ar}</td><td>{row.requesterName}</td>
              <td><Tone tone={PRIORITY[row.priority].tone}>{PRIORITY[row.priority].label}</Tone></td>
              <td>{row.assigneeName ?? '—'}</td><td><StatusTag map={STATUS} value={row.status} /></td>
            </tr>)}</tbody>
          </table></div>}
      </section>
      <NewTicket category={creating} onClose={() => setCreating(null)} onDone={() => { setCreating(null); tickets.reload(); }} />
      <Dialog open={Boolean(open)} title="تفاصيل التذكرة · Ticket" onClose={() => setOpen(null)} wide>
        {open && <TicketView id={open} agents={agents.data} desk={desk} onChanged={tickets.reload} />}
      </Dialog>
    </section>
  );
}

function NewTicket({ category, onClose, onDone }: { category: Category | null; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) || '') || undefined;
    setBusy(true);
    try {
      const result = await session.call<{ data: { refNo: string } }>('/tickets', {
        body: {
          category, subtype: value('subtype'), title: value('title'), description: value('description'), priority: value('priority'),
          location: value('location'), destination: value('destination'),
          neededFrom: value('neededFrom') ? new Date(String(form.get('neededFrom'))).toISOString() : undefined,
          neededTo: value('neededTo') ? new Date(String(form.get('neededTo'))).toISOString() : undefined,
          passengers: form.get('passengers') ? Number(form.get('passengers')) : undefined,
        },
      });
      session.notify(`فُتحت التذكرة ${result.data.refNo}.`);
      onDone();
    } catch (error) {
      session.fail(error, 'تعذر فتح التذكرة.');
    } finally {
      setBusy(false);
    }
  }
  const trip = category === 'vehicle' || category === 'transport';
  return (
    <Dialog open={category !== null} title={category ? `${CATEGORIES[category].ar} · ${CATEGORIES[category].en}` : ''} onClose={onClose} wide>
      {category && <form onSubmit={(event) => void submit(event)} key={category}>
        <div className="form-grid">
          <label className="field"><span>النوع</span><select name="subtype">{CATEGORIES[category].subtypes.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label className="field"><span>الأولوية</span><select name="priority" defaultValue="normal">{Object.entries(PRIORITY).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
          <label className="field"><span>{trip ? 'نقطة الانطلاق' : 'الموقع (قسم / غرفة)'}</span><input name="location" maxLength={200} /></label>
          {trip && <>
            <label className="field"><span>الوجهة *</span><input name="destination" required maxLength={200} /></label>
            <label className="field"><span>من *</span><input name="neededFrom" type="datetime-local" required /></label>
            <label className="field"><span>إلى</span><input name="neededTo" type="datetime-local" /></label>
            <label className="field"><span>عدد الركاب</span><input name="passengers" type="number" min={1} max={100} /></label>
          </>}
          <label className="field field-wide"><span>العنوان *</span><input name="title" required maxLength={200} /></label>
          <label className="field field-wide"><span>التفاصيل *</span><textarea name="description" required rows={4} maxLength={5000} /></label>
        </div>
        <div className="dialog-actions"><button className="button button-primary" disabled={busy}><Plus size={15} />فتح التذكرة</button><button type="button" className="button button-quiet" onClick={onClose}>إلغاء</button></div>
      </form>}
    </Dialog>
  );
}

function TicketView({ id, desk, agents, onChanged }: { id: string; desk: boolean; agents: Array<{ id: string; name: string }>; onChanged: () => void }) {
  const session = useSession();
  const ticket = useLoad<(Ticket & { comments: Array<{ id: string; body: string; kind: string; createdAt: string; userName: string }> }) | null>(`/tickets/${id}`, null);
  const [comment, setComment] = useState('');
  const data = ticket.data;
  async function patch(change: Record<string, unknown>) {
    try {
      await session.call(`/tickets/${id}`, { method: 'PATCH', body: change });
      ticket.reload();
      onChanged();
    } catch (error) {
      session.fail(error, 'تعذر التحديث.');
    }
  }
  async function send() {
    if (!comment.trim()) return;
    try {
      await session.call(`/tickets/${id}/comments`, { body: { body: comment.trim() } });
      setComment('');
      ticket.reload();
    } catch (error) {
      session.fail(error, 'تعذر الإرسال.');
    }
  }
  if (!data) return <Loading />;
  const own = data.requesterUserId === session.user.id;
  return <div className="ticket-view">
    <div className="ticket-head"><span dir="ltr" className="ticket-ref">{data.refNo}</span><h3>{data.title}</h3><StatusTag map={STATUS} value={data.status} /><Tone tone={PRIORITY[data.priority].tone}>{PRIORITY[data.priority].label}</Tone></div>
    <dl className="facts">
      <div><dt>النوع</dt><dd>{CATEGORIES[data.category].ar}{data.subtype ? ` · ${data.subtype}` : ''}</dd></div>
      <div><dt>الطالب</dt><dd>{data.requesterName}{data.requesterEmployeeNo ? ` (${data.requesterEmployeeNo})` : ''}</dd></div>
      <div><dt>الفرع</dt><dd>{data.branchName ?? '—'}</dd></div>
      {data.location && <div><dt>{data.category === 'vehicle' || data.category === 'transport' ? 'الانطلاق' : 'الموقع'}</dt><dd>{data.location}</dd></div>}
      {data.destination && <div><dt>الوجهة</dt><dd>{data.destination}</dd></div>}
      {data.neededFrom && <div><dt>الوقت</dt><dd>{formatDateTime(data.neededFrom)}{data.neededTo ? ` ← ${formatDateTime(data.neededTo)}` : ''}</dd></div>}
      {data.passengers && <div><dt>الركاب</dt><dd>{data.passengers}</dd></div>}
      {data.vehiclePlate && <div><dt>السيارة</dt><dd>{data.vehiclePlate}</dd></div>}
      <div className="facts-wide"><dt>التفاصيل</dt><dd className="pre">{data.description}</dd></div>
      {data.resolution && <div className="facts-wide"><dt>الحل</dt><dd className="pre">{data.resolution}</dd></div>}
    </dl>
    {desk && !['closed', 'cancelled'].includes(data.status) && <div className="form-grid">
      <label className="field"><span>الحالة</span><select value={data.status} onChange={(event) => void patch({ status: event.target.value })}>{Object.entries(STATUS).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
      <label className="field"><span>المكلّف</span><select value={data.assigneeUserId ?? ''} onChange={(event) => void patch({ assigneeUserId: event.target.value || null })}><option value="">—</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
      <label className="field"><span>الأولوية</span><select value={data.priority} onChange={(event) => void patch({ priority: event.target.value })}>{Object.entries(PRIORITY).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
      {(data.category === 'vehicle' || data.category === 'transport') && <label className="field"><span>رقم السيارة</span><input defaultValue={data.vehiclePlate ?? ''} onBlur={(event) => { if (event.target.value !== (data.vehiclePlate ?? '')) void patch({ vehiclePlate: event.target.value }); }} /></label>}
      <label className="field field-wide"><span>الحل</span><textarea rows={2} defaultValue={data.resolution ?? ''} onBlur={(event) => { if (event.target.value !== (data.resolution ?? '')) void patch({ resolution: event.target.value }); }} /></label>
    </div>}
    {own && !desk && !['resolved', 'closed', 'cancelled'].includes(data.status) && <button className="button button-quiet danger" onClick={() => void patch({ status: 'cancelled' })}>إلغاء الطلب</button>}
    {own && data.status === 'resolved' && <button className="button button-primary" onClick={() => void patch({ status: 'closed' })}>تأكيد الحل وإغلاق التذكرة</button>}
    <div className="ticket-log">
      {data.comments.map((item) => <div key={item.id} className={`ticket-log-item kind-${item.kind}`}><strong>{item.userName}</strong><small>{formatDateTime(item.createdAt)}</small><p>{item.body}</p></div>)}
      {!['closed', 'cancelled'].includes(data.status) && <div className="ticket-reply"><input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="اكتب تعليقاً…" maxLength={2000} onKeyDown={(event) => { if (event.key === 'Enter') void send(); }} /><button className="button button-primary" onClick={() => void send()}><Send size={14} /></button></div>}
    </div>
  </div>;
}
