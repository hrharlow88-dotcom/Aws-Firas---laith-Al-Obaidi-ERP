import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Fingerprint,
  KeyRound,
  LayoutGrid,
  LogOut,
  Plus,
  Search,
  ShieldCheck,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { SettingsPage } from './SettingsPage';
import type { Permission, SystemSettings, UserRole } from './SettingsPage';
import { LeavePage } from './LeavePage';
import { api as request } from './lib/api';
import { buildSession, SessionProvider, useLoad, useSession } from './lib/session';
import { navigate, useRoute } from './lib/router';
import { AppearanceControls, Bi, BrandStrip, DeveloperCredit, SYSTEM_NAME } from './components/Brand';
import { ViewSwitch, useViewMode } from './components/ViewSwitch';
import { MySignature } from './components/Signature';
import { PortalAccountsPage, RequestsPage } from './pages/RequestsPage';
import { DisciplinePage } from './pages/DisciplinePage';
import { TicketsPage } from './pages/TicketsPage';
import { RecruitmentPage } from './pages/RecruitmentPage';
import { DOCUMENT_TYPES, EMPLOYMENT_TYPES, formatMoney, monthLabel } from './lib/format';
import { OrgPage } from './pages/OrgPage';
import type { Department, JobTitle } from './pages/OrgPage';
import { EmployeeProfilePage } from './pages/EmployeeProfilePage';
import { AttendancePage } from './pages/AttendancePage';
import { PayrollPage, PayslipPage } from './pages/PayrollPage';
import { AuditPage, FinancePage, IntegrationsPage } from './pages/FinancePage';
import { EmployeeCardPage, VerifyCardPage } from './pages/CardPages';
import { RUN_STATUS } from './lib/format';
import { APPS, appForPage, en, visibleMenus } from './lib/apps';
import type { AppDefinition, AppMenu } from './lib/apps';
import { CrumbProvider, useCrumbs } from './lib/breadcrumbs';
import { DayAdjustmentsPage, LoansPage } from './pages/LoansPage';
import { LeaveAccrualPage } from './pages/LeaveAccrualPage';
import { CompanyImportPage } from './pages/CompanyImportPage';
import { ContractTemplatesPage } from './pages/ContractTemplatesPage';
import { UsersPage } from './pages/UsersPage';
import { JobProfilesPage } from './pages/JobProfilesPage';
import { MySpacePage } from './pages/MySpacePage';
import { StatusTag } from './components/ui';

type Page =
  | 'home' | 'overview' | 'employees' | 'org' | 'branches' | 'access' | 'leaves' | 'attendance' | 'payroll' | 'payslip'
  | 'payroll-days' | 'loans' | 'leave-accrual' | 'company-import' | 'requests' | 'portal-accounts' | 'discipline' | 'tickets' | 'my-tickets' | 'recruitment' | 'contract-templates' | 'my' | 'my-payslip' | 'kpi'
  | 'card' | 'finance' | 'audit' | 'integrations' | 'security' | 'settings';

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
  employmentStatus: 'active' | 'inactive' | 'on_leave' | 'suspended';
  customFields?: Record<string, string | number>;
  branch?: Pick<Branch, 'id' | 'code' | 'name' | 'city'>;
  departmentId?: string | null;
  jobTitleId?: string | null;
  employmentType?: string;
}

interface ApiResult<T> {
  data: T;
}

const roleNames: Record<UserRole, string> = {
  super_admin: 'مالك النظام ومديره',
  hr_manager: 'مدير الموارد البشرية',
  hr_staff: 'موظف موارد بشرية',
  finance: 'المالية',
  branch_manager: 'مدير فرع',
  payroll_officer: 'مسؤول الرواتب',
  line_manager: 'مدير مباشر',
  employee: 'موظف',
  auditor: 'تدقيق (قراءة فقط)',
  executive: 'الإدارة العليا',
  it_admin: 'مدير النظام التقني',
  viewer: 'مشاهدة فقط',
};

const defaultRolePermissions: Record<UserRole, Permission[]> = {
  super_admin: ['branches.manage', 'employees.create', 'employees.update', 'users.manage'],
  hr_manager: ['branches.manage', 'employees.create', 'employees.update'],
  hr_staff: ['employees.create', 'employees.update'],
  finance: [],
  branch_manager: ['employees.update'],
  viewer: [],
  payroll_officer: [],
  line_manager: [],
  employee: [],
  auditor: [],
  executive: [],
  it_admin: [],
};

const statusNames = {
  active: 'على رأس العمل',
  inactive: 'غير نشط',
  on_leave: 'في إجازة',
  suspended: 'موقوف',
} as const;

function api<T>(path: string, token?: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  return request<T>(path, token, { method: options.method || 'GET', body: options.body });
}

function BrandMark({ size = 40 }: { size?: number }) {
  return <img className="brand-shield" src="/brand/shield-256.png" alt="" style={{ height: size }} />;
}

function formatDate(value: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' })
    .format(new Date(`${value}T00:00:00`));
}

function App() {
  const route = useRoute();
  if (route.page === 'verify' && route.params[0]) return <VerifyCardPage token={route.params[0]} />;
  if (route.page === 'set-password' && route.params[0]) return <SetPasswordPage token={route.params[0]} />;
  return <Workspace />;
}

