import { FormEvent, useEffect, useState } from 'react';
import { Check, Clock3, Plus, RefreshCw, X } from 'lucide-react';
import type { SystemSettings, UserRole } from './SettingsPage';

interface EmployeeOption {
  id: string;
  employeeNo: string;
  fullName: string;
  employmentStatus: 'active' | 'inactive' | 'on_leave';
  hireDate: string;
  branch?: { name: string };
}

interface LeaveRequest {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  leaveUnit: 'days' | 'hours';
  startsOn: string;
  endsOn: string;
  startTime: string | null;
  endTime: string | null;
  quantity: string;
  reason: string;
  medicalCertificateReference: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  submittedBy: string;
  approvalRoles: UserRole[];
  approvalStepIndex: number;
  employee: EmployeeOption;
  approvals: Array<{
    stepIndex: number;
    role: UserRole;
    action: 'approved' | 'rejected';
    note: string | null;
    approver?: { name: string };
    createdAt?: string;
  }>;
}

interface Balance {
  leaveTypeId: string;
  leaveTypeName: string;
  unit: 'days' | 'hours';
  balance: number;
  pending: number;
  available: number;
  policyEntitlement: number | null;
  completeServiceYears: number;
}

interface LedgerEntry {
  id: string;
  leaveTypeName: string;
  quantity: string;
  entryType: 'opening' | 'adjustment' | 'taken' | 'reversal' | 'accrual';
  reason: string;
  createdAt: string;
}

interface ApiResult<T> { data: T; }
interface Props {
  token: string;
  userId: string;
  userRole: UserRole;
  settings: SystemSettings;
  canRequest: boolean;
  canApprove: boolean;
  canManageBalances: boolean;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}

const statusLabels: Record<LeaveRequest['status'], string> = {
  pending: 'بانتظار الموافقة',
  approved: 'معتمد',
  rejected: 'مرفوض',
  cancelled: 'ملغى',
};

const entryLabels: Record<LedgerEntry['entryType'], string> = {
  opening: 'رصيد افتتاحي',
  adjustment: 'تسوية',
  taken: 'إجازة مصروفة',
  reversal: 'عكس حركة',
  accrual: 'استحقاق شهري',
};

async function api<T>(path: string, token: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'تعذر إكمال الطلب.');
  return result as T;
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { dateStyle: 'medium' }).format(new Date(`${value}T00:00:00`));
}

