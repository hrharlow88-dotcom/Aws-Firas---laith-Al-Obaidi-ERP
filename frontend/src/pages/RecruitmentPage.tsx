import { DragEvent, FormEvent, useState } from 'react';
import { Briefcase, CalendarClock, FileUp, Mail, Paperclip, Phone, Plus, Star, UserCheck, Users } from 'lucide-react';
import { Bi } from '../components/Brand';
import { Dialog, Empty, Loading, Stat, Tone } from '../components/ui';
import { ViewSwitch, useViewMode } from '../components/ViewSwitch';
import { openFile } from '../lib/api';
import { formatDateTime, formatMoney, formatNumber, today } from '../lib/format';
import { navigate } from '../lib/router';
import { useCrumb } from '../lib/breadcrumbs';
import { useLoad, useSession } from '../lib/session';

interface Position {
  id: string; title: string; titleEn: string | null; departmentId: string | null; departmentName: string | null; branchId: string | null;
  branchName: string | null; description: string | null; requirements: string | null; vacancies: number; status: 'open' | 'paused' | 'closed';
  inProgress: number; newCount: number; hiredCount: number;
}
interface Applicant {
  id: string; positionId: string; positionTitle: string; fullName: string; email: string | null; phone: string | null; source: string | null;
  expectedSalary: number | null; currency: string | null; stage: Stage; priority: number; notes: string | null; cvName: string | null; hasCv: boolean;
  interviewAt: string | null; refuseReason: string | null; hiredEmployeeId: string | null; stageChangedAt: string; createdAt: string;
}
type Stage = 'new' | 'screening' | 'interview1' | 'interview2' | 'offer' | 'hired' | 'refused';

const STAGES: Array<{ id: Stage; ar: string; en: string }> = [
  { id: 'new', ar: 'جديد', en: 'New' }, { id: 'screening', ar: 'فرز أولي', en: 'Screening' },
  { id: 'interview1', ar: 'مقابلة أولى', en: 'First interview' }, { id: 'interview2', ar: 'مقابلة ثانية', en: 'Second interview' },
  { id: 'offer', ar: 'عرض عمل', en: 'Offer' }, { id: 'hired', ar: 'تم التعيين', en: 'Hired' }, { id: 'refused', ar: 'مرفوض', en: 'Refused' },
];
const SOURCES: Record<string, string> = { website: 'الموقع', linkedin: 'LinkedIn', referral: 'ترشيح موظف', walk_in: 'حضور مباشر', facebook: 'فيسبوك', agency: 'مكتب توظيف', other: 'أخرى' };
const POSITION_STATUS: Record<string, { label: string; tone: string }> = { open: { label: 'مفتوحة', tone: 'good' }, paused: { label: 'متوقفة', tone: 'warn' }, closed: { label: 'مغلقة', tone: 'muted' } };

function Stars({ value, onChange }: { value: number; onChange?: (value: number) => void }) {
  return <span className="stars" onClick={(event) => event.stopPropagation()}>{[1, 2, 3].map((n) => <button key={n} type="button" disabled={!onChange} aria-label={`${n} نجوم`}
    className={n <= value ? 'is-on' : ''} onClick={() => onChange?.(value === n ? 0 : n)}><Star size={14} /></button>)}</span>;
}

/** Recruitment like Odoo: job positions as cards, then each position's applicants on a stage kanban. */
export function RecruitmentPage({ positionId }: { positionId?: string }) {
  if (positionId) return <Pipeline positionId={positionId} />;
  return <Positions />;
}

