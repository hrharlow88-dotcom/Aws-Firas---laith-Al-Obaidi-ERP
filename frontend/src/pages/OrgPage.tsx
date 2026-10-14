import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Briefcase, ChevronDown, ChevronLeft, Network, Pencil, Plus, Users } from 'lucide-react';
import { Dialog, Empty, Loading, Tabs, Tone } from '../components/ui';
import { navigate } from '../lib/router';
import { useLoad, useSession } from '../lib/session';

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
}

type Tab = 'departments' | 'titles' | 'chart';

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
      ]} />

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

function OrgChart({ departments }: { departments: Department[] }) {
  const chart = useLoad<{ departments: Department[]; employees: ChartEmployee[] }>('/org/chart', { departments: [], employees: [] });
  const [departmentId, setDepartmentId] = useState<string>('');
  const scroller = useRef<HTMLDivElement>(null);
  // Wide trees overflow; start the view centred on the top of the hierarchy.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const overflow = element.scrollWidth - element.clientWidth;
    if (overflow > 0) element.scrollLeft = (getComputedStyle(element).direction === 'rtl' ? -1 : 1) * overflow / 2;
  }, [chart.data, departmentId]);
  const people = chart.data.employees.filter((person) => !departmentId || person.departmentId === departmentId);
  const ids = new Set(people.map((person) => person.id));
  const roots = people.filter((person) => !person.managerId || !ids.has(person.managerId));
  const reports = (id: string) => people.filter((person) => person.managerId === id);
  const node = (person: ChartEmployee, depth: number): JSX.Element => {
    const team = depth < 8 ? reports(person.id) : [];
    return (
      <li key={person.id}>
        <button className="chart-card" onClick={() => navigate('employees', person.id)}>
          <span className="person-mark">{person.fullName.slice(0, 1)}</span>
          <span><strong>{person.fullName}</strong><small>{person.jobTitle}</small><small>{person.branchName}</small></span>
        </button>
        {team.length > 0 && <ul>{team.map((member) => node(member, depth + 1))}</ul>}
      </li>
    );
  };
  return (
    <section className="panel">
      <div className="filter-bar">
        <label className="field inline-field"><span>القسم</span>
          <select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
            <option value="">كل الأقسام</option>
            {departments.filter((item) => item.isActive).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <span className="result-count">{people.length} موظف · المدير المباشر يحدَّد من ملف الموظف</span>
      </div>
      {chart.loading ? <Loading /> : people.length ? <div className="org-chart" ref={scroller}><ul>{roots.map((person) => node(person, 0))}</ul></div>
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