export function LeavePage({ token, userId, userRole, settings, canRequest, canApprove, canManageBalances, onError, onSuccess }: Props) {
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    const timeout = window.setTimeout(() => {
      api<{ data: EmployeeOption[] }>(`/employees?page=1&pageSize=100${employeeSearch ? `&search=${encodeURIComponent(employeeSearch)}` : ''}`, token)
        .then((result) => {
          if (!current) return;
          setEmployees(result.data);
          const activeEmployees = result.data.filter((employee) => employee.employmentStatus === 'active');
          setEmployeeId((existing) => activeEmployees.some((employee) => employee.id === existing)
            ? existing
            : activeEmployees[0]?.id || '');
        })
        .catch((cause: unknown) => { if (current) onError(cause instanceof Error ? cause.message : 'تعذر تحميل الموظفين.'); });
    }, 180);
    return () => { current = false; window.clearTimeout(timeout); };
  }, [token, employeeSearch, onError]);

  async function loadRequests() {
    const result = await api<ApiResult<LeaveRequest[]>>(`/leaves${statusFilter ? `?status=${statusFilter}` : ''}`, token);
    setRequests(result.data);
  }

  async function loadEmployeeLeaveData(id: string) {
    if (!id) {
      setBalances([]);
      setLedger([]);
      return;
    }
    const [balanceResult, ledgerResult] = await Promise.all([
      api<ApiResult<{ balances: Balance[] }>>(`/leaves/balances?employeeId=${encodeURIComponent(id)}`, token),
      api<ApiResult<LedgerEntry[]>>(`/leaves/ledger?employeeId=${encodeURIComponent(id)}`, token),
    ]);
    setBalances(balanceResult.data.balances);
    setLedger(ledgerResult.data);
  }

  useEffect(() => {
    loadRequests().catch((cause: unknown) => onError(cause instanceof Error ? cause.message : 'تعذر تحميل طلبات الإجازات.'));
  }, [token, statusFilter, onError]);

  useEffect(() => {
    loadEmployeeLeaveData(employeeId).catch((cause: unknown) => onError(cause instanceof Error ? cause.message : 'تعذر تحميل أرصدة الإجازات.'));
  }, [token, employeeId, onError]);

  async function refresh() {
    setBusy(true);
    try {
      await Promise.all([loadRequests(), loadEmployeeLeaveData(employeeId)]);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'تعذر تحديث بيانات الإجازات.');
    } finally {
      setBusy(false);
    }
  }

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const typeId = String(form.get('leaveTypeId') || '');
    const leaveType = settings.leaveTypes.find((item) => item.id === typeId);
    const body: Record<string, unknown> = {
      employeeId,
      leaveTypeId: typeId,
      startsOn: form.get('startsOn'),
      endsOn: form.get('endsOn'),
      reason: form.get('reason'),
      substituteName: form.get('substituteName'),
    };
    if (leaveType?.requiresMedicalCertificate) body.medicalCertificateReference = form.get('medicalCertificateReference');
    if (leaveType?.unit === 'hours') {
      body.startTime = form.get('startTime');
      body.endTime = form.get('endTime');
    }
    setBusy(true);
    try {
      await api('/leaves', token, 'POST', body);
      formElement.reset();
      setLeaveTypeId('');
      onSuccess('تم إرسال طلب الإجازة إلى مسار الموافقات.');
      await Promise.all([loadRequests(), loadEmployeeLeaveData(employeeId)]);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'تعذر إرسال طلب الإجازة.');
    } finally {
      setBusy(false);
    }
  }

  async function decide(request: LeaveRequest, action: 'approve' | 'reject') {
    const note = action === 'reject' ? window.prompt('أدخل سبب رفض الطلب:') : '';
    if (action === 'reject' && (!note || !note.trim())) return;
    setBusy(true);
    try {
      await api(`/leaves/${request.id}/decision`, token, 'POST', { action, ...(note ? { note } : {}) });
      onSuccess(action === 'approve' ? 'تم تسجيل الموافقة.' : 'تم رفض الطلب.');
      await Promise.all([loadRequests(), loadEmployeeLeaveData(employeeId)]);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'تعذر معالجة الطلب.');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(request: LeaveRequest) {
    if (!window.confirm('هل تريد إلغاء طلب الإجازة؟')) return;
    setBusy(true);
    try {
      await api(`/leaves/${request.id}/cancel`, token, 'POST', { reason: 'إلغاء من شاشة إدارة الإجازات' });
      onSuccess('تم إلغاء الطلب وتسجيل عكس الرصيد عند الحاجة.');
      await Promise.all([loadRequests(), loadEmployeeLeaveData(employeeId)]);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'تعذر إلغاء الطلب.');
    } finally {
      setBusy(false);
    }
  }

  async function adjustBalance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    try {
      await api('/leaves/balances', token, 'POST', {
        employeeId,
        leaveTypeId: form.get('leaveTypeId'),
        quantity: Number(form.get('quantity')),
        entryType: form.get('entryType'),
        reason: form.get('reason'),
      });
      formElement.reset();
      onSuccess('تم تسجيل حركة الرصيد.');
      await loadEmployeeLeaveData(employeeId);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'تعذر تعديل الرصيد.');
    } finally {
      setBusy(false);
    }
  }

  const selectedType = settings.leaveTypes.find((type) => type.id === leaveTypeId);
  const selectedEmployee = employees.find((employee) => employee.id === employeeId);
  const roleLabels = settings.roles;

  return (
    <section className="screen leave-screen">
      <div className="screen-heading">
        <div><h2>إدارة الإجازات</h2><p>الطلبات والموافقات والأرصدة وسجل الحركات مع نطاق صلاحية الفرع.</p></div>
        <button className="button button-quiet" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} />تحديث</button>
      </div>

      <div className="panel leave-toolbar">
        <label className="field"><span>ابحث عن موظف</span><input value={employeeSearch} onChange={(event) => setEmployeeSearch(event.target.value)} placeholder="الاسم أو الرقم الوظيفي" /></label>
        <label className="field"><span>الموظف المحدد</span><select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
          <option value="">اختر موظفاً</option>
          {employees.filter((employee) => employee.employmentStatus === 'active').map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName} · {employee.employeeNo}{employee.branch?.name ? ` · ${employee.branch.name}` : ''}</option>)}
        </select></label>
        <label className="field"><span>تصفية الطلبات</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="">كل الحالات</option><option value="pending">بانتظار الموافقة</option><option value="approved">معتمد</option><option value="rejected">مرفوض</option><option value="cancelled">ملغى</option>
        </select></label>
      </div>

      {canRequest && <form className="panel leave-form" onSubmit={(event) => void submitRequest(event)}>
        <div className="panel-head"><div><h3>طلب إجازة جديد</h3><p>{selectedEmployee ? `${selectedEmployee.fullName} · ${selectedEmployee.branch?.name || 'الفرع'}` : 'حدد الموظف أولاً.'}</p></div></div>
        <div className="form-grid">
          <label className="field"><span>نوع الإجازة *</span><select name="leaveTypeId" required value={leaveTypeId} onChange={(event) => setLeaveTypeId(event.target.value)}><option value="" disabled>اختر النوع</option>{settings.leaveTypes.filter((type) => type.active).map((type) => <option value={type.id} key={type.id}>{type.name} ({type.unit === 'hours' ? 'ساعات' : 'أيام'})</option>)}</select></label>
          <label className="field"><span>تاريخ البداية *</span><input name="startsOn" type="date" required /></label>
          <label className="field"><span>تاريخ النهاية *</span><input name="endsOn" type="date" required /></label>
          {selectedType?.unit === 'hours' && <>
            <label className="field"><span>وقت البداية *</span><input name="startTime" type="time" required /></label>
            <label className="field"><span>وقت النهاية *</span><input name="endTime" type="time" required /></label>
          </>}
          {selectedType?.requiresMedicalCertificate && <label className="field"><span>مرجع التقرير الطبي الحكومي المعتمد *</span><input name="medicalCertificateReference" required maxLength={180} /></label>}
          <label className="field"><span>البديل (اختياري)</span><input name="substituteName" maxLength={180} /></label>
          <label className="field leave-wide"><span>سبب الطلب *</span><input name="reason" required maxLength={1000} /></label>
        </div>
        <div className="form-actions"><button className="button button-primary" disabled={busy || !employeeId}><Plus size={15} />إرسال الطلب</button></div>
      </form>}

      <section className="panel">
        <div className="panel-head"><div><h3>طلبات الإجازة</h3><p>{requests.length.toLocaleString('ar-IQ-u-nu-latn')} طلباً (حتى 250 طلباً)</p></div></div>
        {requests.length ? <div className="table-scroll"><table className="leave-table">
          <thead><tr><th>الموظف</th><th>نوع الإجازة</th><th>الفترة</th><th>المدة</th><th>الحالة</th><th>الخطوة التالية</th><th>الإجراء</th></tr></thead>
          <tbody>{requests.map((request) => {
            const requiredRole = request.approvalRoles[request.approvalStepIndex];
            const mayApprove = canApprove && request.status === 'pending' && (userRole === 'super_admin' || userRole === requiredRole);
            const mayCancel = request.status === 'pending' || (request.status === 'approved' && canManageBalances);
            return <tr key={request.id}>
              <td><strong>{request.employee.fullName}</strong><span className="table-sub">{request.employee.branch?.name || request.employee.employeeNo}</span></td>
              <td>{request.leaveTypeName}</td>
              <td>{dateLabel(request.startsOn)}{request.endsOn !== request.startsOn ? ` – ${dateLabel(request.endsOn)}` : ''}{request.startTime && <span className="table-sub">{request.startTime.slice(0, 5)} – {request.endTime?.slice(0, 5)}</span>}</td>
              <td>{Number(request.quantity).toLocaleString('ar-IQ-u-nu-latn')} {request.leaveUnit === 'hours' ? 'س' : 'يوم'}</td>
              <td><span className={`leave-status leave-${request.status}`}>{statusLabels[request.status]}</span></td>
              <td>{request.status === 'pending' && requiredRole ? roleLabels[requiredRole].label : '—'}</td>
              <td><div className="leave-actions">
                {mayApprove && <><button className="icon-link" aria-label="اعتماد" title="اعتماد" disabled={busy} onClick={() => void decide(request, 'approve')}><Check size={15} /></button><button className="icon-link leave-reject" aria-label="رفض" title="رفض" disabled={busy} onClick={() => void decide(request, 'reject')}><X size={15} /></button></>}
                {mayCancel && (request.submittedBy === userId || canManageBalances) && <button className="text-button" disabled={busy} onClick={() => void cancel(request)}>إلغاء</button>}
              </div>
                <details className="leave-detail"><summary>التفاصيل</summary><div><p>{request.reason}</p>{request.medicalCertificateReference && <p>مرجع التقرير الطبي: {request.medicalCertificateReference}</p>}{request.approvals.map((approval, index) => <p key={`${approval.stepIndex}-${index}`}>{approval.approver?.name || roleLabels[approval.role].label}: {approval.action === 'approved' ? 'موافقة' : 'رفض'}{approval.note ? ` — ${approval.note}` : ''}</p>)}</div></details></td>
            </tr>;
          })}</tbody>
        </table></div> : <div className="empty-state"><div className="empty-icon"><Clock3 size={19} /></div><strong>لا توجد طلبات بهذه التصفية</strong><p>ستظهر الطلبات هنا مع سجل الموافقات وحالتها الحالية.</p></div>}
      </section>

      {employeeId && <div className="leave-data-grid">
        <section className="panel">
          <div className="panel-head"><div><h3>الأرصدة المتاحة</h3><p>{selectedEmployee?.fullName || 'الموظف المحدد'} · الاستحقاق السنوي مرجعي، والمتاح يُحسب من دفتر الحركات بعد حجز المعلّق.</p></div></div>
          {balances.length ? <div className="table-scroll"><table><thead><tr><th>نوع الإجازة</th><th>استحقاق مرجعي</th><th>الرصيد الدفتري</th><th>معلق</th><th>متاح</th></tr></thead><tbody>
            {balances.map((balance) => <tr key={balance.leaveTypeId}><td>{balance.leaveTypeName}</td><td>{balance.policyEntitlement === null ? '—' : <span>{balance.policyEntitlement.toLocaleString('ar-IQ-u-nu-latn')} يوم<span className="table-sub">وفق {balance.completeServiceYears.toLocaleString('ar-IQ-u-nu-latn')} سنة خدمة · مرجعي</span></span>}</td><td>{balance.balance.toLocaleString('ar-IQ-u-nu-latn')}</td><td>{balance.pending.toLocaleString('ar-IQ-u-nu-latn')}</td><td><strong className={balance.available <= settings.leaveRules.lowBalanceThreshold ? 'low-balance' : ''}>{balance.available.toLocaleString('ar-IQ-u-nu-latn')} {balance.unit === 'hours' ? 'س' : 'يوم'}</strong></td></tr>)}
          </tbody></table></div> : <div className="table-loading">لا توجد أنواع إجازة مفعّلة لعرضها.</div>}
          {canManageBalances && <form className="balance-form" onSubmit={(event) => void adjustBalance(event)}>
            <strong>تسجيل حركة رصيد</strong>
            <label className="field"><span>نوع الإجازة</span><select name="leaveTypeId" required defaultValue=""><option value="" disabled>اختر</option>{settings.leaveTypes.filter((type) => type.deductsBalance !== false).map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
            <label className="field"><span>الكمية (+/-)</span><input name="quantity" type="number" step="0.25" min="-10000" max="10000" required /></label>
            <label className="field"><span>نوع الحركة</span><select name="entryType"><option value="opening">رصيد افتتاحي</option><option value="adjustment">تسوية</option></select></label>
            <label className="field"><span>السبب</span><input name="reason" maxLength={1000} required /></label>
            <button className="button button-quiet" disabled={busy}>حفظ الحركة</button>
          </form>}
        </section>
        <section className="panel">
          <div className="panel-head"><div><h3>سجل حركات الرصيد</h3><p>آخر 250 حركة موثقة لهذا الموظف.</p></div></div>
          {ledger.length ? <div className="table-scroll"><table><thead><tr><th>التاريخ</th><th>النوع</th><th>الكمية</th><th>السبب</th></tr></thead><tbody>
            {ledger.map((entry) => <tr key={entry.id}><td>{new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { dateStyle: 'medium' }).format(new Date(entry.createdAt))}</td><td>{entryLabels[entry.entryType]} · {entry.leaveTypeName}</td><td>{Number(entry.quantity).toLocaleString('ar-IQ-u-nu-latn')}</td><td>{entry.reason}</td></tr>)}
          </tbody></table></div> : <div className="table-loading">لا توجد حركات رصيد مسجلة.</div>}
        </section>
      </div>}
    </section>
  );
}
