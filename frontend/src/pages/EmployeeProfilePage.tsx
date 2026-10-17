import { Bi } from '../components/Brand';
import { FormEvent, useRef, useState } from 'react';
import {
  Camera, CreditCard, Download, Eye, FilePlus2, FileText, IdCard, Plus, Printer, Trash2, Upload, Wallet,
} from 'lucide-react';
import { EmployeePhoto } from '../components/EmployeePhoto';
import { EmployeePicker, PickedEmployee } from '../components/EmployeePicker';
import { Dialog, Empty, Loading, StatusTag, Tabs, Tone, Warning } from '../components/ui';
import { downloadFile, openFile } from '../lib/api';
import {
  DAY_STATUS, DOCUMENT_TYPES, EMPLOYMENT_TYPES, RUN_STATUS, addDays, formatDate, formatDateTime, formatMinutes, formatMoney,
  monthLabel, today,
} from '../lib/format';
import { navigate } from '../lib/router';
import { useCrumb } from '../lib/breadcrumbs';
import { JobProfileView } from './JobProfilesPage';
import { useLoad, useSession } from '../lib/session';
import type { Department, JobTitle } from './OrgPage';

interface EmployeeDetail {
  id: string;
  employeeNo: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  branchId: string;
  branchName: string;
  departmentId: string | null;
  department: string;
  jobTitleId: string | null;
  position: string;
  grade: string | null;
  managerId: string | null;
  managerName: string | null;
  hireDate: string;
  terminationDate: string | null;
  employmentStatus: 'active' | 'inactive' | 'on_leave' | 'suspended';
  employmentType: string;
  attendancePin: string | null;
  shiftId: string | null;
  shiftName: string | null;
  hasPhoto: boolean;
  photoVersion?: string | null;
  cardIssuedAt: string | null;
  directReports: number;
}

type Tab = 'job' | 'kpis' | 'personal' | 'documents' | 'contracts' | 'salary' | 'attendance' | 'payslips' | 'card';

const STATUS: Record<string, { label: string; tone: string }> = {
  active: { label: 'على رأس العمل', tone: 'good' },
  on_leave: { label: 'في إجازة', tone: 'warn' },
  inactive: { label: 'غير نشط', tone: 'muted' },
  suspended: { label: 'موقوف (بلا راتب)', tone: 'bad' },
};

export function EmployeeProfilePage({ employeeId, branches }: { employeeId: string; branches: Array<{ id: string; name: string }> }) {
  const session = useSession();
  const [tab, setTab] = useState<Tab>('job');
  const [photoVersion, setPhotoVersion] = useState(0);
  const detail = useLoad<EmployeeDetail | null>(`/employees/${employeeId}`, null);
  const photoInput = useRef<HTMLInputElement>(null);
  const employee = detail.data;
  useCrumb(employee?.fullName);

  async function uploadPhoto(file: File) {
    const form = new FormData();
    form.append('file', file);
    try {
      await session.call(`/employees/${employeeId}/photo`, { form });
      session.notify('تم تحديث الصورة الشخصية.');
      setPhotoVersion((value) => value + 1);
      detail.reload();
    } catch (error) {
      session.fail(error, 'تعذر رفع الصورة.');
    }
  }

  if (detail.loading && !employee) return <section className="screen"><Loading /></section>;
  if (!employee) return <section className="screen"><Empty icon={<IdCard size={22} />} title="الموظف غير موجود" text="ربما لا تملك صلاحية على هذا الفرع." /></section>;

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'job', label: 'البيانات الوظيفية' },
    { id: 'kpis', label: 'الوصف ومؤشرات الأداء' },
    ...(session.can('employees.view_profile') ? [
      { id: 'personal' as Tab, label: 'البيانات الشخصية' },
      { id: 'documents' as Tab, label: 'المستمسكات' },
      { id: 'contracts' as Tab, label: 'العقود' },
    ] : []),
    ...(session.can('compensation.view') ? [{ id: 'salary' as Tab, label: 'الراتب' }] : []),
    ...(session.can('attendance.view') ? [{ id: 'attendance' as Tab, label: 'الحضور' }] : []),
    ...(session.can('payroll.view') ? [{ id: 'payslips' as Tab, label: 'قسائم الراتب' }] : []),
    ...(session.can('employees.view_profile') ? [{ id: 'card' as Tab, label: 'بطاقة الموظف' }] : []),
  ];

  return (
    <section className="screen">
      <header className="profile-header panel">
        <div className="profile-photo-wrap">
          <EmployeePhoto employeeId={employee.id} hasPhoto={employee.hasPhoto} name={employee.fullName} size={84} version={photoVersion} photoVersion={employee.photoVersion} />
          {session.can('employees.manage_profile') && <>
            <button className="photo-edit" aria-label="تغيير الصورة" onClick={() => photoInput.current?.click()}><Camera size={15} /></button>
            <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadPhoto(file);
              event.target.value = '';
            }} />
          </>}
        </div>
        <div className="profile-identity">
          <div className="profile-name-row"><h2>{employee.fullName}</h2><StatusTag map={STATUS} value={employee.employmentStatus} /></div>
          <p>{employee.position}{employee.grade ? ` · الدرجة ${employee.grade}` : ''} · {employee.department}</p>
          <div className="profile-facts">
            <span><small>الرقم الوظيفي</small><strong dir="ltr">{employee.employeeNo}</strong></span>
            <span><small>الفرع</small><strong>{employee.branchName}</strong></span>
            <span><small>تاريخ التعيين</small><strong>{formatDate(employee.hireDate)}</strong></span>
            <span><small>نوع التوظيف</small><strong>{EMPLOYMENT_TYPES[employee.employmentType] ?? employee.employmentType}</strong></span>
            <span><small>المدير المباشر</small><strong>{employee.managerName ? <button className="text-button" onClick={() => navigate('employees', employee.managerId!)}>{employee.managerName}</button> : '—'}</strong></span>
            <span><small>الدوام</small><strong>{employee.shiftName ?? 'غير خاضع للبصمة'}</strong></span>
          </div>
        </div>
      </header>

      <Tabs<Tab> value={tab} onChange={setTab} items={tabs} />

      {tab === 'job' && <JobTab employee={employee} branches={branches} onSaved={detail.reload} />}
      {tab === 'kpis' && (employee.jobTitleId
        ? <JobProfileView jobTitleId={employee.jobTitleId} employeeNo={employee.employeeNo} />
        : <section className="panel"><p className="muted-note" style={{ padding: 17 }}>اربط الموظف بمسمى وظيفي من تبويب «البيانات الوظيفية» حتى يظهر وصفه ومؤشرات أدائه.</p></section>)}
      {tab === 'personal' && <PersonalTab employeeId={employee.id} />}
      {tab === 'documents' && <DocumentsTab employeeId={employee.id} />}
      {tab === 'contracts' && <ContractsTab employeeId={employee.id} />}
      {tab === 'salary' && <SalaryTab employeeId={employee.id} />}
      {tab === 'attendance' && <AttendanceTab employeeId={employee.id} />}
      {tab === 'payslips' && <PayslipsTab employeeId={employee.id} />}
      {tab === 'card' && <CardTab employee={employee} onIssued={detail.reload} />}
    </section>
  );
}