function Workspace() {
  const route = useRoute();
  const page = route.page as Page;
  const setPage = (next: Page) => navigate(next);
  const [token, setToken] = useState(() => sessionStorage.getItem('erp_token') || '');
  const [user, setUser] = useState<User | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeSummary, setEmployeeSummary] = useState<EmployeeSummary>({ total: 0, active: 0, onLeave: 0, inactive: 0 });
  const [employeeTotal, setEmployeeTotal] = useState(0);
  const [employeePage, setEmployeePage] = useState(1);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [systemSettings, setSystemSettings] = useState<SystemSettings | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showEmployeeForm, setShowEmployeeForm] = useState(false);
  const [showBranchForm, setShowBranchForm] = useState(false);
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
  const can = (permission: Permission) => user?.role === 'super_admin' || rolePermissions.includes(permission);

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
    if (!token || !user || !['overview', 'employees', 'branches', 'access'].includes(page)) return;
    setBusy(true);
    setError('');
    try {
      const employeeQuery = page === 'overview'
        ? '/employees?page=1&pageSize=5&recent=1'
        : `/employees?page=${employeePage}&pageSize=25${search ? `&search=${encodeURIComponent(search)}` : ''}`;
      const [branchResult, employeeResult, summaryResult] = await Promise.all([
        api<ApiResult<Branch[]>>('/branches', token),
        api<{ data: Employee[]; pagination: { total: number } }>(employeeQuery, token),
        api<ApiResult<EmployeeSummary>>('/employees/summary', token),
      ]);
      setBranches(branchResult.data);
      setEmployees(employeeResult.data);
      setEmployeeTotal(employeeResult.pagination.total);
      setEmployeeSummary(summaryResult.data);
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes('تسجيل الدخول')) signOut();
      else notify(cause instanceof Error ? cause.message : 'تعذر تحميل بيانات النظام.', true);
    } finally {
      setBusy(false);
    }
  }, [token, user, page, search, employeePage, signOut, notify]);

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
      const created = await api<{ data: { id: string } }>('/employees', token, { method: 'POST', body });
      setShowEmployeeForm(false);
      formElement.reset();
      notify('تمت إضافة الموظف. أكمل ملفه: البيانات الشخصية والراتب والمستمسكات.');
      navigate('employees', created.data.id);
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


  const session = useMemo(
    () => (token && user && systemSettings ? buildSession(token, user, systemSettings, notify, signOut) : null),
    [token, user, systemSettings, notify, signOut],
  );

  if (loading) {
    return <main className="startup"><BrandMark size={64} /><p>جارٍ تهيئة مساحة العمل…</p></main>;
  }

  if (!token || !user) {
    return <Login onSubmit={handleLogin} busy={busy} error={error} companyName={systemSettings?.company.displayName} />;
  }

  if (!session) {
    return <main className="startup"><BrandMark size={64} /><p>جارٍ تحميل الإعدادات…</p></main>;
  }

  const go = (next: Page) => { setPage(next); };
  const branchOptions = branches.filter((branch) => branch.isActive).map((branch) => ({ id: branch.id, name: branch.name }));
  const isAdmin = user.role === 'super_admin';
  const currentApp = page === 'home' ? undefined : appForPage(page) ?? APPS[0];
  const menus = currentApp ? visibleMenus(currentApp, can, isAdmin) : [];

  return (
    <SessionProvider value={session}>
    <CrumbProvider>
    <div className="o-shell">
      <header className="o-navbar no-print">
        <button className={`o-apps-button ${page === 'home' ? 'is-home' : ''}`} onClick={() => go('home')} title="كل التطبيقات" aria-label="كل التطبيقات"><LayoutGrid size={20} /></button>
        {currentApp
          ? <button className="o-app-name" onClick={() => menus[0] && navigate(menus[0].page)}><Bi ar={currentApp.label} en={en(currentApp.label)} /></button>
          : <span className="o-app-name o-brand-name"><BrandMark size={24} /><Bi ar={SYSTEM_NAME.ar} en={SYSTEM_NAME.en} /></span>}
        {menus.length > 1 && <nav className="o-menus" aria-label="قوائم التطبيق">
          {menus.map((menu) => <button key={menu.page} className={menuActive(menu.page, page, currentApp) ? 'is-active' : ''} aria-current={menuActive(menu.page, page, currentApp) ? 'page' : undefined} onClick={() => navigate(menu.page)}><Bi ar={menu.label} en={en(menu.label)} block /></button>)}
        </nav>}
        <div className="o-navbar-end">
          <span className="o-date"><Clock3 size={14} />{new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</span>
          <details className="o-user">
            <summary><span className="avatar avatar-small">{user.name.slice(0, 1)}</span><span className="o-user-name">{user.name}</span><ChevronDown size={14} /></summary>
            <div className="o-user-menu">
              <div className="o-user-head"><strong>{user.name}</strong><span>{roleLabels[user.role]}{user.role === 'super_admin' ? ' · System Owner & Administrator' : ''}</span></div>
              <AppearanceControls />
              <button onClick={() => navigate('security')}><KeyRound size={15} />أمان الحساب</button>
              <button onClick={signOut}><LogOut size={15} />تسجيل الخروج</button>
            </div>
          </details>
        </div>
      </header>

      {page !== 'home' && currentApp && <Breadcrumbs page={page} app={currentApp} menus={menus} hasParams={route.params.length > 0} />}

      <main className={page === 'home' ? 'o-home-area' : 'page-content'}>
          {(error || success) && <div className={`notice ${error ? 'notice-error' : 'notice-success'}`} role="status">
            {error ? <CircleHelp size={17} /> : <Check size={17} />}
            <span>{error || success}</span>
            <button className="icon-button" aria-label="إغلاق التنبيه" onClick={() => { setError(''); setSuccess(''); }}><X size={16} /></button>
          </div>}

          {page === 'home' && <AppLauncher companyName={systemSettings?.company.displayName} userName={user.name} can={can} isAdmin={isAdmin} selfOnly={user.role === 'employee'} />}
          {(page === 'overview' || !KNOWN_PAGES.includes(page)) && <Dashboard
            employees={employees}
            branches={branches}
            activeEmployees={activeEmployees}
            totalEmployees={employeeSummary.total}
            canCreateEmployees={canCreateEmployees}
            onNavigate={setPage}
            onAddEmployee={() => { setPage('employees'); setShowEmployeeForm(true); }}
            onAddBranch={() => { setPage('branches'); setShowBranchForm(true); }}
          />}
          {page === 'employees' && route.params[0] && <EmployeeProfilePage key={route.params[0]} employeeId={route.params[0]} branches={branchOptions} />}
          {page === 'employees' && !route.params[0] && <EmployeesPage
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
            showShift={can('attendance.view') && user.role !== 'branch_manager'}
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
          {page === 'access' && canManageAccess && <UsersPage roleNames={roleLabels} branches={branchOptions} />}
          {page === 'my' && can('self.service') && <MySpacePage />}
          {page === 'my-payslip' && route.params[0] && can('self.service') && <PayslipPage own runId={route.params[0]} />}
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
          {page === 'org' && <OrgPage branches={branchOptions} />}
          {page === 'kpi' && <JobProfilesPage key={route.params[0] ?? 'list'} jobTitleId={route.params[0]} />}
          {page === 'attendance' && can('attendance.view') && <AttendancePage branches={branchOptions} />}
          {page === 'payroll' && can('payroll.view') && <PayrollPage key={route.params[0] ?? 'list'} runId={route.params[0]} branches={branchOptions} />}
          {page === 'payroll-days' && can('payroll.view') && <DayAdjustmentsPage />}
          {page === 'loans' && can('payroll.view') && <LoansPage />}
          {page === 'leave-accrual' && can('leaves.manage_balances') && <LeaveAccrualPage />}
          {page === 'company-import' && canManageSettings && <CompanyImportPage />}
          {page === 'requests' && (can('requests.manage') || can('payroll.disburse')) && <RequestsPage />}
          {page === 'portal-accounts' && canManageAccess && <PortalAccountsPage />}
          {page === 'discipline' && can('discipline.view') && <DisciplinePage />}
          {page === 'tickets' && can('tickets.manage') && <TicketsPage />}
          {page === 'my-tickets' && <TicketsPage mine />}
          {page === 'recruitment' && can('recruitment.view') && <RecruitmentPage key={route.params[0] ?? 'list'} positionId={route.params[0]} />}
          {page === 'contract-templates' && can('employees.manage_profile') && <ContractTemplatesPage />}
          {page === 'payslip' && route.params[1] && <PayslipPage runId={route.params[0]} employeeId={route.params[1]} />}
          {page === 'card' && route.params[0] && <EmployeeCardPage employeeId={route.params[0]} />}
          {page === 'finance' && can('finance.view') && <FinancePage key={route.params.join('/')} params={route.params} />}
          {page === 'audit' && can('audit.view') && <AuditPage />}
          {page === 'integrations' && can('integrations.manage') && <IntegrationsPage />}
          {page === 'security' && <SecurityPage onSubmit={handlePasswordChange} />}
          {page === 'settings' && canManageSettings && systemSettings && <SettingsPage value={systemSettings} busy={savingSettings} onSave={handleSettingsSave} />}

          <footer className="page-footer no-print"><span><Bi ar={SYSTEM_NAME.ar} en={SYSTEM_NAME.en} block /></span><DeveloperCredit /></footer>
      </main>
    </div>
    </CrumbProvider>
    </SessionProvider>
  );
}

const KNOWN_PAGES: string[] = [
  'home', 'overview', 'employees', 'org', 'branches', 'access', 'leaves', 'attendance', 'payroll', 'payroll-days', 'loans', 'leave-accrual', 'company-import', 'requests', 'portal-accounts', 'discipline', 'tickets', 'my-tickets', 'recruitment',
  'contract-templates', 'my', 'my-payslip', 'kpi', 'payslip', 'card', 'finance', 'audit', 'integrations', 'security', 'settings',
];

function menuActive(menuPage: string, page: string, app?: AppDefinition): boolean {
  if (menuPage === page) return true;
  // Pages reached from a menu (a payslip, an employee card) keep that menu lit.
  return Boolean(app?.extraPages?.includes(page)) && app?.menus[0]?.page === menuPage;
}

function Breadcrumbs({ page, app, menus, hasParams }: { page: string; app: AppDefinition; menus: AppMenu[]; hasParams: boolean }) {
  const extra = useCrumbs();
  const menu = menus.find((item) => item.page === page) ?? (app.extraPages?.includes(page) ? menus[0] : undefined);
  const base = menu ? { label: menu.label, href: `#/${menu.page}` } : { label: app.label };
  const trail = [base, ...extra];
  const linkBase = extra.length > 0 || (hasParams && !app.extraPages?.includes(page));
  return (
    <div className="o-control no-print">
      <nav aria-label="مسار التنقل"><ol className="o-crumbs">
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1 && !(index === 0 && linkBase);
          return <li key={`${crumb.label}-${index}`}>
            {!last && crumb.href ? <a href={crumb.href}><Bi ar={crumb.label} en={en(crumb.label)} /></a> : <span aria-current={last ? 'page' : undefined}><Bi ar={crumb.label} en={en(crumb.label)} /></span>}
          </li>;
        })}
      </ol></nav>
    </div>
  );
}

