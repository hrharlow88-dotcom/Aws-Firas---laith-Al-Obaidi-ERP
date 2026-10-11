import { useEffect, useState } from 'react';
import { Check, Plus, Save, ShieldCheck, Trash2 } from 'lucide-react';

export type UserRole = 'super_admin' | 'hr_manager' | 'hr_staff' | 'finance' | 'branch_manager' | 'viewer';
export type Permission =
  | 'branches.manage'
  | 'employees.create'
  | 'employees.update'
  | 'users.manage'
  | 'leaves.view'
  | 'leaves.request'
  | 'leaves.approve'
  | 'leaves.manage_balances';

export type PayrollComponentCategory = 'earning' | 'deduction';
export type PayrollCalculation = 'manual' | 'percentage_of_gross' | 'percentage_of_basic' | 'per_day';

export interface PayrollComponentSetting {
  id: string;
  name: string;
  category: PayrollComponentCategory;
  calculation: PayrollCalculation;
  rate: number;
  active: boolean;
  statutory: boolean;
  legalApproved: boolean;
}

export interface SystemSettings {
  company: {
    displayName: string;
    legalName: string;
    phone: string;
    email: string;
    address: string;
    currency: string;
    timeZone: string;
  };
  leaveTypes: Array<{
    id: string;
    name: string;
    unit: 'days' | 'hours';
    paid: boolean;
    active: boolean;
    annualEntitlement: number | null;
    carryForwardLimit: number | null;
    serviceEntitlements?: Array<{ minimumYears: number; days: number }>;
    dayCountBasis?: 'working' | 'calendar';
    requiresMedicalCertificate?: boolean;
    deductsBalance?: boolean;
  }>;
  approvalSteps: Array<{ id: string; role: UserRole }>;
  roles: Record<UserRole, { label: string; permissions: Permission[] }>;
  employeeFields: Array<{
    id: string;
    key: string;
    label: string;
    type: 'text' | 'number' | 'date' | 'select';
    required: boolean;
    enabled: boolean;
    options: string[];
  }>;
  payrollRules: {
    baseCurrency: string;
    monthlyDivisor: number;
    roundingDigits: number;
    components: PayrollComponentSetting[];
  };
  leaveRules: {
    workingDays: number[];
    officialHolidays: string[];
    maxHoursPerRequest: number;
    hourlyMonthlyQuota: number;
    hourlyMonthlyUsageLimit: number;
    lowBalanceThreshold: number;
  };
}

const roles: Array<{ id: UserRole; label: string }> = [
  { id: 'super_admin', label: 'مدير النظام' },
  { id: 'hr_manager', label: 'مدير الموارد البشرية' },
  { id: 'hr_staff', label: 'موظف موارد بشرية' },
  { id: 'finance', label: 'المالية' },
  { id: 'branch_manager', label: 'مدير فرع' },
  { id: 'viewer', label: 'مشاهدة فقط' },
];

const POLICY_LEAVE_TYPES: SystemSettings['leaveTypes'] = [
  {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'الإجازة الاعتيادية',
    unit: 'days',
    paid: true,
    active: true,
    annualEntitlement: 21,
    carryForwardLimit: null,
    serviceEntitlements: [
      { minimumYears: 6, days: 23 },
      { minimumYears: 11, days: 25 },
      { minimumYears: 16, days: 28 },
    ],
    dayCountBasis: 'working',
  },
  {
    id: '10000000-0000-4000-8000-000000000002',
    name: 'الإجازة المرضية',
    unit: 'days',
    paid: true,
    active: true,
    annualEntitlement: 30,
    carryForwardLimit: null,
    requiresMedicalCertificate: true,
    dayCountBasis: 'working',
  },
  {
    id: '10000000-0000-4000-8000-000000000003',
    name: 'إجازة الولادة (الحد القانوني)',
    unit: 'days',
    paid: true,
    active: true,
    annualEntitlement: null,
    carryForwardLimit: null,
    dayCountBasis: 'calendar',
    deductsBalance: false,
  },
  {
    id: '10000000-0000-4000-8000-000000000004',
    name: 'الإجازة الزمنية',
    unit: 'hours',
    paid: true,
    active: true,
    annualEntitlement: null,
    carryForwardLimit: null,
    deductsBalance: false,
  },
];