function JobTab({ employee, branches, onSaved }: { employee: EmployeeDetail; branches: Array<{ id: string; name: string }>; onSaved: () => void }) {
  const session = useSession();
  const canEdit = session.can('employees.update');
  const isBranchManager = session.user.role === 'branch_manager';
  const departments = useLoad<Department[]>('/org/departments', []);
  const titles = useLoad<JobTitle[]>('/org/job-titles', []);
  const shifts = useLoad<Array<{ id: string; name: string; isActive: boolean; startTime: string; endTime: string }>>(
    session.can('attendance.view') ? '/attendance/shifts' : null, [],
  );
  const [manager, setManager] = useState<PickedEmployee | null>(
    employee.managerId ? { id: employee.managerId, fullName: employee.managerName ?? '', employeeNo: '' } : null,
  );
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      fullName: String(form.get('fullName') || ''),
      email: String(form.get('email') || ''),
      phone: String(form.get('phone') || ''),
      branchId: String(form.get('branchId') || ''),
      departmentId: form.get('departmentId') || null,
      jobTitleId: form.get('jobTitleId') || null,
      managerId: manager?.id ?? null,
      employmentStatus: String(form.get('employmentStatus')),
    };
    if (!isBranchManager) {
      Object.assign(body, {
        hireDate: String(form.get('hireDate') || ''),
        terminationDate: String(form.get('terminationDate') || '') || null,
        employmentType: String(form.get('employmentType')),
        attendancePin: String(form.get('attendancePin') || '') || null,
        ...(session.can('attendance.view') ? { shiftId: form.get('shiftId') || null } : {}),
      });
    }
    if (!body.departmentId) delete body.departmentId;
    if (!body.jobTitleId) delete body.jobTitleId;
    setBusy(true);
    try {
      await session.call(`/employees/${employee.id}`, { method: 'PUT', body });
      session.notify('تم حفظ البيانات الوظيفية.');
      onSaved();
    } catch (error) {
      session.fail(error, 'تعذر حفظ البيانات.');
    } finally {
      setBusy(false);
    }
  }

  // Selects take their initial value only at mount, so wait for the option lists;
  // otherwise saving would silently clear the department, title or shift.
  if (departments.loading || titles.loading || shifts.loading) return <section className="panel"><Loading /></section>;

  return (
    <form className="panel form-panel" onSubmit={submit} key={`${employee.id}-${departments.data.length}-${titles.data.length}-${shifts.data.length}`}>
      <div className="panel-head"><div><h3>البيانات الوظيفية</h3><p>ربط الموظف بالقسم والمسمى والمدير والدوام. تاريخ التعيين والدوام ورقم البصمة تؤثر على الراتب.</p></div></div>
      <fieldset disabled={!canEdit} className="plain-fieldset">
        <div className="form-grid">
          <label className="field"><span>الاسم الكامل *</span><input name="fullName" required maxLength={180} defaultValue={employee.fullName} /></label>
          <label className="field"><span>الفرع *</span><select name="branchId" defaultValue={employee.branchId}>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
          <label className="field"><span>الحالة</span><select name="employmentStatus" defaultValue={employee.employmentStatus}><option value="active">على رأس العمل</option><option value="on_leave">في إجازة</option><option value="inactive">غير نشط</option></select></label>
          <label className="field"><span>القسم</span><select name="departmentId" defaultValue={employee.departmentId ?? ''}><option value="">{employee.departmentId ? '—' : `${employee.department} (نص قديم)`}</option>{departments.data.filter((item) => item.isActive || item.id === employee.departmentId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="field"><span>المسمى الوظيفي</span><select name="jobTitleId" defaultValue={employee.jobTitleId ?? ''}><option value="">{employee.jobTitleId ? '—' : `${employee.position} (نص قديم)`}</option>{titles.data.filter((item) => item.isActive || item.id === employee.jobTitleId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <EmployeePicker label="المدير المباشر" value={manager} onChange={setManager} exclude={employee.id} />
          <label className="field"><span>البريد الإلكتروني</span><input name="email" type="email" dir="ltr" maxLength={254} defaultValue={employee.email ?? ''} /></label>
          <label className="field"><span>الهاتف</span><input name="phone" dir="ltr" maxLength={40} defaultValue={employee.phone ?? ''} /></label>
          <label className="field"><span>تاريخ التعيين</span><input name="hireDate" type="date" defaultValue={employee.hireDate} disabled={isBranchManager} /></label>
          <label className="field"><span>نوع التوظيف</span><select name="employmentType" defaultValue={employee.employmentType} disabled={isBranchManager}>{Object.entries(EMPLOYMENT_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {session.can('attendance.view') && <label className="field"><span>الدوام (البصمة)</span><select name="shiftId" defaultValue={employee.shiftId ?? ''} disabled={isBranchManager}><option value="">غير خاضع للبصمة</option>{shifts.data.filter((item) => item.isActive || item.id === employee.shiftId).map((item) => <option key={item.id} value={item.id}>{item.name} ({item.startTime}–{item.endTime})</option>)}</select></label>}
          <label className="field"><span>رقم البصمة في الجهاز</span><input name="attendancePin" dir="ltr" maxLength={40} pattern="[A-Za-z0-9_\-]+" defaultValue={employee.attendancePin ?? ''} disabled={isBranchManager} /><small>إن تُرك فارغاً يُطابق برقم الموظف.</small></label>
          <label className="field"><span>تاريخ ترك الخدمة</span><input name="terminationDate" type="date" defaultValue={employee.terminationDate ?? ''} disabled={isBranchManager} /></label>
        </div>
        {canEdit && <div className="form-actions"><button className="button button-primary" disabled={busy}>{busy ? 'جارٍ الحفظ…' : 'حفظ البيانات الوظيفية'}</button></div>}
      </fieldset>
    </form>
  );
}

interface Profile {
  nameEn: string | null; motherName: string | null; gender: string | null; birthDate: string | null; birthPlace: string | null;
  nationality: string | null; maritalStatus: string | null; dependentsCount: number | null; nationalIdNo: string | null;
  address: string | null; governorate: string | null; emergencyContactName: string | null; emergencyContactPhone: string | null;
  emergencyContactRelation: string | null; educationLevel: string | null; educationMajor: string | null; bloodType: string | null;
  socialSecurityNo: string | null; paymentMethod: string | null; bankName: string | null; bankAccountNo: string | null;
  walletProvider: string | null; updatedAt?: string; updatedByName?: string;
  residencyStatus?: 'local' | 'foreign' | null; passportNo?: string | null; passportExpiry?: string | null;
  residencyType?: string | null; residencyNo?: string | null; residencyExpiry?: string | null;
}

const GOVERNORATES = ['بغداد', 'البصرة', 'نينوى', 'أربيل', 'السليمانية', 'دهوك', 'كركوك', 'الأنبار', 'بابل', 'كربلاء', 'النجف', 'واسط', 'ديالى', 'صلاح الدين', 'ذي قار', 'ميسان', 'المثنى', 'القادسية', 'حلبجة'];

function PersonalTab({ employeeId }: { employeeId: string }) {
  const session = useSession();
  const profile = useLoad<Profile | null>(`/employees/${employeeId}/profile`, null);
  const canEdit = session.can('employees.manage_profile');
  const canPay = session.can('compensation.manage');
  const [busy, setBusy] = useState(false);
  const value = profile.data;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim() || null;
    const body: Record<string, unknown> = {
      nameEn: text('nameEn'), motherName: text('motherName'), gender: text('gender'), birthDate: text('birthDate'),
      birthPlace: text('birthPlace'), nationality: text('nationality'), maritalStatus: text('maritalStatus'),
      dependentsCount: form.get('dependentsCount') === '' ? null : Number(form.get('dependentsCount')),
      nationalIdNo: text('nationalIdNo'), address: text('address'), governorate: text('governorate'),
      emergencyContactName: text('emergencyContactName'), emergencyContactPhone: text('emergencyContactPhone'),
      emergencyContactRelation: text('emergencyContactRelation'), educationLevel: text('educationLevel'),
      educationMajor: text('educationMajor'), bloodType: text('bloodType'), socialSecurityNo: text('socialSecurityNo'),
      residencyStatus: text('residencyStatus') ?? 'local', passportNo: text('passportNo'), passportExpiry: text('passportExpiry'),
      residencyType: text('residencyType'), residencyNo: text('residencyNo'), residencyExpiry: text('residencyExpiry'),
    };
    if (canPay) {
      Object.assign(body, {
        paymentMethod: text('paymentMethod') ?? 'bank', bankName: text('bankName'), walletProvider: text('walletProvider'),
      });
      const account = text('bankAccountNo');
      // A masked value means "unchanged".
      if (account && !account.startsWith('••••')) body.bankAccountNo = account;
      if (!account) body.bankAccountNo = null;
    }
    setBusy(true);
    try {
      await session.call(`/employees/${employeeId}/profile`, { method: 'PUT', body });
      session.notify('تم حفظ البيانات الشخصية.');
      profile.reload();
    } catch (error) {
      session.fail(error, 'تعذر حفظ البيانات الشخصية.');
    } finally {
      setBusy(false);
    }
  }

  if (profile.loading && !value) return <section className="panel"><Loading /></section>;
  return (
    <form className="panel form-panel" onSubmit={submit} key={value?.updatedAt ?? 'empty'}>
      <div className="panel-head"><div><h3>البيانات الشخصية</h3><p>{value?.updatedAt ? `آخر تحديث ${formatDateTime(value.updatedAt)} بواسطة ${value.updatedByName}` : 'لم تُسجل البيانات الشخصية بعد.'} · رقم الهوية والحساب المصرفي مشفّران في قاعدة البيانات.</p></div></div>
      <fieldset disabled={!canEdit} className="plain-fieldset">
        <h4 className="form-section">الهوية</h4>
        <div className="form-grid">
          <label className="field"><span>الاسم بالإنجليزية</span><input name="nameEn" dir="ltr" maxLength={180} defaultValue={value?.nameEn ?? ''} /></label>
          <label className="field"><span>اسم الأم</span><input name="motherName" maxLength={180} defaultValue={value?.motherName ?? ''} /></label>
          <label className="field"><span>رقم البطاقة الوطنية</span><input name="nationalIdNo" dir="ltr" maxLength={40} defaultValue={value?.nationalIdNo ?? ''} /></label>
          <label className="field"><span>الجنس</span><select name="gender" defaultValue={value?.gender ?? ''}><option value="">—</option><option value="male">ذكر</option><option value="female">أنثى</option></select></label>
          <label className="field"><span>تاريخ الميلاد</span><input name="birthDate" type="date" defaultValue={value?.birthDate ?? ''} /></label>
          <label className="field"><span>محل الولادة</span><input name="birthPlace" maxLength={120} defaultValue={value?.birthPlace ?? ''} /></label>
          <label className="field"><span>الجنسية</span><input name="nationality" maxLength={80} defaultValue={value?.nationality ?? 'عراقية'} /></label>
          <label className="field"><span>الحالة الاجتماعية</span><select name="maritalStatus" defaultValue={value?.maritalStatus ?? ''}><option value="">—</option><option value="single">أعزب/عزباء</option><option value="married">متزوج/ة</option><option value="divorced">مطلق/ة</option><option value="widowed">أرمل/ة</option></select></label>
          <label className="field"><span>عدد المعالين</span><input name="dependentsCount" type="number" min={0} max={30} defaultValue={value?.dependentsCount ?? ''} /></label>
          <label className="field"><span>فصيلة الدم</span><select name="bloodType" defaultValue={value?.bloodType ?? ''}><option value="">—</option>{['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
          <label className="field"><span>رقم الضمان الاجتماعي</span><input name="socialSecurityNo" dir="ltr" maxLength={40} defaultValue={value?.socialSecurityNo ?? ''} /></label>
        </div>
        <h4 className="form-section"><Bi ar={"محلي / أجنبي"} en={"Local / Foreign"} /></h4>
        <p className="muted-note">للموظف الأجنبي: يصل تذكير له وللمالك قبل انتهاء الإقامة (الفيزا) بـ 60 يوماً وقبل انتهاء الجواز بـ 6 أشهر. رقم الجواز مشفّر.</p>
        <div className="form-grid">
          <label className="field"><span>نوع الموظف</span><select name="residencyStatus" defaultValue={value?.residencyStatus ?? 'local'}><option value="local">محلي (عراقي)</option><option value="foreign">أجنبي</option></select></label>
          <label className="field"><span>رقم الجواز</span><input name="passportNo" dir="ltr" maxLength={40} defaultValue={value?.passportNo ?? ''} /></label>
          <label className="field"><span>انتهاء الجواز</span><input name="passportExpiry" type="date" defaultValue={value?.passportExpiry ?? ''} /></label>
          <label className="field"><span>نوع الإقامة</span><select name="residencyType" defaultValue={value?.residencyType ?? ''}><option value="">—</option>{['إقامة عمل', 'فيزا عمل', 'إقامة دائمة', 'إقامة إقليم كردستان', 'زيارة'].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label className="field"><span>رقم الإقامة / الفيزا</span><input name="residencyNo" dir="ltr" maxLength={60} defaultValue={value?.residencyNo ?? ''} /></label>
          <label className="field"><span>انتهاء الإقامة</span><input name="residencyExpiry" type="date" defaultValue={value?.residencyExpiry ?? ''} /></label>
        </div>
        <h4 className="form-section">السكن والطوارئ</h4>
        <div className="form-grid">
          <label className="field"><span>المحافظة</span><select name="governorate" defaultValue={value?.governorate ?? ''}><option value="">—</option>{GOVERNORATES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label className="field settings-wide-2"><span>العنوان</span><input name="address" maxLength={400} defaultValue={value?.address ?? ''} /></label>
          <label className="field"><span>اسم جهة الطوارئ</span><input name="emergencyContactName" maxLength={180} defaultValue={value?.emergencyContactName ?? ''} /></label>
          <label className="field"><span>صلة القرابة</span><input name="emergencyContactRelation" maxLength={60} defaultValue={value?.emergencyContactRelation ?? ''} /></label>
          <label className="field"><span>هاتف الطوارئ</span><input name="emergencyContactPhone" dir="ltr" maxLength={40} defaultValue={value?.emergencyContactPhone ?? ''} /></label>
        </div>
        <h4 className="form-section">التحصيل الدراسي</h4>
        <div className="form-grid">
          <label className="field"><span>التحصيل</span><select name="educationLevel" defaultValue={value?.educationLevel ?? ''}><option value="">—</option>{['ابتدائية', 'متوسطة', 'إعدادية', 'دبلوم', 'بكالوريوس', 'ماجستير', 'دكتوراه'].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label className="field"><span>الاختصاص</span><input name="educationMajor" maxLength={120} defaultValue={value?.educationMajor ?? ''} /></label>
        </div>
        <h4 className="form-section">طريقة استلام الراتب {!canPay && <small>(تعديلها يتطلب صلاحية إدارة الرواتب)</small>}</h4>
        <div className="form-grid">
          <label className="field"><span>طريقة الدفع</span><select name="paymentMethod" defaultValue={value?.paymentMethod ?? 'bank'} disabled={!canPay}><option value="bank">تحويل مصرفي</option><option value="wallet">محفظة / بطاقة (كي كارد، زين كاش…)</option><option value="cash">نقداً</option></select></label>
          <label className="field"><span>المصرف</span><input name="bankName" maxLength={120} defaultValue={value?.bankName ?? ''} disabled={!canPay} /></label>
          <label className="field"><span>رقم الحساب / IBAN</span><input name="bankAccountNo" dir="ltr" maxLength={60} defaultValue={value?.bankAccountNo ?? ''} disabled={!canPay} /></label>
          <label className="field"><span>مزود المحفظة</span><input name="walletProvider" maxLength={60} defaultValue={value?.walletProvider ?? ''} disabled={!canPay} /></label>
        </div>
        {canEdit && <div className="form-actions"><button className="button button-primary" disabled={busy}>{busy ? 'جارٍ الحفظ…' : 'حفظ البيانات الشخصية'}</button></div>}
      </fieldset>
    </form>
  );
}

interface DocumentRow {
  id: string; docType: string; title: string; docNumber: string | null; issueDate: string | null; expiryDate: string | null;
  originalName: string; mimeType: string; sizeBytes: number; createdAt: string; uploadedByName: string;
}

function expiryTone(date: string | null): { tone: string; label: string } | null {
  if (!date) return null;
  const now = today();
  if (date < now) return { tone: 'bad', label: 'منتهي' };
  if (date <= addDays(now, 45)) return { tone: 'warn', label: 'ينتهي قريباً' };
  return { tone: 'good', label: 'ساري' };
}

function DocumentsTab({ employeeId }: { employeeId: string }) {
  const session = useSession();
  const documents = useLoad<DocumentRow[]>(`/employees/${employeeId}/documents`, []);
  const canEdit = session.can('employees.manage_profile');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    for (const key of ['docNumber', 'issueDate', 'expiryDate']) if (!form.get(key)) form.delete(key);
    setBusy(true);
    try {
      await session.call(`/employees/${employeeId}/documents`, { form });
      session.notify('تم رفع المستند.');
      setOpen(false);
      documents.reload();
    } catch (error) {
      session.fail(error, 'تعذر رفع المستند.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(document: DocumentRow) {
    if (!window.confirm(`إزالة «${document.title}» من ملف الموظف؟ يبقى أثره في سجل التدقيق.`)) return;
    try {
      await session.call(`/documents/${document.id}`, { method: 'DELETE' });
      session.notify('تمت إزالة المستند.');
      documents.reload();
    } catch (error) {
      session.fail(error, 'تعذرت إزالة المستند.');
    }
  }

  return (
    <section className="panel">
      <div className="panel-head"><div><h3>المستمسكات والوثائق</h3><p>PDF أو صور حتى 10 ميغابايت. كل فتح أو تنزيل يُسجل في سجل التدقيق.</p></div>
        {canEdit && <button className="button button-primary" onClick={() => setOpen(true)}><Upload size={16} />رفع مستند</button>}</div>
      {documents.loading ? <Loading /> : documents.data.length ? <div className="table-scroll"><table>
        <thead><tr><th>المستند</th><th>النوع</th><th>الرقم</th><th>الإصدار</th><th>الانتهاء</th><th>رُفع بواسطة</th><th /></tr></thead>
        <tbody>{documents.data.map((document) => {
          const expiry = expiryTone(document.expiryDate);
          return <tr key={document.id}>
            <td><span className="doc-cell"><FileText size={16} /><span><strong>{document.title}</strong><small>{document.originalName} · {(document.sizeBytes / 1024).toFixed(0)} KB</small></span></span></td>
            <td>{DOCUMENT_TYPES[document.docType] ?? document.docType}</td>
            <td dir="ltr">{document.docNumber || '—'}</td>
            <td>{formatDate(document.issueDate)}</td>
            <td>{document.expiryDate ? <>{formatDate(document.expiryDate)} {expiry && <Tone tone={expiry.tone}>{expiry.label}</Tone>}</> : '—'}</td>
            <td>{document.uploadedByName}<small className="table-sub">{formatDate(document.createdAt)}</small></td>
            <td><span className="row-actions">
              <button className="icon-link" aria-label="عرض" onClick={() => void openFile(`/documents/${document.id}/file?inline=1`, session.token).catch((error) => session.fail(error, 'تعذر فتح المستند.'))}><Eye size={14} /></button>
              <button className="icon-link" aria-label="تنزيل" onClick={() => void downloadFile(`/documents/${document.id}/file`, session.token, document.originalName).catch((error) => session.fail(error, 'تعذر التنزيل.'))}><Download size={14} /></button>
              {canEdit && <button className="icon-link danger" aria-label="إزالة" onClick={() => void remove(document)}><Trash2 size={14} /></button>}
            </span></td>
          </tr>;
        })}</tbody>
      </table></div> : <Empty icon={<FileText size={22} />} title="لا توجد مستمسكات" text="ارفع البطاقة الوطنية وبطاقة السكن والعقد والشهادات ليكتمل ملف الموظف." action={canEdit ? 'رفع مستند' : undefined} onAction={() => setOpen(true)} />}

      <Dialog open={open} title="رفع مستند" onClose={() => setOpen(false)}>
        <form onSubmit={upload}>
          <div className="form-grid form-grid-2">
            <label className="field"><span>نوع المستند *</span><select name="docType" required defaultValue="">{[<option key="" value="" disabled>اختر</option>, ...Object.entries(DOCUMENT_TYPES).filter(([value]) => value !== 'photo').map(([value, label]) => <option key={value} value={value}>{label}</option>)]}</select></label>
            <label className="field"><span>العنوان *</span><input name="title" required maxLength={160} placeholder="مثال: البطاقة الوطنية - الوجهان" /></label>
            <label className="field"><span>رقم المستند</span><input name="docNumber" dir="ltr" maxLength={80} /></label>
            <label className="field"><span>تاريخ الإصدار</span><input name="issueDate" type="date" /></label>
            <label className="field"><span>تاريخ الانتهاء</span><input name="expiryDate" type="date" /><small>يظهر تنبيه قبل الانتهاء بـ 45 يوماً.</small></label>
            <label className="field"><span>الملف *</span><input name="file" type="file" required accept="application/pdf,image/jpeg,image/png,image/webp" /></label>
          </div>
          <div className="dialog-actions"><button className="button button-primary" disabled={busy}>{busy ? 'جارٍ الرفع…' : 'رفع'}</button><button type="button" className="button button-quiet" onClick={() => setOpen(false)}>إلغاء</button></div>
        </form>
      </Dialog>
    </section>
  );
}

interface ContractRow {
  id: string; contractNo: string | null; contractType: string; startsOn: string; endsOn: string | null;
  probationEndsOn: string | null; status: string; notes: string | null; documentId: string | null;
}

interface ContractTemplate { id: string; name: string; contractType: string | null; fields: string[]; isActive: boolean; kind?: string }
interface FieldValue { key: string; alias: string; label: string; value: string }

/** The day before the same date `months` later (a one-year contract, a three-month probation). */
function monthsLater(date: string, months: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function GenerateContract({ employeeId, onDone, onClose }: { employeeId: string; onDone: () => void; onClose: () => void }) {
  const session = useSession();
  const templates = useLoad<ContractTemplate[]>('/contracts/templates', []);
  const preview = useLoad<FieldValue[]>(`/employees/${employeeId}/contracts/preview`, []);
  const active = templates.data.filter((item) => item.isActive && item.kind !== 'advance');
  const [templateId, setTemplateId] = useState('');
  const [startsOn, setStartsOn] = useState(today());
  const [busy, setBusy] = useState(false);
  const template = active.find((item) => item.id === templateId) ?? active[0];
  const termFields = ['start_date', 'end_date', 'probation_end', 'contract_no', 'contract_date', 'contract_day'];
  const missing = template ? preview.data.filter((field) => template.fields.includes(field.key) && !termFields.includes(field.key) && !field.value) : [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!template) return;
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '') || null;
    setBusy(true);
    try {
      const result = await session.call<{ data: { documentId: string } }>(`/employees/${employeeId}/contracts/generate`, {
        body: { templateId: template.id, contractType: text('contractType'), startsOn: text('startsOn'), endsOn: text('endsOn'), probationEndsOn: text('probationEndsOn'), contractNo: text('contractNo') },
      });
      await downloadFile(`/documents/${result.data.documentId}/file`, session.token, 'contract.docx');
      session.notify('أُنشئ العقد وحُفظ في مستمسكات الموظف كمسودة. بعد التوقيع ارفع النسخة الموقعة وغيّر الحالة إلى ساري.');
      onDone();
    } catch (error) {
      session.fail(error, 'تعذر إنشاء العقد.');
    } finally {
      setBusy(false);
    }
  }

  if (templates.loading) return <Loading />;
  if (!active.length) return <Empty icon={<FileText size={22} />} title="لا توجد قوالب عقود" text="ارفع قالب العقد من الموظفون ← قوالب العقود." action={session.can('employees.manage_profile') ? 'قوالب العقود' : undefined} onAction={() => navigate('contract-templates')} />;
  return (
    <form onSubmit={submit} key={template?.id}>
      <div className="form-grid form-grid-2">
        <label className="field settings-wide"><span>القالب *</span><select value={template?.id ?? ''} onChange={(event) => setTemplateId(event.target.value)}>{active.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="field"><span>نوع العقد</span><select name="contractType" defaultValue={template?.contractType ?? 'fixed_term'}>{Object.entries(EMPLOYMENT_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field"><span>رقم العقد</span><input name="contractNo" dir="ltr" maxLength={60} /></label>
        <label className="field"><span>تاريخ البداية *</span><input name="startsOn" type="date" required value={startsOn} onChange={(event) => setStartsOn(event.target.value)} /></label>
        <label className="field"><span>تاريخ النهاية</span><input name="endsOn" type="date" key={startsOn} defaultValue={template?.contractType === 'daily' || !startsOn ? '' : monthsLater(startsOn, 12)} /></label>
        <label className="field"><span>نهاية فترة التجربة</span><input name="probationEndsOn" type="date" key={`p${startsOn}`} defaultValue={startsOn ? monthsLater(startsOn, 3) : ''} /><small>3 أشهر افتراضياً</small></label>
      </div>
      {missing.length > 0 && <Warning title="بيانات ناقصة في ملف الموظف">ستظهر فارغة في العقد: {missing.map((field) => field.label).join('، ')}. أكملها من تبويب البيانات الشخصية ثم أنشئ العقد.</Warning>}
      <div className="dialog-actions"><button className="button button-primary" disabled={busy || !template}><FilePlus2 size={16} />{busy ? 'جارٍ الإنشاء…' : 'إنشاء العقد وتنزيله'}</button><button type="button" className="button button-quiet" onClick={onClose}>إلغاء</button></div>
    </form>
  );
}

const CONTRACT_STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: 'مسودة', tone: 'muted' },
  active: { label: 'ساري', tone: 'good' },
  expired: { label: 'منتهي', tone: 'warn' },
  terminated: { label: 'مفسوخ', tone: 'bad' },
};

function ContractsTab({ employeeId }: { employeeId: string }) {
  const session = useSession();
  const contracts = useLoad<ContractRow[]>(`/employees/${employeeId}/contracts`, []);
  const canEdit = session.can('employees.manage_profile');
  const [editing, setEditing] = useState<ContractRow | 'new' | null>(null);
  const [generating, setGenerating] = useState(false);
  const current = editing && editing !== 'new' ? editing : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '') || null;
    const body = {
      contractNo: text('contractNo'), contractType: text('contractType'), startsOn: text('startsOn'), endsOn: text('endsOn'),
      probationEndsOn: text('probationEndsOn'), status: text('status'), notes: text('notes'),
    };
    try {
      await session.call(current ? `/employees/${employeeId}/contracts/${current.id}` : `/employees/${employeeId}/contracts`, {
        method: current ? 'PUT' : 'POST', body,
      });
      session.notify('تم حفظ العقد.');
      setEditing(null);
      contracts.reload();
    } catch (error) {
      session.fail(error, 'تعذر حفظ العقد.');
    }
  }

  return (
    <section className="panel">
      <div className="panel-head"><div><h3>العقود</h3><p>تنبيهات انتهاء العقد وفترة التجربة تظهر في لوحة البداية.</p></div>
        {canEdit && <div className="heading-actions"><button className="button button-primary" onClick={() => setGenerating(true)}><FilePlus2 size={16} />إنشاء عقد من قالب</button><button className="button button-quiet" onClick={() => setEditing('new')}><Plus size={16} />تسجيل عقد موقّع</button></div>}</div>
      {contracts.loading ? <Loading /> : contracts.data.length ? <div className="table-scroll"><table>
        <thead><tr><th>رقم العقد</th><th>النوع</th><th>من</th><th>إلى</th><th>نهاية التجربة</th><th>الحالة</th><th>الملف</th>{canEdit && <th />}</tr></thead>
        <tbody>{contracts.data.map((contract) => <tr key={contract.id}>
          <td dir="ltr">{contract.contractNo || '—'}</td>
          <td>{EMPLOYMENT_TYPES[contract.contractType] ?? contract.contractType}</td>
          <td>{formatDate(contract.startsOn)}</td>
          <td>{contract.endsOn ? formatDate(contract.endsOn) : 'مفتوح'}</td>
          <td>{formatDate(contract.probationEndsOn)}</td>
          <td><StatusTag map={CONTRACT_STATUS} value={contract.status} /></td>
          <td>{contract.documentId ? <button className="icon-link" aria-label="تنزيل العقد" onClick={() => void downloadFile(`/documents/${contract.documentId}/file`, session.token, 'contract').catch((error) => session.fail(error, 'تعذر التنزيل.'))}><Download size={14} /></button> : '—'}</td>
          {canEdit && <td><button className="text-button" onClick={() => setEditing(contract)}>تعديل</button></td>}
        </tr>)}</tbody>
      </table></div> : <Empty icon={<FileText size={22} />} title="لا توجد عقود مسجلة" text="سجّل عقد العمل وتاريخ انتهائه وفترة التجربة." action={canEdit ? 'عقد جديد' : undefined} onAction={() => setEditing('new')} />}
      <Dialog open={generating} title="إنشاء عقد من قالب" subtitle="يُملأ القالب من ملف الموظف وراتبه، ويُحفظ في مستمسكاته كمسودة للتوقيع." onClose={() => setGenerating(false)} wide>
        {generating && <GenerateContract employeeId={employeeId} onClose={() => setGenerating(false)} onDone={() => { setGenerating(false); contracts.reload(); }} />}
      </Dialog>
      <Dialog open={editing !== null} title={current ? 'تعديل العقد' : 'عقد جديد'} onClose={() => setEditing(null)}>
        <form onSubmit={submit} key={current?.id ?? 'new'}>
          <div className="form-grid form-grid-2">
            <label className="field"><span>رقم العقد</span><input name="contractNo" dir="ltr" maxLength={60} defaultValue={current?.contractNo ?? ''} /></label>
            <label className="field"><span>نوع العقد *</span><select name="contractType" required defaultValue={current?.contractType ?? 'fixed_term'}>{Object.entries(EMPLOYMENT_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="field"><span>تاريخ البداية *</span><input name="startsOn" type="date" required defaultValue={current?.startsOn ?? ''} /></label>
            <label className="field"><span>تاريخ النهاية</span><input name="endsOn" type="date" defaultValue={current?.endsOn ?? ''} /></label>
            <label className="field"><span>نهاية فترة التجربة</span><input name="probationEndsOn" type="date" defaultValue={current?.probationEndsOn ?? ''} /></label>
            <label className="field"><span>الحالة</span><select name="status" defaultValue={current?.status ?? 'active'}>{Object.entries(CONTRACT_STATUS).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}</select></label>
            <label className="field settings-wide"><span>ملاحظات</span><textarea name="notes" rows={2} maxLength={1000} defaultValue={current?.notes ?? ''} /></label>
          </div>
          <div className="dialog-actions"><button className="button button-primary">حفظ</button><button type="button" className="button button-quiet" onClick={() => setEditing(null)}>إلغاء</button></div>
        </form>
      </Dialog>
    </section>
  );
}

interface CompensationRow {
  id: string; effectiveFrom: string; grossSalary: number; currency: string; reason: string; createdAt: string; createdByName: string;
  componentOverrides: Record<string, number>; socialSecurityBase: number | null;
}

function SalaryTab({ employeeId }: { employeeId: string }) {
  const session = useSession();
  const history = useLoad<CompensationRow[]>(`/employees/${employeeId}/compensation`, []);
  const canEdit = session.can('compensation.manage');
  const [open, setOpen] = useState(false);
  const current = history.data[0];
  const components = session.settings.payrollRules.components.filter((item) => item.active);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const overrides: Record<string, number> = {};
    for (const component of components) {
      const raw = form.get(`override.${component.id}`);
      if (raw !== null && raw !== '') overrides[component.id] = Number(raw);
    }
    try {
      await session.call(`/employees/${employeeId}/compensation`, {
        body: {
          effectiveFrom: form.get('effectiveFrom'),
          grossSalary: Number(form.get('grossSalary')),
          currency: form.get('currency'),
          reason: form.get('reason'),
          socialSecurityBase: form.get('socialSecurityBase') ? Number(form.get('socialSecurityBase')) : null,
          componentOverrides: overrides,
        },
      });
      session.notify('تم تسجيل الراتب.');
      setOpen(false);
      history.reload();
    } catch (error) {
      session.fail(error, 'تعذر تسجيل الراتب.');
    }
  }

  return (
    <section className="panel">
      <div className="panel-head"><div><h3>الراتب وسجل التعديلات</h3><p>لا يُعدل راتب سابق؛ كل تغيير يُسجل بتاريخ سريان وسبب. المسير المعتمد لا يتأثر بتعديل لاحق.</p></div>
        {canEdit && <button className="button button-primary" onClick={() => setOpen(true)}><Wallet size={16} />تسجيل راتب / زيادة</button>}</div>
      {current && <div className="salary-current"><span>الراتب الحالي</span><strong>{formatMoney(current.grossSalary, current.currency)}</strong><small>ساري من {formatDate(current.effectiveFrom)}{current.socialSecurityBase ? ` · راتب منصة الضمان ${formatMoney(current.socialSecurityBase, current.currency)}` : ' · غير مسجل في الضمان'}</small></div>}
      {history.loading ? <Loading /> : history.data.length ? <div className="table-scroll"><table>
        <thead><tr><th>ساري من</th><th>الراتب الكلي</th><th>راتب الضمان</th><th>مبالغ ثابتة</th><th>السبب</th><th>سُجل بواسطة</th></tr></thead>
        <tbody>{history.data.map((row) => <tr key={row.id}>
          <td>{formatDate(row.effectiveFrom)}</td>
          <td><strong>{formatMoney(row.grossSalary, row.currency)}</strong></td>
          <td>{row.socialSecurityBase ? formatMoney(row.socialSecurityBase, row.currency) : '—'}</td>
          <td>{Object.keys(row.componentOverrides || {}).length ? Object.entries(row.componentOverrides).map(([id, amount]) => <small className="table-sub" key={id}>{session.settings.payrollRules.components.find((item) => item.id === id)?.name}: {formatMoney(amount, row.currency)}</small>) : '—'}</td>
          <td className="wrap">{row.reason}</td>
          <td>{row.createdByName}<small className="table-sub">{formatDate(row.createdAt)}</small></td>
        </tr>)}</tbody>
      </table></div> : <Empty icon={<Wallet size={22} />} title="لم يُسجل راتب" text="بدون راتب مسجل لا يدخل الموظف في مسير الرواتب." action={canEdit ? 'تسجيل الراتب' : undefined} onAction={() => setOpen(true)} />}
      <Dialog open={open} title="تسجيل راتب" subtitle="الراتب الكلي يُوزع على المكونات حسب نسبها في الإعدادات، إلا إذا حددت مبلغاً ثابتاً لمكوّن." onClose={() => setOpen(false)} wide>
        <form onSubmit={submit}>
          <div className="form-grid">
            <label className="field"><span>ساري من *</span><input name="effectiveFrom" type="date" required defaultValue={`${today().slice(0, 7)}-01`} /></label>
            <label className="field"><span>الراتب الكلي الشهري *</span><input name="grossSalary" type="number" min={0} step="0.01" required defaultValue={current?.grossSalary ?? ''} /><small>للأجر اليومي: أدخل أجر اليوم الواحد.</small></label>
            <label className="field"><span>العملة</span><select name="currency" defaultValue={current?.currency ?? session.settings.payrollRules.baseCurrency}><option value="IQD">دينار عراقي</option><option value="USD">دولار أمريكي</option></select></label>
            <label className="field"><span>راتب منصة الضمان</span><input name="socialSecurityBase" type="number" min={0} step="0.01" defaultValue={current?.socialSecurityBase ?? ''} /><small>يُستقطع الضمان منه. اتركه فارغاً لغير المسجلين.</small></label>
            <label className="field settings-wide"><span>السبب *</span><input name="reason" required maxLength={500} placeholder="راتب التعيين / زيادة سنوية / ترقية…" /></label>
          </div>
          <details className="overrides">
            <summary>مبالغ ثابتة لمكونات محددة (اختياري)</summary>
            <div className="form-grid">{components.filter((item) => !['per_day', 'per_late_minute', 'per_overtime_hour', 'percentage_of_ss_base', 'loan_installments'].includes(item.calculation)).map((component) => (
              <label className="field" key={component.id}><span>{component.name}</span><input name={`override.${component.id}`} type="number" min={0} step="0.01" defaultValue={current?.componentOverrides?.[component.id] ?? ''} /></label>
            ))}</div>
          </details>
          <div className="dialog-actions"><button className="button button-primary">حفظ</button><button type="button" className="button button-quiet" onClick={() => setOpen(false)}>إلغاء</button></div>
        </form>
      </Dialog>
    </section>
  );
}

interface DayRow {
  workDate: string; shiftName: string | null; firstIn: string | null; lastOut: string | null; status: string; computedStatus: string;
  lateMinutes: number; earlyLeaveMinutes: number; overtimeMinutes: number; leaveTypeName: string | null; taskTitle?: string | null; overridden: boolean;
  overrideReason: string | null; locked: boolean; workedMinutes: number;
}

function AttendanceTab({ employeeId }: { employeeId: string }) {
  const end = today();
  const [from, setFrom] = useState(addDays(end, -30));
  const days = useLoad<DayRow[]>(`/attendance/days?from=${from}&to=${end}&employeeId=${employeeId}`, []);
  const totals = days.data.reduce((sum, day) => ({
    present: sum.present + (day.status === 'present' ? 1 : 0),
    absent: sum.absent + (day.status === 'absent' ? 1 : 0),
    late: sum.late + day.lateMinutes,
    overtime: sum.overtime + day.overtimeMinutes,
  }), { present: 0, absent: 0, late: 0, overtime: 0 });
  return (
    <section className="panel">
      <div className="panel-head"><div><h3>سجل الحضور</h3><p>حضور {totals.present} · غياب {totals.absent} · تأخير {formatMinutes(totals.late)} · إضافي {formatMinutes(totals.overtime)}</p></div>
        <label className="field inline-field"><span>من</span><input type="date" value={from} max={end} onChange={(event) => setFrom(event.target.value)} /></label></div>
      {days.loading ? <Loading /> : days.data.length ? <AttendanceDaysTable rows={days.data} /> :
        <Empty icon={<IdCard size={22} />} title="لا توجد سجلات حضور" text="أسند دواماً للموظف واستورد بصماته، أو اضغط احتساب الحضور من شاشة الحضور." />}
    </section>
  );
}

export function AttendanceDaysTable({ rows, showEmployee = false, onOverride }: {
  rows: Array<DayRow & { employeeName?: string; employeeNo?: string; employeeId?: string }>;
  showEmployee?: boolean;
  onOverride?: (row: DayRow & { employeeId?: string }) => void;
}) {
  return (
    <div className="table-scroll"><table className="dense">
      <thead><tr>{showEmployee && <th>الموظف</th>}<th>اليوم</th><th>الدخول</th><th>الخروج</th><th>الحالة</th><th>تأخير</th><th>خروج مبكر</th><th>إضافي</th>{onOverride && <th />}</tr></thead>
      <tbody>{rows.map((row) => <tr key={`${row.employeeId ?? ''}-${row.workDate}`} className={row.locked ? 'row-locked' : ''}>
        {showEmployee && <td><button className="text-button" onClick={() => row.employeeId && navigate('employees', row.employeeId)}>{row.employeeName}</button><small className="table-sub">{row.employeeNo}</small></td>}
        <td>{new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${row.workDate}T00:00:00`))}</td>
        <td dir="ltr">{row.firstIn ?? '—'}</td>
        <td dir="ltr">{row.lastOut ?? '—'}</td>
        <td><StatusTag map={DAY_STATUS} value={row.status} />{row.leaveTypeName && <small className="table-sub">{row.leaveTypeName}</small>}{row.taskTitle && <small className="table-sub">مهمة: {row.taskTitle}</small>}
          {row.overridden && <small className="table-sub" title={row.overrideReason ?? ''}>معدّل يدوياً (المحتسب: {DAY_STATUS[row.computedStatus]?.label})</small>}</td>
        <td className={row.lateMinutes ? 'num-bad' : ''}>{formatMinutes(row.lateMinutes)}</td>
        <td className={row.earlyLeaveMinutes ? 'num-bad' : ''}>{formatMinutes(row.earlyLeaveMinutes)}</td>
        <td className={row.overtimeMinutes ? 'num-good' : ''}>{formatMinutes(row.overtimeMinutes)}</td>
        {onOverride && <td>{row.locked ? <small className="table-sub">مقفل بالمسير</small> : <button className="text-button" onClick={() => onOverride(row)}>تصحيح</button>}</td>}
      </tr>)}</tbody>
    </table></div>
  );
}

function PayslipsTab({ employeeId }: { employeeId: string }) {
  const history = useLoad<Array<{ runId: string; period: string; status: string; currency: string; totalEarnings: number; totalDeductions: number; netPay: number }>>(
    `/employees/${employeeId}/payslips`, [],
  );
  return (
    <section className="panel">
      <div className="panel-head"><div><h3>قسائم الراتب</h3><p>آخر 36 شهراً.</p></div></div>
      {history.loading ? <Loading /> : history.data.length ? <div className="table-scroll"><table>
        <thead><tr><th>الشهر</th><th>الحالة</th><th>الاستحقاقات</th><th>الاستقطاعات</th><th>الصافي</th><th /></tr></thead>
        <tbody>{history.data.map((row) => <tr key={row.runId}>
          <td><strong>{monthLabel(row.period)}</strong></td>
          <td><StatusTag map={RUN_STATUS} value={row.status} /></td>
          <td>{formatMoney(row.totalEarnings, row.currency)}</td>
          <td>{formatMoney(row.totalDeductions, row.currency)}</td>
          <td><strong>{formatMoney(row.netPay, row.currency)}</strong></td>
          <td><button className="text-button" onClick={() => navigate('payslip', row.runId, employeeId)}><Printer size={14} />القسيمة</button></td>
        </tr>)}</tbody>
      </table></div> : <Empty icon={<CreditCard size={22} />} title="لا توجد قسائم" text="تظهر القسائم بعد احتساب أول مسير يشمل الموظف." />}
    </section>
  );
}

function CardTab({ employee, onIssued }: { employee: EmployeeDetail; onIssued: () => void }) {
  const session = useSession();
  const canIssue = session.can('employees.manage_profile');
  async function issue() {
    if (employee.cardIssuedAt && !window.confirm('إعادة الإصدار تُلغي البطاقة المطبوعة سابقاً ولن يعمل رمزها. متابعة؟')) return;
    try {
      await session.call(`/employees/${employee.id}/card`, { method: 'POST' });
      session.notify('تم إصدار البطاقة.');
      onIssued();
    } catch (error) {
      session.fail(error, 'تعذر إصدار البطاقة.');
    }
  }
  return (
    <section className="panel">
      <div className="panel-head"><div><h3>بطاقة الموظف</h3><p>{employee.cardIssuedAt ? `صدرت في ${formatDateTime(employee.cardIssuedAt)}` : 'لم تصدر بطاقة بعد.'} رمز QR يتحقق من صلاحية البطاقة دون كشف بيانات شخصية.</p></div>
        <div className="heading-actions">
          {canIssue && <button className="button button-quiet" onClick={() => void issue()}>{employee.cardIssuedAt ? 'إعادة إصدار' : 'إصدار البطاقة'}</button>}
          {employee.cardIssuedAt && <button className="button button-primary" onClick={() => navigate('card', employee.id)}><Printer size={16} />معاينة وطباعة</button>}
        </div>
      </div>
      {!employee.hasPhoto && <div className="panel-pad"><Warning title="لا توجد صورة شخصية">أضف صورة من أعلى الملف قبل طباعة البطاقة.</Warning></div>}
      {employee.employmentStatus === 'inactive' && <div className="panel-pad"><Warning title="موظف غير نشط">ستظهر البطاقة كغير صالحة عند التحقق منها.</Warning></div>}
    </section>
  );
}
