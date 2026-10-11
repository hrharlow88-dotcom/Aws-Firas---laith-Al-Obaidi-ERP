import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowLeft,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  FileUp,
  LayoutDashboard,
  KeyRound,
  LogOut,
  Menu,
  Plus,
  Search,
  ShieldCheck,
  Users,
  UserRoundCog,
  Settings as SettingsIcon,
  X,
} from 'lucide-react';
import { SettingsPage } from './SettingsPage';
import type { Permission, SystemSettings, UserRole } from './SettingsPage';
import { LeavePage } from './LeavePage';

type Page = 'overview' | 'employees' | 'branches' | 'access' | 'leaves' | 'security' | 'settings';

interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  branchId: string | null;
  isActive?: boolean;
}

interface EmployeeSummary {
  total: number;
  active: number;
  onLeave: number;
  inactive: number;
}

interface Branch {
  id: string;
  code: string;
  name: string;
  city: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
  employeeCount?: number;
}

interface Employee {
  id: string;
  employeeNo: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  branchId: string;
  department: string;
  position: string;
  hireDate: string;
  employmentStatus: 'active' | 'inactive' | 'on_leave';
  customFields?: Record<string, string | number>;
  branch?: Pick<Branch, 'id' | 'code' | 'name' | 'city'>;
}

interface ApiResult<T> {
  data: T;
}

const roleNames: Record<UserRole, string> = {
  super_admin: 'مدير النظام',
  hr_manager: 'مدير الموارد البشرية',
  hr_staff: 'موظف موارد بشرية',
  finance: 'المالية',
  branch_manager: 'مدير فرع',
  viewer: 'مشاهدة فقط',
};

const defaultRolePermissions: Record<UserRole, Permission[]> = {
  super_admin: ['branches.manage', 'employees.create', 'employees.update', 'users.manage'],
  hr_manager: ['branches.manage', 'employees.create', 'employees.update'],
  hr_staff: ['employees.create', 'employees.update'],
  finance: [],
  branch_manager: ['employees.update'],
  viewer: [],
};

const statusNames = {
  active: 'على رأس العمل',
  inactive: 'غير نشط',
  on_leave: 'في إجازة',
} as const;

async function api<T>(
  path: string,
  token?: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.message || 'تعذر إكمال الطلب.');
  }
  return result as T;
}