function Positions() {
  const session = useSession();
  const positions = useLoad<Position[]>('/recruitment/positions', []);
  const [editing, setEditing] = useState<Position | 'new' | null>(null);
  const [view, setView] = useViewMode('positions', 'grid');
  const open = positions.data.filter((row) => row.status === 'open');
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="الشواغر الوظيفية" en="Job Positions" /></h2><p>افتح الشاغر ثم أضف المتقدمين واسحبهم بين مراحل التوظيف حتى التعيين.</p></div>
        {session.can('recruitment.manage') && <button className="button button-primary" onClick={() => setEditing('new')}><Plus size={16} />شاغر جديد</button>}</div>
      <div className="stat-row">
        <Stat label="شواغر مفتوحة" value={formatNumber(open.length)} />
        <Stat label="مقاعد مطلوبة" value={formatNumber(open.reduce((sum, row) => sum + row.vacancies, 0))} />
        <Stat label="متقدمون قيد الإجراء" value={formatNumber(positions.data.reduce((sum, row) => sum + row.inProgress, 0))} />
        <Stat label="تم تعيينهم" value={formatNumber(positions.data.reduce((sum, row) => sum + row.hiredCount, 0))} tone="good" />
      </div>
      <section className="panel">
        <div className="filter-bar"><span className="result-count">{positions.data.length} شاغر</span><ViewSwitch value={view} onChange={setView} modes={['grid', 'list']} /></div>
        {positions.loading ? <Loading /> : !positions.data.length ? <Empty icon={<Briefcase size={22} />} title="لا توجد شواغر" text="افتح شاغراً وظيفياً لتبدأ استقبال المتقدمين." />
          : view === 'grid' ? <div className="card-grid job-grid">{positions.data.map((row) => <article key={row.id} className="job-card" onClick={() => navigate('recruitment', row.id)}>
            <div className="job-card-head"><strong>{row.title}</strong><Tone tone={POSITION_STATUS[row.status].tone}>{POSITION_STATUS[row.status].label}</Tone></div>
            {row.titleEn && <small dir="ltr">{row.titleEn}</small>}
            <small>{row.departmentName ?? '—'} · {row.branchName ?? 'كل الفروع'}</small>
            <div className="job-card-counts">
              <span><b>{row.newCount}</b>جديد</span><span><b>{row.inProgress}</b>قيد الإجراء</span><span><b>{row.hiredCount}/{row.vacancies}</b>مُعيّن</span>
            </div>
            {session.can('recruitment.manage') && <button className="text-button" onClick={(event) => { event.stopPropagation(); setEditing(row); }}>تعديل</button>}
          </article>)}</div>
          : <div className="table-scroll"><table className="dense"><thead><tr><th>الشاغر</th><th>القسم</th><th>الفرع</th><th>جديد</th><th>قيد الإجراء</th><th>معيّن</th><th>الحالة</th></tr></thead>
            <tbody>{positions.data.map((row) => <tr key={row.id} className="row-link" onClick={() => navigate('recruitment', row.id)}>
              <td><strong>{row.title}</strong></td><td>{row.departmentName ?? '—'}</td><td>{row.branchName ?? '—'}</td><td>{row.newCount}</td><td>{row.inProgress}</td><td>{row.hiredCount}/{row.vacancies}</td>
              <td><Tone tone={POSITION_STATUS[row.status].tone}>{POSITION_STATUS[row.status].label}</Tone></td></tr>)}</tbody></table></div>}
      </section>
      <PositionForm value={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); positions.reload(); }} />
    </section>
  );
}