function AppLauncher({ companyName, userName, can, isAdmin, selfOnly }: {
  companyName?: string; userName: string; can: (permission: Permission) => boolean; isAdmin: boolean; selfOnly: boolean;
}) {
  const [query, setQuery] = useState('');
  const apps = APPS.filter((app) => !(selfOnly && app.staffOnly))
    .filter((app) => app.href || visibleMenus(app, can, isAdmin).length > 0)
    .filter((app) => !query.trim() || `${app.label} ${app.description} ${en(app.label)}`.toLowerCase().includes(query.trim().toLowerCase()));
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Baghdad', hour: 'numeric', hour12: false }).format(new Date()));
  const open = (app: AppDefinition) => {
    if (app.href) window.open(app.href, '_blank', 'noopener');
    else navigate(visibleMenus(app, can, isAdmin)[0].page);
  };
  return (
    <section className="o-home">
      <div className="o-home-head">
        <img className="o-home-mark" src="/brand/shield-256.png" alt="" />
        <div><h2>{hour < 12 ? 'صباح الخير' : 'مساء الخير'}، {userName.split(' ')[0]} <span className="o-home-en" dir="ltr">{hour < 12 ? 'Good morning' : 'Good evening'}</span></h2>
          <p className="o-system-name"><Bi ar={SYSTEM_NAME.ar} en={SYSTEM_NAME.en} block /></p></div>
      </div>
      <BrandStrip />
      <label className="o-home-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث عن تطبيق… · Search apps" aria-label="بحث في التطبيقات" /></label>
      <div className="o-app-grid">
        {apps.map((app) => {
          const Icon = app.icon;
          return <button key={app.id} className="o-app-tile" onClick={() => open(app)} onKeyDown={(event) => { if (event.key === 'Enter') open(app); }}>
            <span className="o-app-icon" style={{ background: `linear-gradient(145deg, ${app.colors[0]}, ${app.colors[1]})` }}><Icon size={38} strokeWidth={1.6} /></span>
            <strong><Bi ar={app.label} en={en(app.label)} block /></strong>
            <small>{app.href ? 'يفتح في نافذة جديدة · Opens in a new tab' : app.description}</small>
          </button>;
        })}
        {!apps.length && <p className="o-home-empty">لا يوجد تطبيق بهذا الاسم.</p>}
      </div>
    </section>
  );
}

