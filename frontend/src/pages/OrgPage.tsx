import { Bi } from '../components/Brand';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Briefcase, ChevronDown, ChevronLeft, Network, Pencil, Plus, Users } from 'lucide-react';
import { Dialog, Empty, Loading, Tabs, Tone } from '../components/ui';
import { navigate } from '../lib/router';
import { useLoad, useSession } from '../lib/session';
import { OrgImport } from './OrgImport';
import { PersonMark } from '../components/EmployeePhoto';
import { useEmployeeThumbs } from '../lib/photos';

export interface Department {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  branchId: string | null;
  branchName?: string | null;
  managerEmployeeId: string | null;
  managerName?: string | null;
  costCenterCode: string | null;
  sortOrder: number;
  isActive: boolean;
  employeeCount?: number;
}

export interface JobTitle {
  id: string;
  code: string;
  name: string;
  departmentId: string | null;
  departmentName?: string | null;
  grade: string | null;
  description: string | null;
  isActive: boolean;
  employeeCount?: number;
}

interface ChartEmployee {
  id: string;
  employeeNo: string;
  fullName: string;
  departmentId: string | null;
  managerId: string | null;
  jobTitle: string;
  branchName: string;
  photoVersion?: string | null;
}

type Tab = 'departments' | 'titles' | 'chart' | 'import';

export function OrgPage({ branches }: { branches: Array<{ id: string; name: string }> }) {
  const session = useSession();
  const canManage = session.can('org.manage');
  const [tab, setTab] = useState<Tab>('departments');
  const departments = useLoad<Department[]>('/org/departments', []);
  const titles = useLoad<JobTitle[]>('/org/job-titles', []);
  const [editingDepartment, setEditingDepartment] = useState<Department | 'new' | null>(null);
  const [editingTitle, setEditingTitle] = useState<JobTitle | 'new' | null>(null);

  return (
    <section className="screen">
      <div className="screen-heading">
        <div><h2>الهيكل التنظيمي</h2><p>الأقسام ومراكز الكلفة والمسميات الوظيفية وخطوط الإدارة.</p></div>
        {canManage && <div className="heading-actions">
          <button className="button button-quiet" onClick={() => setEditingTitle('new')}><Briefcase size={16} />مسمى وظيفي</button>
          <button className="button button-primary" onClick={() => setEditingDepartment('new')}><Plus size={17} />قسم جديد</button>
        </div>}
      </div>
      <Tabs<Tab> value={tab} onChange={setTab} items={[
        { id: 'departments', label: 'الأقسام', badge: departments.data.length },
        { id: 'titles', label: 'المسميات الوظيفية', badge: titles.data.length },
        { id: 'chart', label: 'المخطط التنظيمي' },
        ...(canManage ? [{ id: 'import' as Tab, label: 'استيراد من Excel' }] : []),
      ]} />
      {tab === 'import' && canManage && <OrgImport onApplied={() => { departments.reload(); titles.reload(); }} />}

      {tab === 'departments' && <DepartmentTree items={departments.data} loading={departments.loading} canManage={canManage} onEdit={setEditingDepartment} />}
      {tab === 'titles' && <section className="panel">
        {titles.loading ? <Loading /> : titles.data.length ? <div className="table-scroll"><table>
          <thead><tr><th>المسمى</th><th>الرمز</th><th>القسم</th><th>الدرجة</th><th>الموظفون</th><th>الحالة</th>{canManage && <th />}</tr></thead>
          <tbody>{titles.data.map((title) => <tr key={title.id}>
            <td><strong>{title.name}</strong>{title.description && <small className="table-sub wrap">{title.description}</small>}</td>
            <td><span className="code-tag">{title.code}</span></td>
            <td>{title.departmentName || '—'}</td>
            <td>{title.grade || '—'}</td>
            <td>{title.employeeCount ?? 0}</td>
            <td><Tone tone={title.isActive ? 'good' : 'muted'}>{title.isActive ? 'نشط' : 'معطل'}</Tone></td>
            {canManage && <td><button className="icon-link" aria-label="تعديل" onClick={() => setEditingTitle(title)}><Pencil size={14} /></button></td>}
          </tr>)}</tbody>
        </table></div> : <Empty icon={<Briefcase size={22} />} title="لا توجد مسميات وظيفية" text="عرّف المسميات المعتمدة لربط الموظفين بها وبالأوصاف الوظيفية." action={canManage ? 'إضافة مسمى' : undefined} onAction={() => setEditingTitle('new')} />}
      </section>}
      {tab === 'chart' && <OrgChart departments={departments.data} />}

      <DepartmentDialog
        value={editingDepartment}
        departments={departments.data}
        branches={branches}
        onClose={() => setEditingDepartment(null)}
        onSaved={() => { setEditingDepartment(null); departments.reload(); }}
      />
      <TitleDialog
        value={editingTitle}
        departments={departments.data}
        onClose={() => setEditingTitle(null)}
        onSaved={() => { setEditingTitle(null); titles.reload(); }}
      />
    </section>
  );
}