function PositionForm({ value, onClose, onDone }: { value: Position | 'new' | null; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const departments = useLoad<Array<{ id: string; name: string; isActive: boolean }>>(value ? '/org/departments' : null, []);
  const branches = useLoad<Array<{ id: string; name: string; isActive: boolean }>>(value ? '/branches' : null, []);
  const editing = value && value !== 'new' ? value : null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) || '') || undefined;
    try {
      await session.call(editing ? `/recruitment/positions/${editing.id}` : '/recruitment/positions', {
        method: editing ? 'PUT' : 'POST',
        body: { title: text('title'), titleEn: text('titleEn'), departmentId: text('departmentId'), branchId: text('branchId'), vacancies: Number(form.get('vacancies') || 1), status: text('status'), description: text('description'), requirements: text('requirements') },
      });
      session.notify('حُفظ الشاغر.');
      onDone();
    } catch (error) {
      session.fail(error, 'تعذر الحفظ.');
    }
  }
  return <Dialog open={Boolean(value)} title={editing ? 'تعديل الشاغر' : 'شاغر جديد · New position'} onClose={onClose} wide>
    {value && <form onSubmit={(event) => void submit(event)} key={editing?.id ?? 'new'}>
      <div className="form-grid">
        <label className="field"><span>المسمى *</span><input name="title" required maxLength={150} defaultValue={editing?.title} /></label>
        <label className="field"><span>Title (EN)</span><input name="titleEn" maxLength={150} dir="ltr" defaultValue={editing?.titleEn ?? ''} /></label>
        <label className="field"><span>القسم</span><select name="departmentId" defaultValue={editing?.departmentId ?? ''}><option value="">—</option>{departments.data.filter((row) => row.isActive).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        <label className="field"><span>الفرع</span><select name="branchId" defaultValue={editing?.branchId ?? ''}><option value="">كل الفروع</option>{branches.data.filter((row) => row.isActive).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        <label className="field"><span>العدد المطلوب</span><input name="vacancies" type="number" min={1} max={500} defaultValue={editing?.vacancies ?? 1} /></label>
        <label className="field"><span>الحالة</span><select name="status" defaultValue={editing?.status ?? 'open'}><option value="open">مفتوحة</option><option value="paused">متوقفة</option><option value="closed">مغلقة</option></select></label>
        <label className="field field-wide"><span>الوصف</span><textarea name="description" rows={3} defaultValue={editing?.description ?? ''} /></label>
        <label className="field field-wide"><span>المتطلبات</span><textarea name="requirements" rows={3} defaultValue={editing?.requirements ?? ''} /></label>
      </div>
      <div className="dialog-actions"><button className="button button-primary">حفظ</button><button type="button" className="button button-quiet" onClick={onClose}>إلغاء</button></div>
    </form>}
  </Dialog>;
}

function Pipeline({ positionId }: { positionId: string }) {
  const session = useSession();
  const positions = useLoad<Position[]>('/recruitment/positions', []);
  const applicants = useLoad<Applicant[]>(`/recruitment/applicants?positionId=${positionId}`, []);
  const position = positions.data.find((row) => row.id === positionId);
  useCrumb(position?.title);
  const [view, setView] = useViewMode('applicants', 'kanban');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<Stage | null>(null);
  const manage = session.can('recruitment.manage');

  async function patch(id: string, change: Record<string, unknown>) {
    try {
      await session.call(`/recruitment/applicants/${id}`, { method: 'PATCH', body: change });
      applicants.reload();
    } catch (error) {
      session.fail(error, 'تعذر التحديث.');
    }
  }
  function drop(event: DragEvent, stage: Stage) {
    event.preventDefault();
    setDropOn(null);
    const id = event.dataTransfer.getData('text/plain');
    const applicant = applicants.data.find((row) => row.id === id);
    if (!applicant || applicant.stage === stage || applicant.stage === 'hired') return;
    if (stage === 'hired') { setOpen(id); session.notify('للتعيين افتح بطاقة المتقدم واضغط «تعيين».', true); return; }
    if (stage === 'refused') {
      const reason = window.prompt('سبب الرفض');
      if (!reason?.trim()) return;
      void patch(id, { stage, refuseReason: reason.trim() });
      return;
    }
    void patch(id, { stage });
  }

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2>{position?.title ?? '…'} {position?.titleEn && <span className="o-home-en" dir="ltr">{position.titleEn}</span>}</h2><p>{position?.departmentName ?? ''} {position?.branchName ? `· ${position.branchName}` : ''} · اسحب البطاقة بين الأعمدة لتغيير المرحلة.</p></div>
        {manage && <button className="button button-primary" onClick={() => setAdding(true)}><Plus size={16} />متقدم جديد</button>}</div>
      <section className="panel">
        <div className="filter-bar"><span className="result-count">{applicants.data.length} متقدم</span><ViewSwitch value={view} onChange={setView} modes={['kanban', 'list']} /></div>
        {applicants.loading ? <Loading /> : view === 'kanban' ? <div className="kanban-board">{STAGES.map((stage) => {
          const items = applicants.data.filter((row) => row.stage === stage.id);
          return <div key={stage.id} className={`kanban-column stage-${stage.id} ${dropOn === stage.id ? 'is-drop' : ''}`}
            onDragOver={(event) => { if (manage) { event.preventDefault(); setDropOn(stage.id); } }} onDragLeave={() => setDropOn(null)} onDrop={(event) => drop(event, stage.id)}>
            <div className="kanban-column-head"><Bi ar={stage.ar} en={stage.en} /><span>{items.length}</span></div>
            {items.map((row) => <div key={row.id} role="button" tabIndex={0} draggable={manage && row.stage !== 'hired'} className="kanban-card"
              onDragStart={(event) => event.dataTransfer.setData('text/plain', row.id)} onClick={() => setOpen(row.id)} onKeyDown={(event) => { if (event.key === 'Enter') setOpen(row.id); }}>
              <strong>{row.fullName}</strong>
              {row.phone && <small dir="ltr">{row.phone}</small>}
              {row.interviewAt && <small><CalendarClock size={11} /> {formatDateTime(row.interviewAt)}</small>}
              <span className="ticket-meta"><Stars value={row.priority} onChange={manage ? (value) => void patch(row.id, { priority: value }) : undefined} />{row.hasCv && <Paperclip size={12} />}</span>
            </div>)}
          </div>;
        })}</div> : <div className="table-scroll"><table className="dense"><thead><tr><th>المتقدم</th><th>الهاتف</th><th>المصدر</th><th>المرحلة</th><th>التقييم</th></tr></thead>
          <tbody>{applicants.data.map((row) => <tr key={row.id} className="row-link" onClick={() => setOpen(row.id)}>
            <td><strong>{row.fullName}</strong></td><td dir="ltr">{row.phone ?? '—'}</td><td>{row.source ? SOURCES[row.source] : '—'}</td>
            <td>{STAGES.find((stage) => stage.id === row.stage)?.ar}</td><td><Stars value={row.priority} /></td></tr>)}</tbody></table></div>}
      </section>
      <NewApplicant open={adding} positionId={positionId} onClose={() => setAdding(false)} onDone={() => { setAdding(false); applicants.reload(); }} />
      <Dialog open={Boolean(open)} title="المتقدم · Applicant" onClose={() => setOpen(null)} wide>
        {open && <ApplicantView id={open} branchId={position?.branchId ?? null} onChanged={applicants.reload} />}
      </Dialog>
    </section>
  );
}