/** Choosing a password from a one-time link printed on the server console. */
function SetPasswordPage({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [doneEmail, setDoneEmail] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') || '');
    if (password !== String(form.get('confirm') || '')) { setError('كلمتا المرور غير متطابقتين.'); return; }
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/set-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'تعذر تعيين كلمة المرور.');
      setDoneEmail(result.email);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'تعذر تعيين كلمة المرور.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-layout">
      <section className="login-story">
        <div className="login-brand"><BrandMark size={58} /><img className="login-wordmark" src="/brand/wordmark-white.png" alt="شركة الليث العبيدي" /></div>
        <div className="login-message"><span className="gold-rule" /><h1>كلمة مرورك<br />بيدك وحدك.</h1><p>اختر كلمة مرور تتذكرها. لا تُرسل لأحد ولا يراها أحد غيرك.</p></div>
        <div className="login-bottom"><BrandStrip tone="light" /><DeveloperCredit /></div>
      </section>
      <section className="login-panel">
        {doneEmail ? <div className="login-form">
          <span className="form-symbol"><ShieldCheck size={22} /></span>
          <h2>تمت العملية</h2>
          <p>عُيّنت كلمة المرور للحساب <span dir="ltr">{doneEmail}</span>. سجّل الدخول بها الآن.</p>
          <a className="button button-primary login-submit" href="#/">تسجيل الدخول<ArrowLeft size={17} /></a>
        </div> : <form className="login-form" onSubmit={(event) => void submit(event)}>
          <span className="form-symbol"><ShieldCheck size={22} /></span>
          <h2>تعيين كلمة المرور</h2>
          <p>12 حرفاً على الأقل. الرابط يعمل مرة واحدة خلال 30 دقيقة.</p>
          {error && <div className="notice notice-error" role="alert"><CircleHelp size={17} /><span>{error}</span></div>}
          <label className="field"><span>كلمة المرور الجديدة</span><input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={72} dir="ltr" /></label>
          <label className="field"><span>أعد كتابتها</span><input name="confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={72} dir="ltr" /></label>
          <button className="button button-primary login-submit" disabled={busy}>{busy ? 'جارٍ الحفظ…' : 'حفظ كلمة المرور'}<ArrowLeft size={17} /></button>
        </form>}
      </section>
    </main>
  );
}