function DepartmentTree({ items, loading, canManage, onEdit }: {
  items: Department[];
  loading: boolean;
  canManage: boolean;
  onEdit: (department: Department) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const children = useMemo(() => {
    const map = new Map<string | null, Department[]>();
    for (const item of items) {
      const key = item.parentId && items.some((other) => other.id === item.parentId) ? item.parentId : null;
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return map;
  }, [items]);
  if (loading) return <section className="panel"><Loading /></section>;
  if (!items.length) {
    return <section className="panel"><Empty icon={<Network size={22} />} title="لم يُبنَ الهيكل بعد" text="ابدأ بالأقسام الرئيسية (المبيعات، الصيانة، المالية…) ثم أضف الأقسام الفرعية." /></section>;
  }
  const render = (parent: string | null, depth: number): JSX.Element[] => (children.get(parent) ?? []).flatMap((department) => {
    const kids = children.get(department.id) ?? [];
    const open = !collapsed.has(department.id);
    return [
      <div className={`tree-row ${department.isActive ? '' : 'tree-row-inactive'}`} key={department.id} style={{ paddingInlineStart: 14 + depth * 26 }}>
        <button
          className="tree-toggle"
          aria-label={open ? 'طي' : 'توسيع'}
          disabled={!kids.length}
          onClick={() => setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(department.id)) next.delete(department.id);
            else next.add(department.id);
            return next;
          })}
        >{kids.length ? (open ? <ChevronDown size={15} /> : <ChevronLeft size={15} />) : <span className="tree-dot" />}</button>
        <div className="tree-main">
          <strong>{department.name}</strong>
          <small>{department.code}{department.branchName ? ` · ${department.branchName}` : ''}{department.managerName ? ` · المدير: ${department.managerName}` : ''}</small>
        </div>
        {department.costCenterCode && <span className="code-tag" title="مركز الكلفة في SAP">{department.costCenterCode}</span>}
        <span className="tree-count"><Users size={13} />{department.employeeCount ?? 0}</span>
        {!department.isActive && <Tone tone="muted">معطل</Tone>}
        {canManage && <button className="icon-link" aria-label={`تعديل ${department.name}`} onClick={() => onEdit(department)}><Pencil size={14} /></button>}
      </div>,
      ...(open ? render(department.id, depth + 1) : []),
    ];
  });
  return <section className="panel tree">{render(null, 0)}</section>;
}

/** Position level from the job title, coloured like the company's org chart (managers, supervisors, staff). */
function levelOf(title: string): 'manager' | 'supervisor' | 'staff' {
  const t = title.toLowerCase();
  if (/(مدير|manager|director|رئيس|head|chief|ceo|gm\b)/.test(t)) return 'manager';
  if (/(مشرف|supervisor|leader|قائد|senior|أقدم|مسؤول)/.test(t)) return 'supervisor';
  return 'staff';
}