function formatDate(value: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ar-IQ', { year: 'numeric', month: 'short', day: 'numeric' })
    .format(new Date(`${value}T00:00:00`));
}

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('erp_token') || '');
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<Page>('overview');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeSummary, setEmployeeSummary] = useState<EmployeeSummary>({ total: 0, active: 0, onLeave: 0, inactive: 0 });
  const [employeeTotal, setEmployeeTotal] = useState(0);
  const [employeePage, setEmployeePage] = useState(1);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [systemSettings, setSystemSettings] = useState<SystemSettings | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showEmployeeForm, setShowEmployeeForm] = useState(false);
  const [showBranchForm, setShowBranchForm] = useState(false);
  const [showUserForm, setShowUserForm] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const rolePermissions = systemSettings?.roles[user?.role || 'viewer'].permissions
    || defaultRolePermissions[user?.role || 'viewer'];
  const canCreateEmployees = rolePermissions.includes('employees.create');
  const canUpdateEmployees = rolePermissions.includes('employees.update');
  const canManageBranches = rolePermissions.includes('branches.manage');
  const canManageAccess = rolePermissions.includes('users.manage');
  const canViewLeaves = rolePermissions.includes('leaves.view');
  const canRequestLeaves = rolePermissions.includes('leaves.request');
  const canApproveLeaves = rolePermissions.includes('leaves.approve');
  const canManageLeaveBalances = rolePermissions.includes('leaves.manage_balances');
  const canManageSettings = user?.role === 'super_admin';

  const notify = useCallback((message: string, isError = false) => {
    if (isError) {
      setError(message);
      setSuccess('');
      return;
    }
    setSuccess(message);
    setError('');
    window.setTimeout(() => setSuccess(''), 3500);
  }, []);
  const notifyLeaveError = useCallback((message: string) => notify(message, true), [notify]);

  async function handleSettingsSave(settings: SystemSettings) {
    setSavingSettings(true);
    try {
      const result = await api<ApiResult<SystemSettings>>('/settings', token, { method: 'PUT', body: settings });
      setSystemSettings(result.data);
      notify('تم حفظ إعدادات النظام.');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'تعذر حفظ الإعدادات.', true);
    } finally {
      setSavingSettings(false);
    }
  }

  const signOut = useCallback(() => {
    sessionStorage.removeItem('erp_token');
    setToken('');
    setUser(null);
    setEmployees([]);
    setBranches([]);
    setUsers([]);
    setSystemSettings(null);
  }, []);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    api<{ user: User }>('/auth/me', token)
      .then((result) => setUser(result.user))
      .catch(() => signOut())
      .finally(() => setLoading(false));
  }, [token, signOut]);

  const loadData = useCallback(async () => {
    if (!token || !user) return;
    setBusy(true);
    setError('');
    try {
      const employeeQuery = page === 'overview'
        ? '/employees?page=1&pageSize=5&recent=1'
        : `/employees?page=${employeePage}&pageSize=25${search ? `&search=${encodeURIComponent(search)}` : ''}`;
      const [branchResult, employeeResult, summaryResult, usersResult] = await Promise.all([
        api<ApiResult<Branch[]>>('/branches', token),
        api<{ data: Employee[]; pagination: { total: number } }>(employeeQuery, token),
        api<ApiResult<EmployeeSummary>>('/employees/summary', token),
        canManageAccess && page === 'access' ? api<ApiResult<User[]>>('/users', token) : Promise.resolve(null),
      ]);
      setBranches(branchResult.data);
      setEmployees(employeeResult.data);
      setEmployeeTotal(employeeResult.pagination.total);
      setEmployeeSummary(summaryResult.data);
      if (usersResult) {
        setUsers(usersResult.data);
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes('تسجيل الدخول')) signOut();
      else notify(cause instanceof Error ? cause.message : 'تعذر تحميل بيانات النظام.', true);
    } finally {
      setBusy(false);
    }
  }, [token, user, page, search, employeePage, signOut, notify, canManageAccess]);

  useEffect(() => {
    if (user) void loadData();
  }, [user, loadData]);

  useEffect(() => {
    if (!token || !user) return;
    let current = true;
    api<ApiResult<SystemSettings>>('/settings', token)
      .then((result) => {
        if (current) setSystemSettings(result.data);
      })
      .catch((cause: unknown) => {
        if (!current) return;
        if (cause instanceof Error && cause.message.includes('تسجيل الدخول')) signOut();
        else notify(cause instanceof Error ? cause.message : 'تعذر تحميل إعدادات النظام.', true);
      });
    return () => { current = false; };
  }, [token, user?.id, signOut, notify]);

  const activeEmployees = employeeSummary.active;
  const roleLabels = Object.fromEntries(
    Object.entries(systemSettings?.roles || roleNames).map(([role, value]) => [
      role,
      typeof value === 'string' ? value : value.label,
    ]),
  ) as Record<UserRole, string>;

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const result = await api<{ token: string; user: User }>('/auth/login', undefined, {
        method: 'POST',
        body: { email: form.get('email'), password: form.get('password') },
      });
      sessionStorage.setItem('erp_token', result.token);
      setToken(result.token);
      setUser(result.user);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'تعذر تسجيل الدخول.', true);
    } finally {
      setBusy(false);
    }
  }

  async function handleEmployeeCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body: Record<string, unknown> = {};
    const customFields: Record<string, string | number> = {};
    for (const [key, value] of form.entries()) {
      if (key.startsWith('customFields.') && typeof value === 'string') {
        const fieldKey = key.slice('customFields.'.length);
        const field = systemSettings?.employeeFields.find((item) => item.key === fieldKey && item.enabled);
        if (value !== '') customFields[fieldKey] = field?.type === 'number' ? Number(value) : value;
      } else {
        body[key] = value;
      }
    }
    if (Object.keys(customFields).length) body.customFields = customFields;
    try {
      await api('/employees', token, { method: 'POST', body });
      setShowEmployeeForm(false);
      formElement.reset();
      notify('تمت إضافة الموظف بنجاح.');
      await loadData();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'تعذرت إضافة الموظف.', true);
    }
  }

  async function handleBranchCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body = Object.fromEntries(form.entries());
    try {
      await api('/branches', token, { method: 'POST', body });
      setShowBranchForm(false);
      formElement.reset();
      notify('تمت إضافة الفرع بنجاح.');
      await loadData();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'تعذرت إضافة الفرع.', true);
    }
  }

  async function handleUserCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body = Object.fromEntries(form.entries());
    try {
      await api('/users', token, { method: 'POST', body });
      setShowUserForm(false);
      formElement.reset();
      notify('تم إنشاء حساب المستخدم.');
      await loadData();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'تعذر إنشاء الحساب.', true);
    }
  }

  async function handlePasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const currentPassword = String(form.get('currentPassword') || '');
    const newPassword = String(form.get('newPassword') || '');
    const confirmPassword = String(form.get('confirmPassword') || '');
    if (newPassword !== confirmPassword) {
      notify('كلمتا المرور الجديدتان غير متطابقتين.', true);
      return;
    }
    try {
      const result = await api<{ token: string; message: string }>('/auth/change-password', token, {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      sessionStorage.setItem('erp_token', result.token);
      setToken(result.token);
      notify(result.message);
      formElement.reset();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'تعذر تغيير كلمة المرور.', true);
    }
  }

  async function toggleEmployeeStatus(employee: Employee) {
    const action = employee.employmentStatus === 'active' ? 'تعطيل' : 'تفعيل';
    if (action === 'تعطيل' && !window.confirm(`هل تريد تعطيل سجل ${employee.fullName}؟`)) return;
    try {
      await api(`/employees/${employee.id}`, token, {
        method: 'PUT',
        body: { employmentStatus: employee.employmentStatus === 'active' ? 'inactive' : 'active' },
      });
      notify('تم تحديث حالة الموظف.');
      await loadData();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'تعذر تحديث الحالة.', true);
    }
  }

  async function toggleUserStatus(target: User) {
    const action = target.isActive ? 'تعطيل' : 'إعادة تفعيل';
    if (target.isActive && !window.confirm(`هل تريد تعطيل حساب ${target.name} ومنعه من الدخول؟`)) return;
    try {
      await api(`/users/${target.id}`, token, {
        method: 'PUT',
        body: { isActive: !target.isActive },
      });
      notify('تم تحديث صلاحية الحساب.');
      await loadData();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'تعذر تحديث الحساب.', true);
    }
  }

  if (loading) {
    return <main className="startup"><div className="startup-mark">LO</div><p>جارٍ تهيئة مساحة العمل…</p></main>;
  }

  if (!token || !user) {
    return <Login onSubmit={handleLogin} busy={busy} error={error} companyName={systemSettings?.company.displayName} />;
  }

  const pageTitle: Record<Page, string> = {
    overview: 'نظرة عامة',
    employees: 'دليل الموظفين',
    branches: 'الفروع والمواقع',
    access: 'المستخدمون والصلاحيات',
    leaves: 'إدارة الإجازات',
    security: 'أمان الحساب',
    settings: 'إعدادات النظام',
  };

  return (
    <div className="app-shell">
      <button className="nav-scrim" aria-label="إغلاق القائمة" onClick={() => setMobileNav(false)} hidden={!mobileNav} />
      <aside className={`rail ${mobileNav ? 'rail-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">LO</div>
          <div><strong>{systemSettings?.company.displayName || 'مجموعة ليث العبيدي'}</strong><span>نظام إدارة الشركة</span></div>
          <button className="icon-button rail-close" aria-label="إغلاق القائمة" onClick={() => setMobileNav(false)}><X size={18} /></button>
        </div>
        <div className="rail-label">مساحة العمل</div>
        <nav className="main-nav" aria-label="التنقل الرئيسي">
          <NavButton active={page === 'overview'} icon={<LayoutDashboard />} label="نظرة عامة" onClick={() => { setPage('overview'); setMobileNav(false); }} />
          <NavButton active={page === 'employees'} icon={<Users />} label="الموظفون" onClick={() => { setPage('employees'); setMobileNav(false); }} />
          <NavButton active={page === 'branches'} icon={<Building2 />} label="الفروع" onClick={() => { setPage('branches'); setMobileNav(false); }} />
          {canManageAccess && <NavButton active={page === 'access'} icon={<ShieldCheck />} label="المستخدمون والصلاحيات" onClick={() => { setPage('access'); setMobileNav(false); }} />}
          {canViewLeaves && <NavButton active={page === 'leaves'} icon={<CalendarDays />} label="الإجازات والأرصدة" onClick={() => { setPage('leaves'); setMobileNav(false); }} />}
          {canManageSettings && <NavButton active={page === 'settings'} icon={<SettingsIcon />} label="إعدادات النظام" onClick={() => { setPage('settings'); setMobileNav(false); }} />}
          <NavButton active={page === 'security'} icon={<KeyRound />} label="أمان الحساب" onClick={() => { setPage('security'); setMobileNav(false); }} />
        </nav>
        <div className="rail-bottom">
          <div className="privacy-note"><ShieldCheck size={16} /><span>الوصول للبيانات<br />محدد حسب الدور</span></div>
          <div className="rail-profile">
            <div className="avatar">{user.name.slice(0, 1)}</div>
            <div className="profile-copy"><strong>{user.name}</strong><span>{roleLabels[user.role]}</span></div>
            <button className="icon-button" onClick={signOut} title="تسجيل الخروج" aria-label="تسجيل الخروج"><LogOut size={17} /></button>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-title">
            <button className="icon-button menu-trigger" aria-label="فتح القائمة" onClick={() => setMobileNav(true)}><Menu size={20} /></button>
            <div><span className="breadcrumb">{systemSettings?.company.displayName || 'مجموعة ليث العبيدي'} / مساحة العمل</span><h1>{pageTitle[page]}</h1></div>
          </div>
          <div className="topbar-end">
            <span className="today-date"><Clock3 size={15} />{new Intl.DateTimeFormat('ar-IQ', { dateStyle: 'full' }).format(new Date())}</span>
            <button className="profile-trigger" onClick={signOut} title="تسجيل الخروج" aria-label="تسجيل الخروج"><span className="avatar avatar-small">{user.name.slice(0, 1)}</span><span>{user.name}</span><ChevronDown size={15} /></button>
          </div>
        </header>

        <div className="page-content">
          {(error || success) && <div className={`notice ${error ? 'notice-error' : 'notice-success'}`} role="status">
            {error ? <CircleHelp size={17} /> : <Check size={17} />}
            <span>{error || success}</span>
            <button className="icon-button" aria-label="إغلاق التنبيه" onClick={() => { setError(''); setSuccess(''); }}><X size={16} /></button>
          </div>}

          {page === 'overview' && <Dashboard
            employees={employees}
            branches={branches}
            activeEmployees={activeEmployees}
            totalEmployees={employeeSummary.total}
            canCreateEmployees={canCreateEmployees}
            onNavigate={setPage}
            onAddEmployee={() => { setPage('employees'); setShowEmployeeForm(true); }}
            onAddBranch={() => { setPage('branches'); setShowBranchForm(true); }}
          />}
          {page === 'employees' && <EmployeesPage
            employees={employees}
            branches={branches}
            search={search}
            busy={busy}
            total={employeeTotal}
            page={employeePage}
            pageCount={Math.max(1, Math.ceil(employeeTotal / 25))}
            canManage={canCreateEmployees}
            canUpdate={canUpdateEmployees}
            customFields={['super_admin', 'hr_manager', 'hr_staff'].includes(user.role) ? systemSettings?.employeeFields.filter((field) => field.enabled) || [] : []}
            onSearch={(value) => { setSearch(value); setEmployeePage(1); }}
            onPage={setEmployeePage}
            onCreate={() => setShowEmployeeForm(!showEmployeeForm)}
            onSubmit={handleEmployeeCreate}
            onToggle={toggleEmployeeStatus}
            showForm={showEmployeeForm}
          />}
          {page === 'branches' && <BranchesPage
            branches={branches}
            canManage={Boolean(canManageBranches)}
            onCreate={() => setShowBranchForm(!showBranchForm)}
            onSubmit={handleBranchCreate}
            showForm={showBranchForm}
          />}
          {page === 'access' && canManageAccess && <AccessPage
            users={users}
            branches={branches}
            roleNames={roleLabels}
            canGrantAdmin={user.role === 'super_admin'}
            onCreate={() => setShowUserForm(!showUserForm)}
            onSubmit={handleUserCreate}
            onToggle={toggleUserStatus}
            showForm={showUserForm}
          />}
          {page === 'leaves' && canViewLeaves && systemSettings && <LeavePage
            token={token}
            userId={user.id}
            userRole={user.role}
            settings={systemSettings}
            canRequest={canRequestLeaves}
            canApprove={canApproveLeaves}
            canManageBalances={canManageLeaveBalances}
            onError={notifyLeaveError}
            onSuccess={notify}
          />}
          {page === 'security' && <SecurityPage onSubmit={handlePasswordChange} />}
          {page === 'settings' && canManageSettings && systemSettings && <SettingsPage value={systemSettings} busy={savingSettings} onSave={handleSettingsSave} />}

          <footer className="page-footer"><span>{systemSettings?.company.displayName || 'مجموعة ليث العبيدي للسيارات'}</span><span>نظام الإدارة الداخلي · المرحلة الأولى</span></footer>
        </div>
      </main>
    </div>
  );
}

function Login({ onSubmit, busy, error, companyName }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean; error: string; companyName?: string }) {
  return (
    <main className="login-layout">
      <section className="login-story">
        <div className="login-brand"><div className="brand-mark">LO</div><span>{companyName || 'مجموعة ليث العبيدي للسيارات'}</span></div>
        <div className="login-message"><span className="gold-rule" /><h1>إدارة موحدة.<br />فروع متصلة.</h1><p>منصة العمل الداخلية لإدارة فروع المجموعة وموظفيها بصلاحيات واضحة.</p></div>
        <span className="login-footnote">نظام موارد مؤسسي · واجهة عربية</span>
      </section>
      <section className="login-panel">
        <form className="login-form" onSubmit={onSubmit}>
          <span className="form-symbol"><ShieldCheck size={22} /></span>
          <h2>تسجيل الدخول</h2>
          <p>أدخل بيانات حسابك للوصول إلى مساحة العمل.</p>
          {error && <div className="notice notice-error" role="alert"><CircleHelp size={17} /><span>{error}</span></div>}
          <label className="field"><span>البريد الإلكتروني</span><input name="email" type="email" autoComplete="username" required placeholder="name@company.com" dir="ltr" /></label>
          <label className="field"><span>كلمة المرور</span><input name="password" type="password" autoComplete="current-password" required minLength={12} dir="ltr" /></label>
          <button className="button button-primary login-submit" disabled={busy}>{busy ? 'جارٍ التحقق…' : 'دخول آمن'}<ArrowLeft size={17} /></button>
          <div className="login-security"><ShieldCheck size={15} /><span>الجلسة محمية وتنتهي تلقائياً بعد 8 ساعات.</span></div>
        </form>
      </section>
    </main>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return <button className={`nav-item ${active ? 'nav-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>{icon}<span>{label}</span>{active && <ArrowDownLeft size={15} className="nav-indicator" />}</button>;
}

function Dashboard({ employees, branches, activeEmployees, totalEmployees, canCreateEmployees, onNavigate, onAddEmployee, onAddBranch }: {
  employees: Employee[];
  branches: Branch[];
  activeEmployees: number;
  totalEmployees: number;
  canCreateEmployees: boolean;
  onNavigate: (page: Page) => void;
  onAddEmployee: () => void;
  onAddBranch: () => void;
}) {
  const recent = [...employees].sort((a, b) => b.hireDate.localeCompare(a.hireDate)).slice(0, 5);
  return (
    <section className="screen">
      <div className="screen-heading">
        <div><h2>صباح الخير، أهلاً بعودتك</h2><p>هذه نظرة موجزة على بيانات الموارد البشرية والفروع.</p></div>
        <div className="heading-actions"><button className="button button-quiet" onClick={() => onNavigate('employees')}><Users size={16} />دليل الموظفين</button>{canCreateEmployees && <button className="button button-primary" onClick={onAddEmployee}><Plus size={17} />موظف جديد</button>}</div>
      </div>
      <div className="kpi-row">
        <button className="kpi" onClick={() => onNavigate('employees')}><span className="kpi-label"><Users size={16} />إجمالي الموظفين</span><strong>{totalEmployees.toLocaleString('ar-IQ')}</strong><span className="kpi-foot">سجلات الموظفين المسجلة</span></button>
        <button className="kpi" onClick={() => onNavigate('employees')}><span className="kpi-label"><span className="status-dot" />على رأس العمل</span><strong>{activeEmployees.toLocaleString('ar-IQ')}</strong><span className="kpi-foot">موظف نشط حالياً</span></button>
        <button className="kpi" onClick={() => onNavigate('branches')}><span className="kpi-label"><Building2 size={16} />الفروع النشطة</span><strong>{branches.filter((branch) => branch.isActive).length.toLocaleString('ar-IQ')}</strong><span className="kpi-foot">من {branches.length.toLocaleString('ar-IQ')} موقع مسجل</span></button>
        <div className="kpi kpi-static"><span className="kpi-label"><ShieldCheck size={16} />مستوى الوصول</span><strong>حسب الدور</strong><span className="kpi-foot">الصلاحيات تطبق على مستوى الخادم</span></div>
      </div>
      <div className="dashboard-grid">
        <section className="panel roster-panel">
          <div className="panel-head"><div><h3>أحدث المنضمين</h3><p>آخر الموظفين بحسب تاريخ التعيين</p></div><button className="text-button" onClick={() => onNavigate('employees')}>عرض الدليل<ArrowLeft size={15} /></button></div>
          {recent.length ? <div className="table-scroll"><table><thead><tr><th>الموظف</th><th>القسم والمنصب</th><th>الفرع</th><th>تاريخ التعيين</th></tr></thead><tbody>
            {recent.map((employee) => <tr key={employee.id}><td><span className="person-cell"><span className="person-mark">{employee.fullName.slice(0, 1)}</span><span><strong>{employee.fullName}</strong><small>{employee.employeeNo}</small></span></span></td><td><strong>{employee.department}</strong><small className="table-sub">{employee.position}</small></td><td>{employee.branch?.name || branches.find((branch) => branch.id === employee.branchId)?.name || '—'}</td><td>{formatDate(employee.hireDate)}</td></tr>)}
          </tbody></table></div> : <EmptyState icon={<Users size={22} />} title="لا توجد سجلات موظفين بعد" description="أضف الفروع والموظفين للبدء بإدارة موارد المجموعة." action="إضافة أول موظف" onClick={onAddEmployee} />}
        </section>
        <section className="panel branch-panel">
          <div className="panel-head"><div><h3>الفروع والمواقع</h3><p>ملخص مواقع المجموعة</p></div><button className="icon-link" aria-label="إدارة الفروع" onClick={() => onNavigate('branches')}><ArrowLeft size={17} /></button></div>
          {branches.length ? <div className="branch-list">{branches.slice(0, 5).map((branch) => <button className="branch-row" key={branch.id} onClick={() => onNavigate('branches')}><span className="branch-symbol"><Building2 size={17} /></span><span className="branch-row-copy"><strong>{branch.name}</strong><small>{branch.city} · {branch.code}</small></span><span className="branch-row-count">{(branch.employeeCount || 0).toLocaleString('ar-IQ')}<small>موظف</small></span></button>)}</div> : <EmptyState icon={<Building2 size={22} />} title="أضف مواقع المجموعة" description="سجّل الفروع أولاً لربط الموظفين بمواقعهم." action="إضافة فرع" onClick={onAddBranch} />}
        </section>
      </div>
      <section className="next-stage"><span className="next-stage-icon"><FileUp size={19} /></span><div><strong>الخطوة التالية: بيانات الموارد البشرية والرواتب</strong><p>سيتم تجهيز الحضور والإجازات والرواتب واستيراد Excel بعد تثبيت بيانات الموظفين والفروع.</p></div><span className="stage-tag">قيد التخطيط</span></section>
    </section>
  );
}

function EmployeesPage({ employees, branches, search, busy, total, page, pageCount, canManage, canUpdate, customFields, onSearch, onPage, onCreate, onSubmit, onToggle, showForm }: {
  employees: Employee[];
  branches: Branch[];
  search: string;
  busy: boolean;
  total: number;
  page: number;
  pageCount: number;
  canManage: boolean;
  canUpdate: boolean;
  customFields: SystemSettings['employeeFields'];
  onSearch: (value: string) => void;
  onPage: (page: number) => void;
  onCreate: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggle: (employee: Employee) => void;
  showForm: boolean;
}) {
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2>دليل الموظفين</h2><p>سجلات موحدة مرتبطة بالفروع والأقسام والمناصب.</p></div>{canManage && <button className="button button-primary" onClick={onCreate}><Plus size={17} />إضافة موظف</button>}</div>
      {showForm && canManage && <form className="panel form-panel" onSubmit={onSubmit}>
        <div className="panel-head"><div><h3>بيانات الموظف الأساسية</h3><p>الحقول المميزة مطلوبة. بيانات الرواتب غير مضمنة في هذه المرحلة.</p></div><button type="button" className="icon-button" aria-label="إغلاق النموذج" onClick={onCreate}><X size={18} /></button></div>
        <div className="form-grid">
          <label className="field"><span>رقم الموظف *</span><input name="employeeNo" required maxLength={40} /></label>
          <label className="field"><span>الاسم الكامل *</span><input name="fullName" required maxLength={180} /></label>
          <label className="field"><span>الفرع *</span><select name="branchId" required defaultValue=""><option value="" disabled>اختر الفرع</option>{branches.filter((branch) => branch.isActive).map((branch) => <option key={branch.id} value={branch.id}>{branch.name} · {branch.city}</option>)}</select></label>
          <label className="field"><span>القسم *</span><input name="department" required maxLength={120} /></label>
          <label className="field"><span>المسمى الوظيفي *</span><input name="position" required maxLength={120} /></label>
          <label className="field"><span>تاريخ التعيين *</span><input name="hireDate" type="date" required /></label>
          <label className="field"><span>البريد الإلكتروني</span><input name="email" type="email" maxLength={254} dir="ltr" /></label>
          <label className="field"><span>رقم الهاتف</span><input name="phone" maxLength={40} dir="ltr" /></label>
          {customFields.map((field) => <label className="field" key={field.id}><span>{field.label}{field.required ? ' *' : ''}</span>
            {field.type === 'select'
              ? <select name={`customFields.${field.key}`} required={field.required} defaultValue=""><option value="">اختر</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select>
              : <input name={`customFields.${field.key}`} type={field.type} required={field.required} maxLength={field.type === 'text' ? 500 : undefined} />}
          </label>)}
        </div>
        <div className="form-actions"><button className="button button-primary" type="submit"><Check size={16} />حفظ بيانات الموظف</button><button className="button button-quiet" type="button" onClick={onCreate}>إلغاء</button></div>
      </form>}
      <section className="panel directory-panel">
        <div className="filter-bar"><label className="search-field"><Search size={17} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="ابحث بالاسم أو الرقم أو القسم…" aria-label="بحث في الموظفين" /></label><span className="result-count">{total.toLocaleString('ar-IQ')} سجل</span></div>
        {employees.length ? <><div className="table-scroll"><table className="directory-table"><thead><tr><th>الموظف</th><th>القسم والمنصب</th><th>الفرع</th><th>تاريخ التعيين</th><th>الحالة</th>{customFields.map((field) => <th key={field.id}>{field.label}</th>)}{canUpdate && <th>إجراء</th>}</tr></thead><tbody>
          {employees.map((employee) => <tr key={employee.id}><td><span className="person-cell"><span className="person-mark">{employee.fullName.slice(0, 1)}</span><span><strong>{employee.fullName}</strong><small>{employee.employeeNo}{employee.email ? ` · ${employee.email}` : ''}</small></span></span></td><td><strong>{employee.department}</strong><small className="table-sub">{employee.position}</small></td><td>{employee.branch?.name || branches.find((branch) => branch.id === employee.branchId)?.name || '—'}</td><td>{formatDate(employee.hireDate)}</td><td><span className={`state-pill state-${employee.employmentStatus}`}><i />{statusNames[employee.employmentStatus]}</span></td>{customFields.map((field) => <td key={field.id}>{employee.customFields?.[field.key] ?? '—'}</td>)}{canUpdate && <td><button className="table-action" onClick={() => onToggle(employee)}>{employee.employmentStatus === 'active' ? 'تعطيل' : 'تفعيل'}</button></td>}</tr>)}
        </tbody></table></div><div className="pagination"><span>عرض {Math.min((page - 1) * 25 + 1, total).toLocaleString('ar-IQ')}–{Math.min(page * 25, total).toLocaleString('ar-IQ')} من {total.toLocaleString('ar-IQ')}</span><div><button className="button button-quiet" disabled={page <= 1 || busy} onClick={() => onPage(page - 1)}>السابق</button><span>{page.toLocaleString('ar-IQ')} / {pageCount.toLocaleString('ar-IQ')}</span><button className="button button-quiet" disabled={page >= pageCount || busy} onClick={() => onPage(page + 1)}>التالي</button></div></div></> : <EmptyState icon={<Users size={22} />} title={search ? 'لا توجد نتائج مطابقة' : 'دليل الموظفين فارغ'} description={search ? 'جرّب البحث برقم الموظف أو القسم.' : 'ابدأ بإضافة أول سجل موظف واربطه بفرعه.'} action={!search && canManage ? 'إضافة موظف' : undefined} onClick={onCreate} />}
        {busy && <div className="table-loading">جارٍ تحديث السجلات…</div>}
      </section>
    </section>
  );
}

function BranchesPage({ branches, canManage, onCreate, onSubmit, showForm }: {
  branches: Branch[];
  canManage: boolean;
  onCreate: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  showForm: boolean;
}) {
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2>الفروع والمواقع</h2><p>أنشئ هيكل المواقع الذي ترتبط به سجلات الموظفين.</p></div>{canManage && <button className="button button-primary" onClick={onCreate}><Plus size={17} />إضافة فرع</button>}</div>
      {showForm && canManage && <form className="panel form-panel" onSubmit={onSubmit}>
        <div className="panel-head"><div><h3>موقع جديد</h3><p>سيظهر الموقع للربط به عند إضافة الموظفين.</p></div><button type="button" className="icon-button" aria-label="إغلاق النموذج" onClick={onCreate}><X size={18} /></button></div>
        <div className="form-grid">
          <label className="field"><span>رمز الفرع *</span><input name="code" required maxLength={24} dir="ltr" placeholder="ERB-01" /></label>
          <label className="field"><span>اسم الفرع *</span><input name="name" required maxLength={120} /></label>
          <label className="field"><span>المدينة *</span><input name="city" required maxLength={80} /></label>
          <label className="field"><span>العنوان</span><input name="address" maxLength={240} /></label>
          <label className="field"><span>رقم الهاتف</span><input name="phone" maxLength={40} dir="ltr" /></label>
        </div>
        <div className="form-actions"><button className="button button-primary" type="submit"><Check size={16} />حفظ الفرع</button><button className="button button-quiet" type="button" onClick={onCreate}>إلغاء</button></div>
      </form>}
      {branches.length ? <div className="branch-table-wrap panel"><div className="table-scroll"><table><thead><tr><th>الفرع</th><th>المدينة</th><th>رمز الموقع</th><th>عدد الموظفين</th><th>الحالة</th></tr></thead><tbody>
        {branches.map((branch) => <tr key={branch.id}><td><span className="branch-cell"><span className="branch-symbol"><Building2 size={17} /></span><span><strong>{branch.name}</strong><small>{branch.address || 'لا يوجد عنوان مسجل'}</small></span></span></td><td>{branch.city}</td><td><span className="code-tag">{branch.code}</span></td><td>{(branch.employeeCount || 0).toLocaleString('ar-IQ')}</td><td><span className={`state-pill ${branch.isActive ? 'state-active' : 'state-inactive'}`}><i />{branch.isActive ? 'نشط' : 'غير نشط'}</span></td></tr>)}
      </tbody></table></div></div> : <div className="panel"><EmptyState icon={<Building2 size={22} />} title="لا توجد فروع مسجلة" description="أضف أول موقع عمل لتنظيم السجلات حسب الفرع." action={canManage ? 'إضافة فرع' : undefined} onClick={onCreate} /></div>}
    </section>
  );
}