const permissions: Array<{ id: Permission; label: string }> = [
  { id: 'branches.manage', label: 'إضافة الفروع وتعديلها' },
  { id: 'employees.create', label: 'إضافة الموظفين' },
  { id: 'employees.update', label: 'تعديل الموظفين' },
  { id: 'users.manage', label: 'إدارة حسابات المستخدمين' },
  { id: 'leaves.view', label: 'عرض الإجازات والأرصدة' },
  { id: 'leaves.request', label: 'إنشاء وإلغاء طلب الإجازة' },
  { id: 'leaves.approve', label: 'اعتماد ورفض الإجازات' },
  { id: 'leaves.manage_balances', label: 'إدارة أرصدة الإجازات' },
];

type SettingsTab = 'company' | 'leave' | 'payroll' | 'approvals' | 'roles' | 'fields';

function createId(): string {
  return crypto.randomUUID();
}

export function SettingsPage({ value, busy, onSave }: {
  value: SystemSettings;
  busy: boolean;
  onSave: (settings: SystemSettings) => Promise<void>;
}) {
  const [settings, setSettings] = useState(value);
  const [tab, setTab] = useState<SettingsTab>('company');

  useEffect(() => setSettings(value), [value]);

  function updateCompany(field: keyof SystemSettings['company'], nextValue: string) {
    setSettings((current) => ({ ...current, company: { ...current.company, [field]: nextValue } }));
  }

  function updateLeaveRules(patch: Partial<SystemSettings['leaveRules']>) {
    setSettings((current) => ({ ...current, leaveRules: { ...current.leaveRules, ...patch } }));
  }

  function updatePayrollRules(patch: Partial<SystemSettings['payrollRules']>) {
    setSettings((current) => ({ ...current, payrollRules: { ...current.payrollRules, ...patch } }));
  }

  function updatePayrollComponent(id: string, patch: Partial<PayrollComponentSetting>) {
    setSettings((current) => ({
      ...current,
      payrollRules: {
        ...current.payrollRules,
        components: current.payrollRules.components.map((item) => item.id === id ? { ...item, ...patch } : item),
      },
    }));
  }

  function addPayrollComponent() {
    setSettings((current) => ({
      ...current,
      payrollRules: {
        ...current.payrollRules,
        components: [...current.payrollRules.components, {
          id: createId(),
          name: '',
          category: 'earning',
          calculation: 'manual',
          rate: 0,
          active: true,
          statutory: false,
          legalApproved: false,
        }],
      },
    }));
  }

  function applyPolicyDefaults() {
    setSettings((current) => ({
      ...current,
      leaveTypes: [
        ...current.leaveTypes.filter((type) => !POLICY_LEAVE_TYPES.some((preset) => preset.id === type.id)),
        ...POLICY_LEAVE_TYPES.map((type) => ({ ...type })),
      ],
      leaveRules: {
        ...current.leaveRules,
        workingDays: [0, 1, 2, 3, 4, 6],
        maxHoursPerRequest: 3,
        hourlyMonthlyQuota: 6,
        hourlyMonthlyUsageLimit: 2,
      },
      approvalSteps: current.approvalSteps.length ? current.approvalSteps : [
        { id: '20000000-0000-4000-8000-000000000001', role: 'branch_manager' },
        { id: '20000000-0000-4000-8000-000000000002', role: 'hr_manager' },
      ],
    }));
  }

  function addLeaveType() {
    setSettings((current) => ({
      ...current,
      leaveTypes: [...current.leaveTypes, {
        id: createId(), name: '', unit: 'days', paid: true, active: true, annualEntitlement: null, carryForwardLimit: null,
      }],
    }));
  }

  function updateLeaveType(id: string, patch: Partial<SystemSettings['leaveTypes'][number]>) {
    setSettings((current) => ({
      ...current,
      leaveTypes: current.leaveTypes.map((item) => item.id === id ? { ...item, ...patch } : item),
    }));
  }

  function addApprovalStep() {
    setSettings((current) => ({
      ...current,
      approvalSteps: [...current.approvalSteps, { id: createId(), role: 'hr_manager' }],
    }));
  }

  function moveApprovalStep(index: number, direction: -1 | 1) {
    setSettings((current) => {
      const next = [...current.approvalSteps];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...current, approvalSteps: next };
    });
  }

  function addEmployeeField() {
    setSettings((current) => ({
      ...current,
      employeeFields: [...current.employeeFields, {
        id: createId(), key: '', label: '', type: 'text', required: false, enabled: true, options: [],
      }],
    }));
  }

  function updateEmployeeField(id: string, patch: Partial<SystemSettings['employeeFields'][number]>) {
    setSettings((current) => ({
      ...current,
      employeeFields: current.employeeFields.map((field) => field.id === id ? { ...field, ...patch } : field),
    }));
  }

  function togglePermission(role: UserRole, permission: Permission, enabled: boolean) {
    if (role === 'super_admin') return;
    setSettings((current) => {
      const currentPermissions = current.roles[role].permissions;
      const nextPermissions = enabled
        ? [...new Set([...currentPermissions, permission, ...(permission.startsWith('leaves.') && permission !== 'leaves.view' ? ['leaves.view' as Permission] : [])])]
        : currentPermissions.filter((item) =>
          permission === 'leaves.view' && ['leaves.view', 'leaves.request', 'leaves.approve', 'leaves.manage_balances'].includes(item)
            ? false
            : item !== permission,
        );
      return {
        ...current,
        roles: { ...current.roles, [role]: { ...current.roles[role], permissions: nextPermissions } },
      };
    });
  }

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: 'company', label: 'بيانات الشركة' },
    { id: 'leave', label: 'أنواع الإجازات' },
    { id: 'payroll', label: 'إعدادات الرواتب' },
    { id: 'approvals', label: 'سير الموافقات' },
    { id: 'roles', label: 'الأدوار والصلاحيات' },
    { id: 'fields', label: 'حقول الموظف' },
  ];

  return (
    <section className="screen settings-screen">
      <div className="screen-heading">
        <div><h2>مركز إعدادات النظام</h2><p>عدّل بيانات الشركة وسياسات الموارد البشرية والوصول من مكان واحد.</p></div>
        <button className="button button-primary" disabled={busy} onClick={() => void onSave(settings)}>
          <Save size={16} />{busy ? 'جارٍ الحفظ…' : 'حفظ الإعدادات'}
        </button>
      </div>
      <div className="permission-note">
        <ShieldCheck size={18} />
        <div><strong>إعدادات المدير فقط</strong><span>تُراجع التغييرات من الخادم وتُسجل في سجل التدقيق. صلاحيات مدير النظام الأساسية لا يمكن تعطيلها.</span></div>
      </div>
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="أقسام الإعدادات">
          {tabs.map((item) => <button key={item.id} className={`settings-tab ${tab === item.id ? 'settings-tab-active' : ''}`} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}>{item.label}</button>)}
        </nav>
        <div className="panel settings-panel">
          {tab === 'company' && <>
            <div className="panel-head"><div><h3>بيانات الشركة</h3><p>بيانات التعريف والتواصل والإعدادات الإقليمية.</p></div></div>
            <div className="form-grid">
              <label className="field"><span>الاسم المعروض *</span><input value={settings.company.displayName} maxLength={160} required onChange={(event) => updateCompany('displayName', event.target.value)} /></label>
              <label className="field"><span>الاسم القانوني</span><input value={settings.company.legalName} maxLength={160} onChange={(event) => updateCompany('legalName', event.target.value)} /></label>
              <label className="field"><span>رقم الهاتف</span><input value={settings.company.phone} maxLength={40} dir="ltr" onChange={(event) => updateCompany('phone', event.target.value)} /></label>
              <label className="field"><span>البريد الإلكتروني</span><input type="email" value={settings.company.email} maxLength={254} dir="ltr" onChange={(event) => updateCompany('email', event.target.value)} /></label>
              <label className="field"><span>العملة (رمز من 3 أحرف)</span><input value={settings.company.currency} maxLength={3} dir="ltr" onChange={(event) => updateCompany('currency', event.target.value.toUpperCase())} /></label>
              <label className="field"><span>المنطقة الزمنية</span><input value={settings.company.timeZone} maxLength={80} dir="ltr" onChange={(event) => updateCompany('timeZone', event.target.value)} /></label>
              <label className="field settings-wide"><span>العنوان</span><input value={settings.company.address} maxLength={240} onChange={(event) => updateCompany('address', event.target.value)} /></label>
            </div>
          </>}

          {tab === 'leave' && <>
            <div className="panel-head"><div><h3>أنواع الإجازات وسياساتها</h3><p>تُدرج الحزمة المعتمدة عند اختيارك، وتُحفظ بعد الضغط على حفظ الإعدادات.</p></div><div className="heading-actions"><button className="button button-quiet" onClick={applyPolicyDefaults}>تحميل سياسة الشركة</button><button className="button button-quiet" onClick={addLeaveType}><Plus size={15} />إضافة نوع</button></div></div>
            {settings.leaveTypes.length ? <div className="settings-list">
              {settings.leaveTypes.map((item, index) => <div className="settings-item" key={item.id}>
                <div className="settings-item-heading"><strong>نوع إجازة {index + 1}</strong><button className="icon-button settings-delete" aria-label={`حذف ${item.name || 'نوع الإجازة'}`} onClick={() => setSettings((current) => ({ ...current, leaveTypes: current.leaveTypes.filter((leave) => leave.id !== item.id) }))}><Trash2 size={16} /></button></div>
                <div className="form-grid">
                  <label className="field"><span>اسم النوع *</span><input value={item.name} maxLength={80} required onChange={(event) => updateLeaveType(item.id, { name: event.target.value })} /></label>
                  <label className="field"><span>وحدة الاحتساب</span><select value={item.unit} onChange={(event) => updateLeaveType(item.id, { unit: event.target.value as 'days' | 'hours' })}><option value="days">أيام</option><option value="hours">ساعات</option></select></label>
                  <label className="field"><span>الاستحقاق السنوي (اختياري)</span><input type="number" min="0" step="0.25" value={item.annualEntitlement ?? ''} onChange={(event) => updateLeaveType(item.id, { annualEntitlement: event.target.value === '' ? null : Number(event.target.value) })} /></label>
                  <label className="field"><span>حد الترحيل (اختياري)</span><input type="number" min="0" step="0.25" value={item.carryForwardLimit ?? ''} onChange={(event) => updateLeaveType(item.id, { carryForwardLimit: event.target.value === '' ? null : Number(event.target.value) })} /></label>
                  {item.unit === 'days' && <label className="field"><span>أساس احتساب الأيام</span><select value={item.dayCountBasis || 'working'} onChange={(event) => updateLeaveType(item.id, { dayCountBasis: event.target.value as 'working' | 'calendar' })}><option value="working">أيام العمل</option><option value="calendar">أيام تقويمية</option></select></label>}
                  {item.name.includes('مرض') && <label className="settings-check"><input type="checkbox" checked={item.requiresMedicalCertificate || false} onChange={(event) => updateLeaveType(item.id, { requiresMedicalCertificate: event.target.checked })} />يتطلب تقريراً طبياً</label>}
                  <label className="settings-check"><input type="checkbox" checked={item.deductsBalance !== false} onChange={(event) => updateLeaveType(item.id, { deductsBalance: event.target.checked })} />يُخصم من دفتر رصيد الإجازات</label>
                  {item.serviceEntitlements?.length ? (
                    <div className="policy-tiers">
                      <strong>الاستحقاق السنوي المرجعي حسب سنوات الخدمة</strong>
                      {item.serviceEntitlements.map((tier, tierIndex) => (
                        <div className="policy-tier" key={tier.minimumYears}>
                          <span>من السنة</span>
                          <input aria-label="سنة بدء الشريحة" type="number" min="0" max="60" value={tier.minimumYears} onChange={(event) => updateLeaveType(item.id, { serviceEntitlements: item.serviceEntitlements?.map((row, index) => index === tierIndex ? { ...row, minimumYears: Number(event.target.value) } : row) })} />
                          <span>يوم</span>
                          <input aria-label="أيام الاستحقاق" type="number" min="0" max="365" step="0.25" value={tier.days} onChange={(event) => updateLeaveType(item.id, { serviceEntitlements: item.serviceEntitlements?.map((row, index) => index === tierIndex ? { ...row, days: Number(event.target.value) } : row) })} />
                          <button className="icon-button settings-delete" type="button" aria-label="حذف شريحة الاستحقاق" onClick={() => updateLeaveType(item.id, { serviceEntitlements: item.serviceEntitlements?.filter((_, index) => index !== tierIndex) })}><Trash2 size={15} /></button>
                        </div>
                      ))}
                      <button className="button button-quiet" type="button" onClick={() => {
                        const tiers = item.serviceEntitlements ?? [];
                        const lastTier = tiers[tiers.length - 1];
                        updateLeaveType(item.id, {
                          serviceEntitlements: [...tiers, {
                            minimumYears: (lastTier?.minimumYears ?? 0) + 1,
                            days: item.annualEntitlement ?? 0,
                          }],
                        });
                      }}><Plus size={14} />إضافة شريحة</button>
                      <small>الاستحقاق المرجعي لا يُضاف تلقائياً إلى دفتر الرصيد؛ يلزم إجراء تسوية/اعتماد رصيد.</small>
                    </div>
                  ) : null}
                  <label className="settings-check"><input type="checkbox" checked={item.paid} onChange={(event) => updateLeaveType(item.id, { paid: event.target.checked })} />إجازة مدفوعة</label>
                  <label className="settings-check"><input type="checkbox" checked={item.active} onChange={(event) => updateLeaveType(item.id, { active: event.target.checked })} />مفعّل للاستخدام</label>
                </div>
              </div>)}
            </div> : <SettingsEmpty title="لم تُضف أنواع إجازات بعد" text="أدخل الأنواع والاستحقاقات المعتمدة قبل تفعيل إجراءات الإجازات." onAdd={addLeaveType} />}
            <div className="permission-note leave-policy-warning">
              <ShieldCheck size={18} />
              <div><strong>تنبيه امتثال ومراجعة</strong><span>ملف الشركة ينص على 90 يوماً غير مدفوعة للأمومة؛ لم نفعّل هذا البند. الحزمة تضبط 14 أسبوعاً مدفوعة (98 يوماً تقويمياً) استناداً إلى المادة 87 من قانون العمل العراقي رقم 37 لسنة 2015، بانتظار مراجعة المستشار القانوني للشركة.</span></div>
            </div>
            <div className="settings-policy">
              <div className="panel-head"><div><h3>تقويم وحدود الاستخدام</h3><p>راجع هذه القيم واعتمدها قبل تشغيل الطلبات؛ الاستحقاقات المرجعية لا تُضاف تلقائياً إلى الأرصدة.</p></div></div>
              <div className="settings-policy-body">
                <div className="working-days">
                  <span className="field-caption">أيام العمل الأسبوعية</span>
                  {['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'].map((label, day) => (
                    <label className="settings-check" key={day}>
                      <input type="checkbox" checked={settings.leaveRules.workingDays.includes(day)} onChange={(event) => updateLeaveRules({
                        workingDays: event.target.checked
                          ? [...settings.leaveRules.workingDays, day].sort((a, b) => a - b)
                          : settings.leaveRules.workingDays.filter((item) => item !== day),
                      })} />{label}
                    </label>
                  ))}
                </div>
                <label className="field settings-wide"><span>العطل الرسمية (تاريخ لكل سطر، YYYY-MM-DD)</span>
                  <textarea rows={5} value={settings.leaveRules.officialHolidays.join('\n')} placeholder="2026-01-01" onChange={(event) => updateLeaveRules({
                    officialHolidays: [...new Set(event.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))],
                  })} />
                </label>
                <label className="field"><span>الحد الأقصى للإجازة الزمنية للطلب</span><input type="number" min="0.25" max="24" step="0.25" value={settings.leaveRules.maxHoursPerRequest} onChange={(event) => updateLeaveRules({ maxHoursPerRequest: Number(event.target.value) })} /></label>
                <label className="field"><span>الحصة الشهرية للإجازة بالساعات</span><input type="number" min="0" max="744" step="0.25" value={settings.leaveRules.hourlyMonthlyQuota} onChange={(event) => updateLeaveRules({ hourlyMonthlyQuota: Number(event.target.value) })} /></label>
                <label className="field"><span>مرات استخدام الساعات شهرياً</span><input type="number" min="0" max="31" step="1" value={settings.leaveRules.hourlyMonthlyUsageLimit} onChange={(event) => updateLeaveRules({ hourlyMonthlyUsageLimit: Number(event.target.value) })} /></label>
                <label className="field"><span>تنبيه انخفاض الرصيد</span><input type="number" min="0" max="10000" step="0.25" value={settings.leaveRules.lowBalanceThreshold} onChange={(event) => updateLeaveRules({ lowBalanceThreshold: Number(event.target.value) })} /></label>
              </div>
            </div>
          </>}

          {tab === 'payroll' && <>
            <div className="panel-head">
              <div><h3>سياسة الرواتب ومكوناتها</h3><p>اضبط مكونات الدخل والاستقطاع وقواعد التقريب دون تعديل الشيفرة.</p></div>
              <button className="button button-quiet" onClick={addPayrollComponent}><Plus size={15} />إضافة مكوّن</button>
            </div>
            <div className="settings-policy-body payroll-policy-body">
              <label className="field"><span>العملة الأساسية (ISO 4217)</span><input value={settings.payrollRules.baseCurrency} maxLength={3} dir="ltr" onChange={(event) => updatePayrollRules({ baseCurrency: event.target.value.toUpperCase() })} /></label>
              <label className="field"><span>أيام الشهر لأغراض احتساب الأجر اليومي</span><input type="number" min="1" max="31" step="0.5" value={settings.payrollRules.monthlyDivisor} onChange={(event) => updatePayrollRules({ monthlyDivisor: Number(event.target.value) })} /></label>
              <label className="field"><span>الخانات العشرية للتقريب</span><input type="number" min="0" max="4" step="1" value={settings.payrollRules.roundingDigits} onChange={(event) => updatePayrollRules({ roundingDigits: Number(event.target.value) })} /></label>
            </div>
            <div className="permission-note leave-policy-warning">
              <ShieldCheck size={18} />
              <div><strong>إعدادات قابلة للتعديل وليست اعتماداً قانونياً</strong><span>القيم الأولية مستوحاة من ملفات الرواتب المرفقة. مكوّن الضمان معطّل افتراضياً؛ لا يُفعّل أي استقطاع قانوني إلا بعد تحديده ومراجعة واعتماد سياسة الشركة. هذه الإعدادات لا تستورد أسماء أو رواتب ولا تنشئ مسيراً مالياً بحد ذاتها.</span></div>
            </div>
            {settings.payrollRules.components.length ? <div className="settings-list">
              {settings.payrollRules.components.map((item, index) => <div className="settings-item" key={item.id}>
                <div className="settings-item-heading">
                  <strong>{item.name || `مكوّن ${index + 1}`}</strong>
                  <button className="icon-button settings-delete" type="button" aria-label={`حذف ${item.name || 'المكوّن'}`} onClick={() => updatePayrollRules({ components: settings.payrollRules.components.filter((component) => component.id !== item.id) })}><Trash2 size={16} /></button>
                </div>
                <div className="form-grid">
                  <label className="field"><span>اسم المكوّن *</span><input value={item.name} maxLength={80} required onChange={(event) => updatePayrollComponent(item.id, { name: event.target.value })} /></label>
                  <label className="field"><span>نوع المكوّن</span><select value={item.category} onChange={(event) => updatePayrollComponent(item.id, { category: event.target.value as PayrollComponentCategory })}><option value="earning">استحقاق / دخل</option><option value="deduction">استقطاع</option></select></label>
                  <label className="field"><span>طريقة الاحتساب</span><select value={item.calculation} onChange={(event) => updatePayrollComponent(item.id, { calculation: event.target.value as PayrollCalculation })}><option value="manual">إدخال يدوي عند إعداد المسير</option><option value="percentage_of_gross">نسبة من الراتب الكلي</option><option value="percentage_of_basic">نسبة من الراتب الأساسي</option><option value="per_day">مبلغ لكل يوم أو وحدة</option></select></label>
                  <label className="field"><span>{item.calculation.startsWith('percentage') ? 'النسبة %' : item.calculation === 'per_day' ? 'معامل احتساب اليوم' : 'القيمة الافتراضية'}</span><input type="number" min="0" max={item.calculation.startsWith('percentage') ? 100 : 100000} step="0.01" value={item.rate} onChange={(event) => updatePayrollComponent(item.id, { rate: Number(event.target.value) })} /></label>
                  <label className="settings-check"><input type="checkbox" checked={item.active} disabled={item.statutory && !item.legalApproved} onChange={(event) => updatePayrollComponent(item.id, { active: event.target.checked })} />مكوّن مفعّل للاستخدام</label>
                  <label className="settings-check"><input type="checkbox" checked={item.statutory} onChange={(event) => updatePayrollComponent(item.id, event.target.checked ? { statutory: true, active: false, legalApproved: false } : { statutory: false, legalApproved: false })} />مكوّن قانوني أو رسمي</label>
                  {item.statutory && <label className="settings-check"><input type="checkbox" checked={item.legalApproved} onChange={(event) => updatePayrollComponent(item.id, { legalApproved: event.target.checked })} />تمت مراجعته واعتماده قانونياً</label>}
                </div>
              </div>)}
            </div> : <SettingsEmpty title="لا توجد مكونات للرواتب" text="أضف مكونات الدخل والاستقطاع التي تعتمدها شركتك." onAdd={addPayrollComponent} />}
          </>}

          {tab === 'approvals' && <>
            <div className="panel-head"><div><h3>خطوات الموافقة</h3><p>رتّب الأدوار حسب تسلسل الاعتماد الذي تقره الشركة.</p></div><button className="button button-quiet" onClick={addApprovalStep}><Plus size={15} />إضافة خطوة</button></div>
            {settings.approvalSteps.length ? <div className="settings-list">
              {settings.approvalSteps.map((step, index) => <div className="approval-row" key={step.id}>
                <span className="approval-number">{(index + 1).toLocaleString('ar-IQ')}</span>
                <label className="field"><span>الدور المعتمد</span><select value={step.role} onChange={(event) => setSettings((current) => ({ ...current, approvalSteps: current.approvalSteps.map((row) => row.id === step.id ? { ...row, role: event.target.value as UserRole } : row) }))}>{roles.map((role) => <option key={role.id} value={role.id}>{settings.roles[role.id].label}</option>)}</select></label>
                <div className="approval-actions">
                  <button className="button button-quiet" disabled={index === 0} onClick={() => moveApprovalStep(index, -1)} aria-label="تقديم خطوة">↑</button>
                  <button className="button button-quiet" disabled={index === settings.approvalSteps.length - 1} onClick={() => moveApprovalStep(index, 1)} aria-label="تأخير خطوة">↓</button>
                  <button className="icon-button settings-delete" aria-label="حذف الخطوة" onClick={() => setSettings((current) => ({ ...current, approvalSteps: current.approvalSteps.filter((row) => row.id !== step.id) }))}><Trash2 size={16} /></button>
                </div>
              </div>)}
            </div> : <SettingsEmpty title="سير الموافقات غير محدد" text="أضف الأدوار المعتمدة ورتبها لتوثيق مسار الموافقة قبل إطلاق الإجازات." onAdd={addApprovalStep} />}
          </>}

          {tab === 'roles' && <>
            <div className="panel-head"><div><h3>الأدوار والصلاحيات</h3><p>عدّل أسماء الأدوار وصلاحيات الإجراءات؛ الحماية تُطبق على مستوى واجهة API.</p></div></div>
            <div className="role-settings-list">
              {roles.map((role) => <section className="role-settings-row" key={role.id}>
                <label className="field role-label"><span>اسم الدور</span><input value={settings.roles[role.id].label} maxLength={80} onChange={(event) => setSettings((current) => ({ ...current, roles: { ...current.roles, [role.id]: { ...current.roles[role.id], label: event.target.value } } }))} /></label>
                <div className="permission-options"><span className="field-caption">الإجراءات المسموحة</span>{permissions.map((permission) => <label className="settings-check" key={permission.id}>
                  <input type="checkbox" checked={settings.roles[role.id].permissions.includes(permission.id)} disabled={role.id === 'super_admin'} onChange={(event) => togglePermission(role.id, permission.id, event.target.checked)} />{permission.label}
                </label>)}
                  {role.id === 'super_admin' && <small>يحتفظ مدير النظام بكامل صلاحيات الإدارة.</small>}
                </div>
              </section>)}
            </div>
          </>}

          {tab === 'fields' && <>
            <div className="panel-head"><div><h3>حقول الموظف القابلة للتخصيص</h3><p>عرّف حقولاً إضافية تظهر في نماذج بيانات الموظف.</p></div><button className="button button-quiet" onClick={addEmployeeField}><Plus size={15} />إضافة حقل</button></div>
            {settings.employeeFields.length ? <div className="settings-list">
              {settings.employeeFields.map((field) => <div className="settings-item" key={field.id}>
                <div className="settings-item-heading"><strong>{field.label || 'حقل جديد'}</strong><button className="icon-button settings-delete" aria-label="حذف الحقل" onClick={() => setSettings((current) => ({ ...current, employeeFields: current.employeeFields.filter((item) => item.id !== field.id) }))}><Trash2 size={16} /></button></div>
                <div className="form-grid">
                  <label className="field"><span>معرّف الحقل (لاتيني) *</span><input value={field.key} maxLength={40} pattern="[a-z][a-zA-Z0-9_]*" onChange={(event) => updateEmployeeField(field.id, { key: event.target.value })} /></label>
                  <label className="field"><span>التسمية الظاهرة *</span><input value={field.label} maxLength={80} onChange={(event) => updateEmployeeField(field.id, { label: event.target.value })} /></label>
                  <label className="field"><span>نوع البيانات</span><select value={field.type} onChange={(event) => updateEmployeeField(field.id, { type: event.target.value as SystemSettings['employeeFields'][number]['type'], options: event.target.value === 'select' ? field.options : [] })}><option value="text">نص</option><option value="number">رقم</option><option value="date">تاريخ</option><option value="select">قائمة خيارات</option></select></label>
                  {field.type === 'select' && <label className="field"><span>الخيارات (افصل بينها بفاصلة)</span><input value={field.options.join(', ')} maxLength={1000} onChange={(event) => updateEmployeeField(field.id, { options: event.target.value.split(',').map((option) => option.trim()).filter(Boolean) })} /></label>}
                  <label className="settings-check"><input type="checkbox" checked={field.required} onChange={(event) => updateEmployeeField(field.id, { required: event.target.checked })} />حقل مطلوب</label>
                  <label className="settings-check"><input type="checkbox" checked={field.enabled} onChange={(event) => updateEmployeeField(field.id, { enabled: event.target.checked })} />حقل مفعّل</label>
                </div>
              </div>)}
            </div> : <SettingsEmpty title="لا توجد حقول إضافية" text="أضف حقولاً تتناسب مع نماذج واحتياجات شركتك." onAdd={addEmployeeField} />}
          </>}
        </div>
      </div>
    </section>
  );
}

function SettingsEmpty({ title, text, onAdd }: { title: string; text: string; onAdd: () => void }) {
  return <div className="settings-empty"><Check size={19} /><strong>{title}</strong><p>{text}</p><button className="button button-quiet" onClick={onAdd}><Plus size={15} />إضافة</button></div>;
}