function OrgChart({ departments }: { departments: Department[] }) {
  const chart = useLoad<{ departments: Department[]; employees: ChartEmployee[] }>('/org/chart', { departments: [], employees: [] });
  const [departmentId, setDepartmentId] = useState<string>('');
  const [zoom, setZoom] = useState(0.85);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [expandAll, setExpandAll] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const people = chart.data.employees.filter((person) => !departmentId || person.departmentId === departmentId);
  const thumbs = useEmployeeThumbs(chart.data.employees);
  const ids = new Set(people.map((person) => person.id));
  const roots = people.filter((person) => !person.managerId || !ids.has(person.managerId));
  const reportsOf = useMemo(() => {
    const map = new Map<string, ChartEmployee[]>();
    for (const person of people) if (person.managerId && ids.has(person.managerId)) map.set(person.managerId, [...(map.get(person.managerId) ?? []), person]);
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart.data, departmentId]);
  const withTeams = roots.filter((person) => reportsOf.has(person.id));
  const loose = roots.filter((person) => !reportsOf.has(person.id));
  const size = (id: string): number => (reportsOf.get(id) ?? []).reduce((sum, member) => sum + 1 + size(member.id), 0);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const overflow = element.scrollWidth - element.clientWidth;
    if (overflow > 0) element.scrollLeft = overflow / 2;
  }, [chart.data, departmentId, open, zoom]);
  const toggle = (id: string) => setOpen((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const node = (person: ChartEmployee, depth: number): JSX.Element => {
    const team = reportsOf.get(person.id) ?? [];
    const expanded = expandAll || depth < 1 || open.has(person.id);
    const level = levelOf(person.jobTitle);
    return (
      <li key={person.id}>
        <div className={`chart-node level-${level}`}>
          <button className="chart-card" onClick={() => navigate('employees', person.id)}>
            <PersonMark name={person.fullName} src={thumbs[person.id]} className="chart-photo" />
            <strong>{person.fullName}</strong><small>{person.jobTitle}</small><small>{person.branchName}</small>
          </button>
          {team.length > 0 && <button className="chart-toggle" onClick={() => toggle(person.id)} aria-expanded={expanded} title={expanded ? 'طي' : 'عرض الفريق'}>
            {expanded ? '−' : `+${size(person.id)}`}</button>}
        </div>
        {team.length > 0 && expanded && <ul>{team.map((member) => node(member, depth + 1))}</ul>}
      </li>
    );
  };
  return (
    <section className="panel">
      <div className="filter-bar chart-tools">
        <label className="field inline-field"><span>القسم</span>
          <select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
            <option value="">كل الأقسام</option>
            {departments.filter((item) => item.isActive).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <div className="segmented chart-zoom">
          <button type="button" onClick={() => setZoom((value) => Math.max(0.4, +(value - 0.15).toFixed(2)))}>−</button>
          <button type="button" aria-pressed="true">{Math.round(zoom * 100)}%</button>
          <button type="button" onClick={() => setZoom((value) => Math.min(1.3, +(value + 0.15).toFixed(2)))}>+</button>
        </div>
        <button className="button button-quiet" onClick={() => { setExpandAll(!expandAll); setOpen(new Set()); }}>{expandAll ? 'طي الكل' : 'توسيع الكل'}</button>
        <ul className="chart-legend"><li className="level-manager"><Bi ar={"مدراء"} en={"Managers"} /></li><li className="level-supervisor"><Bi ar={"مشرفون"} en={"Supervisors"} /></li><li className="level-staff"><Bi ar={"موظفون"} en={"Staff"} /></li></ul>
        <span className="result-count">{people.length} موظف</span>
      </div>
      {chart.loading ? <Loading /> : people.length ? <div className="org-chart" ref={scroller}>
        <div className="org-tree" style={{ zoom }}>
          <div className="chart-company"><img src="/brand/shield-256.png" alt="" /><strong>مجموعة الليث العبيدي للسيارات</strong><small>Al-Laith Al-Obaidi Automotive Group — Iraq</small></div>
          <ul>{withTeams.map((person) => node(person, 0))}</ul>
        </div>
        {loose.length > 0 && <div className="chart-loose"><strong>بلا مدير مباشر بعد ({loose.length})</strong><span>حدد مديرهم من «استيراد من Excel» أو من ملف الموظف.</span>
          <div className="chart-loose-list">{loose.map((person) => <button key={person.id} className={`chart-chip level-${levelOf(person.jobTitle)}`} onClick={() => navigate('employees', person.id)}>{person.fullName}<small>{person.jobTitle}</small></button>)}</div></div>}
      </div>
        : <Empty icon={<Network size={22} />} title="لا يوجد موظفون في هذا القسم" text="اربط الموظفين بالأقسام ومديريهم المباشرين من ملفاتهم." />}
    </section>
  );
}

function DepartmentDialog({ value, departments, branches, onClose, onSaved }: {
  value: Department | 'new' | null;
  departments: Department[];
  branches: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const editing = value && value !== 'new' ? value : null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      name: String(form.get('name') || ''),
      parentId: form.get('parentId') || null,
      branchId: form.get('branchId') || null,
      costCenterCode: String(form.get('costCenterCode') || '') || null,
      sortOrder: Number(form.get('sortOrder') || 0),
    };
    if (!editing) body.code = String(form.get('code') || '');
    else body.isActive = form.get('isActive') === 'on';
    setBusy(true);
    try {
      await session.call(editing ? `/org/departments/${editing.id}` : '/org/departments', { method: editing ? 'PUT' : 'POST', body });
      session.notify(editing ? 'تم تحديث القسم.' : 'تمت إضافة القسم.');
      onSaved();
    } catch (error) {
      session.fail(error, 'تعذر حفظ القسم.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={value !== null} title={editing ? `تعديل ${editing.name}` : 'قسم جديد'} subtitle="مركز الكلفة يُستخدم في قيود الرواتب المرحّلة إلى SAP." onClose={onClose}>
      <form onSubmit={submit} key={editing?.id ?? 'new'}>
        <div className="form-grid form-grid-2">
          <label className="field"><span>اسم القسم *</span><input name="name" required maxLength={120} defaultValue={editing?.name} /></label>
          <label className="field"><span>الرمز *</span><input name="code" required={!editing} disabled={Boolean(editing)} maxLength={24} dir="ltr" pattern="[A-Za-z0-9._\-]+" defaultValue={editing?.code} placeholder="SALES" /></label>
          <label className="field"><span>القسم الأعلى</span><select name="parentId" defaultValue={editing?.parentId ?? ''}><option value="">— قسم رئيسي —</option>{departments.filter((item) => item.id !== editing?.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="field"><span>الفرع (اختياري)</span><select name="branchId" defaultValue={editing?.branchId ?? ''}><option value="">كل الفروع</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
          <label className="field"><span>مركز الكلفة في SAP</span><input name="costCenterCode" maxLength={40} dir="ltr" defaultValue={editing?.costCenterCode ?? ''} placeholder="CC-SALES" /></label>
          <label className="field"><span>ترتيب العرض</span><input name="sortOrder" type="number" min={0} max={10000} defaultValue={editing?.sortOrder ?? 0} /></label>
          {editing && <label className="settings-check"><input type="checkbox" name="isActive" defaultChecked={editing.isActive} />القسم نشط</label>}
        </div>
        <div className="dialog-actions"><button className="button button-primary" disabled={busy}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</button><button type="button" className="button button-quiet" onClick={onClose}>إلغاء</button></div>
      </form>
    </Dialog>
  );
}

function TitleDialog({ value, departments, onClose, onSaved }: {
  value: JobTitle | 'new' | null;
  departments: Department[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const editing = value && value !== 'new' ? value : null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      name: String(form.get('name') || ''),
      departmentId: form.get('departmentId') || null,
      grade: String(form.get('grade') || '') || null,
      description: String(form.get('description') || '') || null,
    };
    if (!editing) body.code = String(form.get('code') || '');
    else body.isActive = form.get('isActive') === 'on';
    setBusy(true);
    try {
      await session.call(editing ? `/org/job-titles/${editing.id}` : '/org/job-titles', { method: editing ? 'PUT' : 'POST', body });
      session.notify(editing ? 'تم تحديث المسمى.' : 'تمت إضافة المسمى.');
      onSaved();
    } catch (error) {
      session.fail(error, 'تعذر حفظ المسمى.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={value !== null} title={editing ? `تعديل ${editing.name}` : 'مسمى وظيفي جديد'} onClose={onClose}>
      <form onSubmit={submit} key={editing?.id ?? 'new'}>
        <div className="form-grid form-grid-2">
          <label className="field"><span>المسمى *</span><input name="name" required maxLength={120} defaultValue={editing?.name} /></label>
          <label className="field"><span>الرمز *</span><input name="code" required={!editing} disabled={Boolean(editing)} maxLength={24} dir="ltr" pattern="[A-Za-z0-9._\-]+" defaultValue={editing?.code} placeholder="SALES-REP" /></label>
          <label className="field"><span>القسم</span><select name="departmentId" defaultValue={editing?.departmentId ?? ''}><option value="">عام</option>{departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="field"><span>الدرجة الوظيفية</span><input name="grade" maxLength={20} defaultValue={editing?.grade ?? ''} /></label>
          <label className="field settings-wide"><span>ملخص الوصف الوظيفي</span><textarea name="description" rows={3} maxLength={2000} defaultValue={editing?.description ?? ''} /></label>
          {editing && <label className="settings-check"><input type="checkbox" name="isActive" defaultChecked={editing.isActive} />المسمى نشط</label>}
        </div>
        <div className="dialog-actions"><button className="button button-primary" disabled={busy}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</button><button type="button" className="button button-quiet" onClick={onClose}>إلغاء</button></div>
      </form>
    </Dialog>
  );
}