function AccessPage({ users, branches, roleNames, canGrantAdmin, onCreate, onSubmit, onToggle, showForm }: {
  users: User[];
  branches: Branch[];
  roleNames: Record<UserRole, string>;
  canGrantAdmin: boolean;
  onCreate: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggle: (user: User) => void;
  showForm: boolean;
}) {
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2>المستخدمون والصلاحيات</h2><p>أنشئ حسابات الفريق وامنح كل حساب أقل صلاحية يحتاجها.</p></div><button className="button button-primary" onClick={onCreate}><Plus size={17} />إضافة مستخدم</button></div>
      <div className="permission-note"><ShieldCheck size={18} /><div><strong>إدارة الوصول مركزية</strong><span>تُتحقق الصلاحيات في الخادم مع كل طلب، ومديرو الفروع محصورون في بيانات مواقعهم.</span></div></div>
      {showForm && <form className="panel form-panel" onSubmit={onSubmit}>
        <div className="panel-head"><div><h3>حساب مستخدم جديد</h3><p>استخدم كلمة مرور مؤقتة فريدة وأبلغ المستخدم بها بطريقة آمنة.</p></div><button type="button" className="icon-button" aria-label="إغلاق النموذج" onClick={onCreate}><X size={18} /></button></div>
        <div className="form-grid">
          <label className="field"><span>الاسم *</span><input name="name" required maxLength={120} /></label>
          <label className="field"><span>البريد الإلكتروني *</span><input name="email" type="email" required maxLength={254} dir="ltr" /></label>
          <label className="field"><span>الدور *</span><select name="role" defaultValue="viewer">{Object.entries(roleNames).filter(([role]) => canGrantAdmin || role !== 'super_admin').map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select></label>
          <label className="field"><span>الفرع (لمدير الفرع)</span><select name="branchId" defaultValue=""><option value="">غير مرتبط</option>{branches.filter((branch) => branch.isActive).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
          <label className="field"><span>كلمة المرور المؤقتة *</span><input name="password" type="password" minLength={12} required autoComplete="new-password" dir="ltr" /><small>12 محرفاً على الأقل.</small></label>
        </div>
        <div className="form-actions"><button className="button button-primary" type="submit"><Check size={16} />إنشاء الحساب</button><button className="button button-quiet" type="button" onClick={onCreate}>إلغاء</button></div>
      </form>}
      <section className="panel directory-panel"><div className="panel-head"><div><h3>حسابات النظام</h3><p>{users.length.toLocaleString('ar-IQ')} مستخدم مسجل</p></div></div>
        {users.length ? <div className="table-scroll"><table><thead><tr><th>المستخدم</th><th>الدور</th><th>الفرع</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>
          {users.map((account) => <tr key={account.id}><td><span className="person-cell"><span className="person-mark">{account.name.slice(0, 1)}</span><span><strong>{account.name}</strong><small>{account.email}</small></span></span></td><td><span className="role-tag">{roleNames[account.role]}</span></td><td>{branches.find((branch) => branch.id === account.branchId)?.name || 'كل الفروع'}</td><td><span className={`state-pill ${account.isActive ? 'state-active' : 'state-inactive'}`}><i />{account.isActive ? 'نشط' : 'معطل'}</span></td><td><button className="table-action" onClick={() => onToggle(account)}>{account.isActive ? 'تعطيل الحساب' : 'إعادة التفعيل'}</button></td></tr>)}
        </tbody></table></div> : <EmptyState icon={<UserRoundCog size={22} />} title="لا توجد حسابات إضافية" description="أضف مستخدمين بصلاحيات محدودة بدلاً من مشاركة حساب المدير." /> }
      </section>
    </section>
  );
}

function SecurityPage({ onSubmit }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <section className="screen security-screen">
      <div className="screen-heading"><div><h2>أمان الحساب</h2><p>حدّث كلمة مرور حسابك وأغلق الجلسات السابقة.</p></div></div>
      <form className="panel password-panel" onSubmit={onSubmit}>
        <div className="panel-head"><div><h3>تغيير كلمة المرور</h3><p>بعد الحفظ، ستحتاج إلى استخدام كلمة المرور الجديدة في تسجيل الدخول التالي.</p></div><span className="form-symbol"><KeyRound size={20} /></span></div>
        <div className="password-fields">
          <label className="field"><span>كلمة المرور الحالية *</span><input name="currentPassword" type="password" required autoComplete="current-password" dir="ltr" /></label>
          <label className="field"><span>كلمة المرور الجديدة *</span><input name="newPassword" type="password" required minLength={12} autoComplete="new-password" dir="ltr" /><small>12 محرفاً على الأقل.</small></label>
          <label className="field"><span>تأكيد كلمة المرور الجديدة *</span><input name="confirmPassword" type="password" required minLength={12} autoComplete="new-password" dir="ltr" /></label>
        </div>
        <div className="form-actions"><button className="button button-primary" type="submit"><ShieldCheck size={16} />تحديث كلمة المرور</button></div>
      </form>
    </section>
  );
}

function EmptyState({ icon, title, description, action, onClick }: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: string;
  onClick?: () => void;
}) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><strong>{title}</strong><p>{description}</p>{action && <button className="button button-quiet" onClick={onClick}><Plus size={16} />{action}</button>}</div>;
}

export default App;