function Login({ onSubmit, busy, error, companyName }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean; error: string; companyName?: string }) {
  return (
    <main className="login-layout">
      <section className="login-story">
        <div className="login-brand"><BrandMark size={58} /><img className="login-wordmark" src="/brand/wordmark-white.png" alt={companyName || 'شركة الليث العبيدي'} /></div>
        <div className="login-message"><span className="gold-rule" /><h1>{SYSTEM_NAME.ar}</h1><p className="login-en" dir="ltr">{SYSTEM_NAME.en}</p><p>الموظفون والحضور والرواتب والتوظيف والمالية في منصة واحدة، مرتبطة بـ SAP Business One.</p></div>
        <div className="login-bottom"><BrandStrip tone="light" /><DeveloperCredit /></div>
      </section>
      <section className="login-panel">
        <form className="login-form" onSubmit={onSubmit}>
          <span className="form-symbol"><ShieldCheck size={22} /></span>
          <h2>تسجيل الدخول</h2>
          <p>أدخل بيانات حسابك للوصول إلى مساحة العمل.</p>
          {error && <div className="notice notice-error" role="alert"><CircleHelp size={17} /><span>{error}</span></div>}
          <label className="field"><span>البريد الإلكتروني أو الرقم الوظيفي · E-mail or employee ID</span><input name="email" type="text" autoComplete="username" required placeholder="name@company.com · 10123" dir="ltr" /></label>
          <label className="field"><span>كلمة المرور</span><input name="password" type="password" autoComplete="current-password" required minLength={12} dir="ltr" /></label>
          <button className="button button-primary login-submit" disabled={busy}>{busy ? 'جارٍ التحقق…' : 'دخول آمن'}<ArrowLeft size={17} /></button>
          <div className="login-security"><ShieldCheck size={15} /><span>الجلسة محمية وتنتهي تلقائياً بعد 8 ساعات.</span></div>
        </form>
      </section>
    </main>
  );
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
  const session = useSession();
  const today = useLoad<{ totals: { tracked: number; inside: number; late: number; onLeave: number; notArrived: number } } | null>(
    session.can('attendance.view') ? '/attendance/today' : null, null,
  );
  const alerts = useLoad<{ documents: Array<{ id: string; employeeId: string; employeeName: string; docType: string; title: string; expiryDate: string; daysLeft: number }>; contracts: Array<{ id: string; employeeId: string; employeeName: string; kind: string; dueDate: string }> } | null>(
    session.can('employees.view_profile') ? '/hr/alerts?days=45' : null, null,
  );
  const runs = useLoad<Array<{ id: string; period: string; status: string; currency: string; branchName: string | null; totalNet: number; employeeCount: number }>>(
    session.can('payroll.view') ? '/payroll/runs' : null, [],
  );
  const recent = [...employees].sort((a, b) => b.hireDate.localeCompare(a.hireDate)).slice(0, 5);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Baghdad', hour: 'numeric', hour12: false }).format(new Date()));
  const alertCount = (alerts.data?.documents.length ?? 0) + (alerts.data?.contracts.length ?? 0);
  return (
    <section className="screen">
      <div className="screen-heading">
        <div><h2>{hour < 12 ? 'صباح الخير' : 'مساء الخير'}، {session.user.name.split(' ')[0]}</h2><p>ملخص اليوم للموظفين والحضور والرواتب.</p></div>
        <div className="heading-actions"><button className="button button-quiet" onClick={() => onNavigate('employees')}><Users size={16} />دليل الموظفين</button>{canCreateEmployees && <button className="button button-primary" onClick={onAddEmployee}><Plus size={17} />موظف جديد</button>}</div>
      </div>
      <div className="kpi-row">
        <button className="kpi" onClick={() => onNavigate('employees')}><span className="kpi-label"><Users size={16} />الموظفون على رأس العمل</span><strong>{activeEmployees.toLocaleString('ar-IQ-u-nu-latn')}</strong><span className="kpi-foot">من {totalEmployees.toLocaleString('ar-IQ-u-nu-latn')} سجل</span></button>
        {today.data ? <button className="kpi" onClick={() => onNavigate('attendance')}><span className="kpi-label"><Fingerprint size={16} />داخل الدوام الآن</span><strong>{today.data.totals.inside.toLocaleString('ar-IQ-u-nu-latn')}</strong><span className="kpi-foot">{today.data.totals.late.toLocaleString('ar-IQ-u-nu-latn')} متأخر · {today.data.totals.notArrived.toLocaleString('ar-IQ-u-nu-latn')} لم يبصم</span></button>
          : <button className="kpi" onClick={() => onNavigate('branches')}><span className="kpi-label"><Building2 size={16} />الفروع النشطة</span><strong>{branches.filter((branch) => branch.isActive).length.toLocaleString('ar-IQ-u-nu-latn')}</strong><span className="kpi-foot">من {branches.length.toLocaleString('ar-IQ-u-nu-latn')} موقع</span></button>}
        {today.data && <div className="kpi kpi-static"><span className="kpi-label"><CalendarDays size={16} />في إجازة اليوم</span><strong>{today.data.totals.onLeave.toLocaleString('ar-IQ-u-nu-latn')}</strong><span className="kpi-foot">من {today.data.totals.tracked.toLocaleString('ar-IQ-u-nu-latn')} خاضع للبصمة</span></div>}
        {alerts.data && <div className={`kpi kpi-static ${alertCount ? 'kpi-alert' : ''}`}><span className="kpi-label"><AlertTriangle size={16} />تنبيهات الملفات</span><strong>{alertCount.toLocaleString('ar-IQ-u-nu-latn')}</strong><span className="kpi-foot">مستمسكات وعقود تنتهي خلال 45 يوماً</span></div>}
      </div>
      <div className="dashboard-grid">
        <section className="panel roster-panel">
          {alerts.data && alertCount > 0 ? <>
            <div className="panel-head"><div><h3>يحتاج انتباهك</h3><p>مستمسكات وعقود وفترات تجربة تنتهي قريباً</p></div></div>
            <div className="table-scroll"><table><tbody>
              {alerts.data.contracts.map((item) => <tr key={`c-${item.id}`}><td><button className="text-button" onClick={() => navigate('employees', item.employeeId)}>{item.employeeName}</button></td><td>{item.kind === 'probation' ? 'نهاية فترة التجربة' : 'انتهاء العقد'}</td><td>{item.dueDate}</td></tr>)}
              {alerts.data.documents.map((item) => <tr key={`d-${item.id}`}><td><button className="text-button" onClick={() => navigate('employees', item.employeeId)}>{item.employeeName}</button></td><td>{DOCUMENT_TYPES[item.docType] ?? item.title}</td><td className={item.daysLeft < 0 ? 'num-bad' : 'num-warn'}>{item.daysLeft < 0 ? `منتهي منذ ${-item.daysLeft} يوم` : `${item.expiryDate} (${item.daysLeft} يوم)`}</td></tr>)}
            </tbody></table></div>
          </> : <>
            <div className="panel-head"><div><h3>أحدث المنضمين</h3><p>آخر الموظفين بحسب تاريخ التعيين</p></div><button className="text-button" onClick={() => onNavigate('employees')}>عرض الدليل<ArrowLeft size={15} /></button></div>
            {recent.length ? <div className="table-scroll"><table><thead><tr><th>الموظف</th><th>القسم والمنصب</th><th>الفرع</th><th>تاريخ التعيين</th></tr></thead><tbody>
              {recent.map((employee) => <tr key={employee.id} className="row-link" onClick={() => navigate('employees', employee.id)}><td><span className="person-cell"><span className="person-mark">{employee.fullName.slice(0, 1)}</span><span><strong>{employee.fullName}</strong><small>{employee.employeeNo}</small></span></span></td><td><strong>{employee.department}</strong><small className="table-sub">{employee.position}</small></td><td>{employee.branch?.name || branches.find((branch) => branch.id === employee.branchId)?.name || '—'}</td><td>{formatDate(employee.hireDate)}</td></tr>)}
            </tbody></table></div> : <EmptyState icon={<Users size={22} />} title="لا توجد سجلات موظفين بعد" description="أضف الفروع والموظفين للبدء بإدارة موارد المجموعة." action="إضافة أول موظف" onClick={onAddEmployee} />}
          </>}
        </section>
        {session.can('payroll.view') ? <section className="panel branch-panel">
          <div className="panel-head"><div><h3>آخر مسيرات الرواتب</h3><p>حالة الاعتماد والترحيل</p></div><button className="icon-link" aria-label="الرواتب" onClick={() => onNavigate('payroll')}><ArrowLeft size={17} /></button></div>
          {runs.data.length ? <div className="branch-list">{runs.data.slice(0, 5).map((run) => <button className="branch-row" key={run.id} onClick={() => navigate('payroll', run.id)}><span className="branch-symbol"><Wallet size={17} /></span><span className="branch-row-copy"><strong>{monthLabel(run.period)} · {run.branchName ?? 'كل الفروع'}</strong><small><StatusTag map={RUN_STATUS} value={run.status} /></small></span><span className="branch-row-count">{formatMoney(run.totalNet, run.currency)}<small>{run.employeeCount} موظف</small></span></button>)}</div>
            : <EmptyState icon={<Wallet size={22} />} title="لا توجد مسيرات" description="أنشئ مسير الشهر من صفحة الرواتب." />}
        </section> : <section className="panel branch-panel">
          <div className="panel-head"><div><h3>الفروع والمواقع</h3><p>ملخص مواقع المجموعة</p></div><button className="icon-link" aria-label="إدارة الفروع" onClick={() => onNavigate('branches')}><ArrowLeft size={17} /></button></div>
          {branches.length ? <div className="branch-list">{branches.slice(0, 5).map((branch) => <button className="branch-row" key={branch.id} onClick={() => onNavigate('branches')}><span className="branch-symbol"><Building2 size={17} /></span><span className="branch-row-copy"><strong>{branch.name}</strong><small>{branch.city} · {branch.code}</small></span><span className="branch-row-count">{(branch.employeeCount || 0).toLocaleString('ar-IQ-u-nu-latn')}<small>موظف</small></span></button>)}</div> : <EmptyState icon={<Building2 size={22} />} title="أضف مواقع المجموعة" description="سجّل الفروع أولاً لربط الموظفين بمواقعهم." action="إضافة فرع" onClick={onAddBranch} />}
        </section>}
      </div>
    </section>
  );
}