function NewApplicant({ open, positionId, onClose, onDone }: { open: boolean; positionId: string; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) || '') || undefined;
    try {
      const created = await session.call<{ data: { id: string } }>('/recruitment/applicants', {
        body: { positionId, fullName: text('fullName'), email: text('email'), phone: text('phone'), source: text('source'), expectedSalary: form.get('expectedSalary') ? Number(form.get('expectedSalary')) : undefined, currency: text('currency'), notes: text('notes') },
      });
      const cv = form.get('cv');
      if (cv instanceof File && cv.size) {
        const upload = new FormData();
        upload.append('file', cv);
        await session.call(`/recruitment/applicants/${created.data.id}/cv`, { method: 'POST', form: upload });
      }
      session.notify('أُضيف المتقدم إلى عمود «جديد».');
      onDone();
    } catch (error) {
      session.fail(error, 'تعذر الإضافة.');
    }
  }
  return <Dialog open={open} title="متقدم جديد · New applicant" onClose={onClose} wide>
    <form onSubmit={(event) => void submit(event)}>
      <div className="form-grid">
        <label className="field"><span>الاسم الكامل *</span><input name="fullName" required maxLength={180} /></label>
        <label className="field"><span>الهاتف</span><input name="phone" maxLength={40} dir="ltr" /></label>
        <label className="field"><span>البريد</span><input name="email" type="email" maxLength={254} dir="ltr" /></label>
        <label className="field"><span>المصدر</span><select name="source" defaultValue="">{[['', '—'], ...Object.entries(SOURCES)].map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="field"><span>الراتب المتوقع</span><input name="expectedSalary" type="number" min={0} /></label>
        <label className="field"><span>العملة</span><select name="currency" defaultValue="IQD"><option value="IQD">دينار</option><option value="USD">دولار</option></select></label>
        <label className="field"><span>السيرة الذاتية (PDF أو صورة)</span><input name="cv" type="file" accept=".pdf,image/*" /></label>
        <label className="field field-wide"><span>ملاحظات</span><textarea name="notes" rows={3} /></label>
      </div>
      <div className="dialog-actions"><button className="button button-primary"><Plus size={15} />إضافة</button><button type="button" className="button button-quiet" onClick={onClose}>إلغاء</button></div>
    </form>
  </Dialog>;
}