function EmployeesPage({ employees, branches, search, busy, total, page, pageCount, canManage, canUpdate, customFields, showShift, onSearch, onPage, onCreate, onSubmit, onToggle, showForm }: {
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
  showShift: boolean;
  onSearch: (value: string) => void;
  onPage: (page: number) => void;
  onCreate: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggle: (employee: Employee) => void;
  showForm: boolean;
}) {
  const departments = useLoad<Department[]>(showForm ? '/org/departments' : null, []);
  const titles = useLoad<JobTitle[]>(showForm ? '/org/job-titles' : null, []);
  const shifts = useLoad<Array<{ id: string; name: string; isDefault: boolean; isActive: boolean }>>(showForm && showShift ? '/attendance/shifts' : null, []);
  const activeDepartments = departments.data.filter((item) => item.isActive);
  const activeTitles = titles.data.filter((item) => item.isActive);
  const defaultShift = shifts.data.find((item) => item.isDefault && item.isActive)?.id ?? '';
  const [view, setView] = useViewMode('employees');
  const branchName = (employee: Employee) => employee.branch?.name || branches.find((branch) => branch.id === employee.branchId)?.name || '—';
  const byDepartment = employees.reduce<Record<string, Employee[]>>((groups, employee) => {
    (groups[employee.department || '—'] ||= []).push(employee);
    return groups;
  }, {});
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="دليل الموظفين" en="Employee Directory" /></h2><p>اضغط على أي موظف لفتح ملفه الكامل. · Click an employee to open the full file.</p></div>{canManage && <button className="button button-primary" onClick={onCreate}><Plus size={17} />إضافة موظف</button>}</div>
      {showForm && canManage && <form className="panel form-panel" onSubmit={onSubmit} key={`${departments.data.length}-${shifts.data.length}`}>
        <div className="panel-head"><div><h3>موظف جديد</h3><p>البيانات الأساسية. الراتب والمستمسكات تُضاف من ملف الموظف بعد الحفظ.</p></div><button type="button" className="icon-button" aria-label="إغلاق النموذج" onClick={onCreate}><X size={18} /></button></div>
        <div className="form-grid">
          <label className="field"><span>رقم الموظف *</span><input name="employeeNo" required maxLength={40} dir="ltr" /></label>
          <label className="field"><span>الاسم الكامل *</span><input name="fullName" required maxLength={180} /></label>
          <label className="field"><span>الفرع *</span><select name="branchId" required defaultValue=""><option value="" disabled>اختر الفرع</option>{branches.filter((branch) => branch.isActive).map((branch) => <option key={branch.id} value={branch.id}>{branch.name} · {branch.city}</option>)}</select></label>
          {activeDepartments.length
            ? <label className="field"><span>القسم *</span><select name="departmentId" required defaultValue=""><option value="" disabled>اختر القسم</option>{activeDepartments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            : <label className="field"><span>القسم *</span><input name="department" required maxLength={120} /><small>عرّف الأقسام من الهيكل التنظيمي لتظهر كقائمة.</small></label>}
          {activeTitles.length
            ? <label className="field"><span>المسمى الوظيفي *</span><select name="jobTitleId" required defaultValue=""><option value="" disabled>اختر المسمى</option>{activeTitles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            : <label className="field"><span>المسمى الوظيفي *</span><input name="position" required maxLength={120} /></label>}
          <label className="field"><span>تاريخ التعيين *</span><input name="hireDate" type="date" required /></label>
          <label className="field"><span>نوع التوظيف</span><select name="employmentType" defaultValue="probation">{Object.entries(EMPLOYMENT_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {showShift && <label className="field"><span>الدوام (البصمة)</span><select name="shiftId" defaultValue={defaultShift}><option value="">غير خاضع للبصمة</option>{shifts.data.filter((item) => item.isActive).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          {showShift && <label className="field"><span>رقم البصمة</span><input name="attendancePin" maxLength={40} dir="ltr" pattern="[A-Za-z0-9_\-]*" /><small>إن تُرك فارغاً يُطابق برقم الموظف.</small></label>}
          <label className="field"><span>البريد الإلكتروني</span><input name="email" type="email" maxLength={254} dir="ltr" /></label>
          <label className="field"><span>رقم الهاتف</span><input name="phone" maxLength={40} dir="ltr" /></label>
          {customFields.map((field) => <label className="field" key={field.id}><span>{field.label}{field.required ? ' *' : ''}</span>
            {field.type === 'select'
              ? <select name={`customFields.${field.key}`} required={field.required} defaultValue=""><option value="">اختر</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select>
              : <input name={`customFields.${field.key}`} type={field.type} required={field.required} maxLength={field.type === 'text' ? 500 : undefined} />}
          </label>)}
        </div>
        <div className="form-actions"><button className="button button-primary" type="submit"><Check size={16} />حفظ الموظف</button><button className="button button-quiet" type="button" onClick={onCreate}>إلغاء</button></div>
      </form>}
      <section className="panel directory-panel">
        <div className="filter-bar"><label className="search-field"><Search size={17} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="ابحث بالاسم أو الرقم أو القسم…" aria-label="بحث في الموظفين" /></label><span className="result-count">{total.toLocaleString('ar-IQ-u-nu-latn')} سجل · records</span><ViewSwitch value={view} onChange={setView} /></div>
        {employees.length ? <>{view === 'kanban' ? <div className="kanban-board">
          {Object.entries(byDepartment).map(([department, people]) => <div className="kanban-column" key={department}>
            <div className="kanban-column-head">{department}<span>{people.length}</span></div>
            {people.map((employee) => <button key={employee.id} className="kanban-card" onClick={() => navigate('employees', employee.id)}>
              <strong>{employee.fullName}</strong><small>{employee.position}</small>
              <small>{employee.employeeNo} · {branchName(employee)}</small>
              <span className={`state-pill state-${employee.employmentStatus}`}><i />{statusNames[employee.employmentStatus]}</span>
            </button>)}
          </div>)}
        </div> : view === 'grid' ? <div className="card-grid">
          {employees.map((employee) => <button key={employee.id} className="person-card" onClick={() => navigate('employees', employee.id)}>
            <span className="person-mark">{employee.fullName.slice(0, 1)}</span>
            <span><strong>{employee.fullName}</strong><small>{employee.position}</small><small>{employee.department} · {branchName(employee)}</small><small dir="ltr">{employee.employeeNo}</small></span>
          </button>)}
        </div> : <div className="table-scroll"><table className="directory-table"><thead><tr><th>الموظف</th><th>القسم والمنصب</th><th>الفرع</th><th>تاريخ التعيين</th><th>الحالة</th>{customFields.map((field) => <th key={field.id}>{field.label}</th>)}{canUpdate && <th>إجراء</th>}</tr></thead><tbody>
          {employees.map((employee) => <tr key={employee.id} className="row-link" onClick={() => navigate('employees', employee.id)}><td><span className="person-cell"><span className="person-mark">{employee.fullName.slice(0, 1)}</span><span><strong>{employee.fullName}</strong><small>{employee.employeeNo}{employee.email ? ` · ${employee.email}` : ''}</small></span></span></td><td><strong>{employee.department}</strong><small className="table-sub">{employee.position}</small></td><td>{employee.branch?.name || branches.find((branch) => branch.id === employee.branchId)?.name || '—'}</td><td>{formatDate(employee.hireDate)}</td><td><span className={`state-pill state-${employee.employmentStatus}`}><i />{statusNames[employee.employmentStatus]}</span></td>{customFields.map((field) => <td key={field.id}>{employee.customFields?.[field.key] ?? '—'}</td>)}{canUpdate && <td><button className="table-action" onClick={(event) => { event.stopPropagation(); onToggle(employee); }}>{employee.employmentStatus === 'active' ? 'تعطيل' : 'تفعيل'}</button></td>}</tr>)}
        </tbody></table></div>}<div className="pagination"><span>عرض {Math.min((page - 1) * 25 + 1, total).toLocaleString('ar-IQ-u-nu-latn')}–{Math.min(page * 25, total).toLocaleString('ar-IQ-u-nu-latn')} من {total.toLocaleString('ar-IQ-u-nu-latn')}</span><div><button className="button button-quiet" disabled={page <= 1 || busy} onClick={() => onPage(page - 1)}>السابق</button><span>{page.toLocaleString('ar-IQ-u-nu-latn')} / {pageCount.toLocaleString('ar-IQ-u-nu-latn')}</span><button className="button button-quiet" disabled={page >= pageCount || busy} onClick={() => onPage(page + 1)}>التالي</button></div></div></> : <EmptyState icon={<Users size={22} />} title={search ? 'لا توجد نتائج مطابقة' : 'دليل الموظفين فارغ'} description={search ? 'جرّب البحث برقم الموظف أو القسم.' : 'ابدأ بإضافة أول سجل موظف واربطه بفرعه.'} action={!search && canManage ? 'إضافة موظف' : undefined} onClick={onCreate} />}
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
        {branches.map((branch) => <tr key={branch.id}><td><span className="branch-cell"><span className="branch-symbol"><Building2 size={17} /></span><span><strong>{branch.name}</strong><small>{branch.address || 'لا يوجد عنوان مسجل'}</small></span></span></td><td>{branch.city}</td><td><span className="code-tag">{branch.code}</span></td><td>{(branch.employeeCount || 0).toLocaleString('ar-IQ-u-nu-latn')}</td><td><span className={`state-pill ${branch.isActive ? 'state-active' : 'state-inactive'}`}><i />{branch.isActive ? 'نشط' : 'غير نشط'}</span></td></tr>)}
      </tbody></table></div></div> : <div className="panel"><EmptyState icon={<Building2 size={22} />} title="لا توجد فروع مسجلة" description="أضف أول موقع عمل لتنظيم السجلات حسب الفرع." action={canManage ? 'إضافة فرع' : undefined} onClick={onCreate} /></div>}
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
      <MySignature />
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