function ApplicantView({ id, branchId, onChanged }: { id: string; branchId: string | null; onChanged: () => void }) {
  const session = useSession();
  const applicant = useLoad<(Applicant & { activity: Array<{ id: string; kind: string; body: string; createdAt: string; userName: string }> }) | null>(`/recruitment/applicants/${id}`, null);
  const branches = useLoad<Array<{ id: string; name: string; isActive: boolean }>>('/branches', []);
  const [note, setNote] = useState('');
  const [hiring, setHiring] = useState(false);
  const data = applicant.data;
  const manage = session.can('recruitment.manage');
  async function patch(change: Record<string, unknown>) {
    try {
      await session.call(`/recruitment/applicants/${id}`, { method: 'PATCH', body: change });
      applicant.reload();
      onChanged();
    } catch (error) {
      session.fail(error, 'تعذر التحديث.');
    }
  }
  async function uploadCv(file: File) {
    const form = new FormData();
    form.append('file', file);
    try {
      await session.call(`/recruitment/applicants/${id}/cv`, { method: 'POST', form });
      applicant.reload();
    } catch (error) {
      session.fail(error, 'تعذر رفع الملف.');
    }
  }
  async function hire(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await session.call<{ data: { employeeId: string } }>(`/recruitment/applicants/${id}/hire`, {
        body: { employeeNo: form.get('employeeNo'), hireDate: form.get('hireDate'), branchId: form.get('branchId') || undefined },
      });
      session.notify('تم التعيين وأُنشئ ملف الموظف (تحت التجربة).');
      onChanged();
      navigate('employees', result.data.employeeId);
    } catch (error) {
      session.fail(error, 'تعذر التعيين.');
    }
  }
  if (!data) return <Loading />;
  return <div className="applicant-view">
    <div className="ticket-head"><h3>{data.fullName}</h3><Stars value={data.priority} onChange={manage && data.stage !== 'hired' ? (value) => void patch({ priority: value }) : undefined} /></div>
    <ol className="stage-bar">{STAGES.filter((stage) => stage.id !== 'refused').map((stage) => <li key={stage.id} className={stage.id === data.stage ? 'is-current' : ''}>
      <button type="button" disabled={!manage || data.stage === 'hired' || stage.id === 'hired'} onClick={() => void patch({ stage: stage.id })}>{stage.ar}</button>
    </li>)}{data.stage === 'refused' && <li className="is-current is-refused"><button type="button" disabled>مرفوض</button></li>}</ol>
    <dl className="facts">
      <div><dt><Phone size={12} /> الهاتف</dt><dd dir="ltr">{data.phone ?? '—'}</dd></div>
      <div><dt><Mail size={12} /> البريد</dt><dd dir="ltr">{data.email ?? '—'}</dd></div>
      <div><dt>المصدر</dt><dd>{data.source ? SOURCES[data.source] : '—'}</dd></div>
      <div><dt>الراتب المتوقع</dt><dd>{data.expectedSalary ? formatMoney(data.expectedSalary, data.currency ?? 'IQD') : '—'}</dd></div>
      <div><dt>المقابلة</dt><dd>{manage && data.stage !== 'hired' ? <input type="datetime-local" defaultValue={data.interviewAt ? data.interviewAt.slice(0, 16) : ''} onBlur={(event) => { if (event.target.value) void patch({ interviewAt: event.target.value }); }} /> : data.interviewAt ? formatDateTime(data.interviewAt) : '—'}</dd></div>
      <div><dt>السيرة الذاتية</dt><dd>{data.hasCv ? <button className="text-button" onClick={() => void openFile(`/recruitment/applicants/${id}/cv?inline=1`, session.token).catch((error) => session.fail(error, 'تعذر الفتح.'))}><Paperclip size={13} />{data.cvName}</button> : manage ? <label className="text-button"><FileUp size={13} />رفع<input type="file" accept=".pdf,image/*" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadCv(file); }} /></label> : '—'}</dd></div>
      {data.notes && <div className="facts-wide"><dt>ملاحظات</dt><dd className="pre">{data.notes}</dd></div>}
      {data.refuseReason && <div className="facts-wide"><dt>سبب الرفض</dt><dd>{data.refuseReason}</dd></div>}
    </dl>
    {manage && data.stage !== 'hired' && <div className="dialog-actions">
      {data.stage !== 'refused' && <button className="button button-quiet danger" onClick={() => { const reason = window.prompt('سبب الرفض'); if (reason?.trim()) void patch({ stage: 'refused', refuseReason: reason.trim() }); }}>رفض</button>}
      {data.stage === 'refused' && <button className="button button-quiet" onClick={() => void patch({ stage: 'new' })}>إعادة إلى «جديد»</button>}
      <button className="button button-primary" onClick={() => setHiring(!hiring)}><UserCheck size={15} />تعيين</button>
    </div>}
    {data.hiredEmployeeId && <button className="button button-quiet" onClick={() => navigate('employees', data.hiredEmployeeId!)}><Users size={15} />ملف الموظف</button>}
    {hiring && <form className="hire-form" onSubmit={(event) => void hire(event)}>
      <div className="form-grid">
        <label className="field"><span>الرقم الوظيفي *</span><input name="employeeNo" required maxLength={40} dir="ltr" /></label>
        <label className="field"><span>تاريخ المباشرة *</span><input name="hireDate" type="date" required defaultValue={today()} /></label>
        <label className="field"><span>الفرع</span><select name="branchId" defaultValue={branchId ?? ''}><option value="">فرع الشاغر</option>{branches.data.filter((row) => row.isActive).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      </div>
      <div className="dialog-actions"><button className="button button-primary"><UserCheck size={15} />إنشاء ملف الموظف</button></div>
    </form>}
    <div className="ticket-log">
      {manage && <div className="ticket-reply"><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="أضف ملاحظة عن المقابلة أو التقييم…" maxLength={2000} /><button className="button button-primary" disabled={!note.trim()} onClick={() => void patch({ note }).then(() => setNote(''))}>حفظ</button></div>}
      {data.activity.map((item) => <div key={item.id} className={`ticket-log-item kind-${item.kind}`}><strong>{item.userName}</strong><small>{formatDateTime(item.createdAt)}</small><p>{item.body}</p></div>)}
    </div>
  </div>;
}
