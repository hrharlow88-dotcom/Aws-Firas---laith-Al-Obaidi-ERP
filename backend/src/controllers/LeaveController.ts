import { employeeScopeWhere, inScope, isScoped } from '../services/access';
import { Request, Response } from 'express';
import { Includeable, Op, Transaction } from 'sequelize';
import {
  AuditLog,
  Branch,
  Employee,
  LeaveApproval,
  LeaveLedgerEntry,
  LeaveRequest,
  SystemSetting,
  User,
  sequelize,
} from '../models';
import { SystemSettings, normalizeSystemSettings, permissionsFor } from '../config/systemSettings';
import { isDateOnly, isUuid } from '../utils/validation';

const SETTINGS_ID = '00000000-0000-4000-8000-000000000001';
const ACTIVE_REQUEST_STATUSES = ['pending', 'approved'];

async function loadSettings(): Promise<SystemSettings> {
  const record = await SystemSetting.findByPk(SETTINGS_ID);
  return normalizeSystemSettings(record?.value);
}

function workingDayCount(start: string, end: string, settings: SystemSettings): number {
  const workingDays = new Set(settings.leaveRules.workingDays);
  const holidays = new Set(settings.leaveRules.officialHolidays);
  let total = 0;
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= last) {
    const date = cursor.toISOString().slice(0, 10);
    if (workingDays.has(cursor.getUTCDay()) && !holidays.has(date)) total += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return total;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function calendarDayCount(start: string, end: string): number {
  return Math.floor((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86400000) + 1;
}

function completeServiceYears(hireDate: string, today = new Date()): number {
  const hired = new Date(`${hireDate}T00:00:00.000Z`);
  let years = today.getUTCFullYear() - hired.getUTCFullYear();
  const hiredMonth = hired.getUTCMonth();
  const hiredDay = Math.min(
    hired.getUTCDate(),
    new Date(Date.UTC(today.getUTCFullYear(), hiredMonth + 1, 0)).getUTCDate(),
  );
  if (today.getUTCMonth() < hiredMonth ||
    (today.getUTCMonth() === hiredMonth && today.getUTCDate() < hiredDay)) years -= 1;
  return Math.max(0, years);
}

function policyEntitlement(hireDate: string, leaveType: SystemSettings['leaveTypes'][number]): number | null {
  const years = completeServiceYears(hireDate);
  const tier = [...(leaveType.serviceEntitlements || [])]
    .sort((left, right) => right.minimumYears - left.minimumYears)
    .find((item) => years >= item.minimumYears);
  return tier?.days ?? leaveType.annualEntitlement;
}

async function employeeForRequest(employeeId: string, req: Request, transaction?: Transaction) {
  const employee = await Employee.findByPk(employeeId, {
    ...(transaction ? {
      transaction,
      lock: { level: transaction.LOCK.UPDATE, of: Employee },
    } : {}),
    include: [{ model: Branch, as: 'branch', attributes: ['id', 'name', 'city'] }],
  });
  if (!employee) return null;
  if (!(await inScope(req, employee.id, transaction))) return null;
  return employee;
}

async function balanceTotals(employeeId: string, leaveTypeId: string, exceptRequestId?: string, transaction?: Transaction) {
  const ledger = await LeaveLedgerEntry.sum('quantity', { where: { employeeId, leaveTypeId }, transaction });
  const pendingWhere = {
    employeeId,
    leaveTypeId,
    status: 'pending' as const,
    ...(exceptRequestId ? { id: { [Op.ne]: exceptRequestId } } : {}),
  };
  const pendingRequests = await LeaveRequest.findAll({ where: pendingWhere, attributes: ['quantity'], transaction });
  const pending = pendingRequests.reduce((sum, item) => sum + Number(item.quantity), 0);
  const balance = Number(ledger || 0);
  return { balance, pending, available: balance - pending };
}

function audit(req: Request, action: string, entityType: string, entityId: string) {
  return {
    userId: req.user!.id,
    action,
    entityType,
    entityId,
  };
}

export class LeaveController {
  static async listRequests(req: Request, res: Response): Promise<void> {
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    if (status && !['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
      res.status(400).json({ message: 'حالة الطلب المحددة غير صالحة.' });
      return;
    }
    const employeeInclude: Includeable = {
      model: Employee,
      as: 'employee',
      attributes: ['id', 'employeeNo', 'fullName', 'branchId', 'department', 'position'],
      include: [{ model: Branch, as: 'branch', attributes: ['id', 'name', 'city'] }],
      ...(isScoped(req) ? { where: employeeScopeWhere(req), required: true } : {}),
    };
    const requests = await LeaveRequest.findAll({
      where: status ? { status } : undefined,
      include: [
        employeeInclude,
        { model: LeaveApproval, as: 'approvals', include: [{ model: User, as: 'approver', attributes: ['id', 'name'] }] },
      ],
      order: [['createdAt', 'DESC']],
      limit: 250,
    });
    const settings = await loadSettings();
    const data = requests.map((request) => {
      const leaveType = settings.leaveTypes.find((item) => item.id === request.leaveTypeId);
      return { ...request.toJSON(), leaveTypeName: leaveType?.name || 'نوع إجازة محذوف', leaveUnit: leaveType?.unit || 'days' };
    });
    res.json({ data });
  }

  static async balances(req: Request, res: Response): Promise<void> {
    const employeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId : '';
    if (!isUuid(employeeId)) {
      res.status(400).json({ message: 'اختر موظفاً لعرض أرصدة إجازاته.' });
      return;
    }
    const employee = await employeeForRequest(employeeId, req);
    if (!employee) {
      res.status(404).json({ message: 'الموظف غير موجود ضمن نطاق فرعك.' });
      return;
    }
    const settings = await loadSettings();
    const data = await Promise.all(settings.leaveTypes.filter((type) => type.active && type.deductsBalance !== false).map(async (type) => ({
      leaveTypeId: type.id,
      leaveTypeName: type.name,
      unit: type.unit,
      policyEntitlement: policyEntitlement(employee.hireDate, type),
      completeServiceYears: completeServiceYears(employee.hireDate),
      ...(await balanceTotals(employeeId, type.id)),
    })));
    res.json({ data: { employee: { id: employee.id, employeeNo: employee.employeeNo, fullName: employee.fullName }, balances: data } });
  }

  static async ledger(req: Request, res: Response): Promise<void> {
    const employeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId : '';
    if (!isUuid(employeeId)) {
      res.status(400).json({ message: 'اختر موظفاً لعرض سجل حركات رصيده.' });
      return;
    }
    const employee = await employeeForRequest(employeeId, req);
    if (!employee) {
      res.status(404).json({ message: 'الموظف غير موجود ضمن نطاق فرعك.' });
      return;
    }
    const entries = await LeaveLedgerEntry.findAll({
      where: { employeeId },
      order: [['createdAt', 'DESC']],
      limit: 250,
    });
    const settings = await loadSettings();
    res.json({
      data: entries.map((entry) => ({
        ...entry.toJSON(),
        leaveTypeName: settings.leaveTypes.find((type) => type.id === entry.leaveTypeId)?.name || 'نوع إجازة محذوف',
      })),
    });
  }

  static async createRequest(req: Request, res: Response): Promise<void> {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const allowed = ['employeeId', 'leaveTypeId', 'startsOn', 'endsOn', 'reason', 'substituteName', 'startTime', 'endTime', 'medicalCertificateReference'];
    if (Object.keys(body).some((key) => !allowed.includes(key))) {
      res.status(400).json({ message: 'يتضمن الطلب حقلاً غير مدعوم.' });
      return;
    }
    const { employeeId, leaveTypeId, startsOn, endsOn, reason } = body;
    if (!isUuid(employeeId) || !isUuid(leaveTypeId) || !isDateOnly(startsOn) || !isDateOnly(endsOn) ||
      typeof reason !== 'string' || !reason.trim() || reason.length > 1000 ||
      (body.substituteName !== undefined && (typeof body.substituteName !== 'string' || body.substituteName.length > 180)) ||
      (body.medicalCertificateReference !== undefined &&
        (typeof body.medicalCertificateReference !== 'string' || body.medicalCertificateReference.trim().length > 180))) {
      res.status(400).json({ message: 'أكمل الموظف ونوع الإجازة والتواريخ وسبب الطلب بصورة صحيحة.' });
      return;
    }
    if (startsOn > endsOn) {
      res.status(400).json({ message: 'تاريخ نهاية الإجازة يجب أن يكون في يوم البداية أو بعده.' });
      return;
    }
    const settings = await loadSettings();
    const leaveType = settings.leaveTypes.find((item) => item.id === leaveTypeId && item.active);
    if (!leaveType) {
      res.status(400).json({ message: 'نوع الإجازة غير موجود أو غير مفعّل. راجع إعدادات النظام.' });
      return;
    }
    if (leaveType.requiresMedicalCertificate &&
      (typeof body.medicalCertificateReference !== 'string' || !body.medicalCertificateReference.trim())) {
      res.status(400).json({ message: 'أدخل مرجع التقرير الطبي المعتمد قبل إرسال طلب الإجازة المرضية.' });
      return;
    }
    if (!settings.approvalSteps.length) {
      res.status(409).json({ message: 'لا يمكن إرسال الطلب قبل إعداد خطوة موافقة واحدة على الأقل.' });
      return;
    }
    if (new Set(settings.approvalSteps.map((step) => step.role)).size !== settings.approvalSteps.length) {
      res.status(409).json({ message: 'تتضمن خطوات الموافقة دوراً مكرراً. صحح التسلسل في الإعدادات أولاً.' });
      return;
    }
    const approvalRoles = settings.approvalSteps.map((step) => step.role);
    if (approvalRoles.some((role) => !settings.roles[role].permissions.includes('leaves.approve'))) {
      res.status(409).json({ message: 'أحد أدوار الموافقة لا يملك صلاحية اعتماد الإجازات. راجع الأدوار أولاً.' });
      return;
    }
    const initialEmployee = await employeeForRequest(String(employeeId), req);
    if (!initialEmployee || initialEmployee.employmentStatus !== 'active') {
      res.status(400).json({ message: 'اختر موظفاً نشطاً ضمن الفرع المسموح.' });
      return;
    }
    let quantity: number;
    let startTime: string | null = null;
    let endTime: string | null = null;
    if (leaveType.unit === 'hours') {
      const startMinutes = parseTime(body.startTime);
      const endMinutes = parseTime(body.endTime);
      if (startsOn !== endsOn || startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
        res.status(400).json({ message: 'الإجازة بالساعات تكون في يوم واحد وبوقت نهاية بعد وقت البداية.' });
        return;
      }
      if (workingDayCount(String(startsOn), String(endsOn), settings) !== 1) {
        res.status(400).json({ message: 'لا يمكن طلب إجازة بالساعات في يوم عطلة أو يوم غير عامل.' });
        return;
      }
      quantity = (endMinutes - startMinutes) / 60;
      if (quantity > settings.leaveRules.maxHoursPerRequest) {
        res.status(400).json({ message: 'مدة الإجازة تتجاوز الحد المسموح به للطلب الواحد.' });
        return;
      }
      startTime = String(body.startTime);
      endTime = String(body.endTime);
    } else {
      if (body.startTime !== undefined || body.endTime !== undefined) {
        res.status(400).json({ message: 'حقول الوقت مخصصة لأنواع الإجازة المحتسبة بالساعات.' });
        return;
      }
      quantity = leaveType.dayCountBasis === 'calendar'
        ? calendarDayCount(String(startsOn), String(endsOn))
        : workingDayCount(String(startsOn), String(endsOn), settings);
      if (quantity <= 0) {
        res.status(400).json({ message: 'الفترة المحددة لا تتضمن أيام عمل وفق تقويم الشركة.' });
        return;
      }
      if (Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`) > 366 * 86400000) {
        res.status(400).json({ message: 'الفترة تتجاوز الحد المسموح به للطلب الواحد.' });
        return;
      }
    }

    const created = await sequelize.transaction(async (transaction) => {
      const employee = await employeeForRequest(String(employeeId), req, transaction);
      if (!employee || employee.employmentStatus !== 'active') throw new Error('EMPLOYEE_UNAVAILABLE');
      const overlappingRequests = await LeaveRequest.findAll({
        where: {
          employeeId: employee.id,
          status: { [Op.in]: ACTIVE_REQUEST_STATUSES },
          startsOn: { [Op.lte]: endsOn },
          endsOn: { [Op.gte]: startsOn },
        },
        transaction,
      });
      const collision = overlappingRequests.some((request) => {
        const existingType = settings.leaveTypes.find((item) => item.id === request.leaveTypeId);
        if (leaveType.unit !== 'hours' || existingType?.unit !== 'hours') return true;
        const existingStart = request.startTime?.slice(0, 5) || '';
        const existingEnd = request.endTime?.slice(0, 5) || '';
        return String(body.startTime) < existingEnd && String(body.endTime) > existingStart;
      });
      if (collision) throw new Error('LEAVE_DATE_OVERLAP');
      if (leaveType.unit === 'hours') {
        const year = String(startsOn).slice(0, 4);
        const month = String(startsOn).slice(5, 7);
        const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).toISOString().slice(0, 10);
        const monthlyRequests = await LeaveRequest.findAll({
          where: {
            employeeId: employee.id,
            leaveTypeId: { [Op.in]: settings.leaveTypes.filter((type) => type.unit === 'hours').map((type) => type.id) },
            status: { [Op.in]: ACTIVE_REQUEST_STATUSES },
            startsOn: { [Op.between]: [`${year}-${month}-01`, lastDay] },
          },
          attributes: ['quantity'],
          transaction,
        });
        if (monthlyRequests.length >= settings.leaveRules.hourlyMonthlyUsageLimit ||
          monthlyRequests.reduce((sum, item) => sum + Number(item.quantity), 0) + quantity > settings.leaveRules.hourlyMonthlyQuota) {
          throw new Error('HOURLY_LEAVE_LIMIT');
        }
      }
      if (leaveType.deductsBalance !== false) {
        const totals = await balanceTotals(employee.id, String(leaveTypeId), undefined, transaction);
        if (totals.available + 0.0001 < quantity) throw new Error('INSUFFICIENT_LEAVE_BALANCE');
      }
      const leaveRequest = await LeaveRequest.create({
        employeeId: employee.id,
        leaveTypeId: String(leaveTypeId),
        startsOn: String(startsOn),
        endsOn: String(endsOn),
        startTime,
        endTime,
        quantity: quantity.toFixed(2),
        reason: reason.trim(),
        substituteName: typeof body.substituteName === 'string' ? body.substituteName.trim() || null : null,
        medicalCertificateReference: typeof body.medicalCertificateReference === 'string'
          ? body.medicalCertificateReference.trim() || null
          : null,
        status: 'pending',
        approvalRoles,
        approvalStepIndex: 0,
        submittedBy: req.user!.id,
      }, { transaction });
      await LeaveApproval.create({
        requestId: leaveRequest.id,
        stepIndex: -1,
        role: req.user!.role,
        userId: req.user!.id,
        action: 'approved',
        note: null,
      }, { transaction });
      await AuditLog.create(audit(req, 'leave.requested', 'leave_request', leaveRequest.id), { transaction });
      return leaveRequest;
    }).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      const messages: Record<string, string> = {
        EMPLOYEE_UNAVAILABLE: 'الموظف غير نشط أو لم يعد ضمن الفرع المسموح.',
        LEAVE_DATE_OVERLAP: 'لدى الموظف طلب إجازة معلّق أو معتمد يتداخل مع هذه الفترة.',
        HOURLY_LEAVE_LIMIT: 'تجاوز الطلب حصة الإجازة بالساعات الشهرية أو عدد مرات الاستخدام.',
        INSUFFICIENT_LEAVE_BALANCE: 'الرصيد المتاح غير كافٍ. أضف الرصيد الافتتاحي أو راجع الحركات.',
      };
      if (messages[error.message]) {
        const status = error.message === 'LEAVE_DATE_OVERLAP' || error.message === 'HOURLY_LEAVE_LIMIT' ? 409 : 400;
        res.status(status).json({ message: messages[error.message] });
        return null;
      }
      throw error;
    });
    if (created) res.status(201).json({ data: created });
  }

  static async decide(req: Request, res: Response): Promise<void> {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const requestedAction = body.action;
    const note = body.note;
    if (Object.keys(body).some((key) => !['action', 'note'].includes(key)) ||
      (requestedAction !== 'approve' && requestedAction !== 'reject') ||
      (note !== undefined && (typeof note !== 'string' || note.length > 1000)) ||
      (requestedAction === 'reject' && (typeof note !== 'string' || !note.trim()))) {
      res.status(400).json({ message: 'اختر اعتماداً أو رفضاً وأدخل سبب الرفض عند الحاجة.' });
      return;
    }
    const result = await sequelize.transaction(async (transaction) => {
      const request = await LeaveRequest.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!request) return { status: 404, message: 'طلب الإجازة غير موجود.' };
      const employee = await employeeForRequest(request.employeeId, req, transaction);
      if (!employee) return { status: 404, message: 'الموظف غير موجود ضمن نطاق فرعك.' };
      if (request.status !== 'pending') return { status: 409, message: 'هذا الطلب ليس بانتظار الموافقة.' };
      const requiredRole = request.approvalRoles[request.approvalStepIndex];
      if (req.user!.role !== 'super_admin' && req.user!.role !== requiredRole) {
        return { status: 403, message: 'هذا الطلب بانتظار دور موافقة آخر.' };
      }
      // Nobody approves their own leave, whatever their role.
      if (req.user!.employeeId && req.user!.employeeId === request.employeeId) {
        return { status: 403, message: 'لا يمكنك اعتماد أو رفض طلب إجازتك.' };
      }
      const action = requestedAction === 'approve' ? 'approved' : 'rejected';
      const isFinalApproval = action === 'approved' && request.approvalStepIndex + 1 >= request.approvalRoles.length;
      let deductsBalance = true;
      if (isFinalApproval) {
        const settings = await loadSettings();
        const leaveType = settings.leaveTypes.find((item) => item.id === request.leaveTypeId && item.active);
        if (!leaveType) return { status: 409, message: 'نوع الإجازة عُطّل بعد إرسال الطلب؛ أعد تفعيله قبل الاعتماد.' };
        deductsBalance = leaveType.deductsBalance !== false;
        if (deductsBalance) {
          const totals = await balanceTotals(request.employeeId, request.leaveTypeId, request.id, transaction);
          if (totals.available + 0.0001 < Number(request.quantity)) {
            return { status: 409, message: 'انخفض الرصيد المتاح أثناء سير الموافقات. عدّل الرصيد أو ارفض الطلب.' };
          }
        }
      }
      await LeaveApproval.create({
        requestId: request.id,
        stepIndex: request.approvalStepIndex,
        role: req.user!.role,
        userId: req.user!.id,
        action,
        note: typeof note === 'string' ? note.trim() || null : null,
      }, { transaction });
      if (action === 'rejected') {
        await request.update({ status: 'rejected', decidedAt: new Date() }, { transaction });
      } else if (request.approvalStepIndex + 1 < request.approvalRoles.length) {
        await request.update({ approvalStepIndex: request.approvalStepIndex + 1 }, { transaction });
      } else {
        if (deductsBalance) {
          await LeaveLedgerEntry.create({
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId,
            quantity: (-Number(request.quantity)).toFixed(2),
            entryType: 'taken',
            requestId: request.id,
            reason: `صرف إجازة معتمدة: ${request.startsOn} إلى ${request.endsOn}`,
            createdBy: req.user!.id,
          }, { transaction });
        }
        await request.update({ status: 'approved', decidedAt: new Date() }, { transaction });
      }
      await AuditLog.create(audit(req, `leave.${action}`, 'leave_request', request.id), { transaction });
      return { status: 200, data: request };
    });
    if ('message' in result) {
      res.status(result.status).json({ message: result.message });
      return;
    }
    res.json({ data: result.data });
  }

  static async cancel(req: Request, res: Response): Promise<void> {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    if (Object.keys(body).some((key) => key !== 'reason') ||
      (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 1000))) {
      res.status(400).json({ message: 'سبب الإلغاء غير صالح.' });
      return;
    }
    const result = await sequelize.transaction(async (transaction) => {
      const request = await LeaveRequest.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!request) return { status: 404, message: 'طلب الإجازة غير موجود.' };
      const employee = await employeeForRequest(request.employeeId, req, transaction);
      if (!employee) return { status: 404, message: 'الموظف غير موجود ضمن نطاق فرعك.' };
      const settings = await loadSettings();
      const userPermissions = permissionsFor(req.user!.role, settings);
      const canCancelAny = userPermissions.includes('leaves.manage_balances');
      if (request.submittedBy !== req.user!.id && !canCancelAny) return { status: 403, message: 'يمكن لمنشئ الطلب أو مدير الموارد البشرية إلغاؤه.' };
      if (!['pending', 'approved'].includes(request.status)) return { status: 409, message: 'لا يمكن إلغاء طلب مرفوض أو ملغى.' };
      if (request.status === 'approved') {
        if (!canCancelAny) return { status: 403, message: 'إلغاء إجازة معتمدة يتطلب صلاحية مدير الموارد البشرية.' };
        if (settings.leaveTypes.find((item) => item.id === request.leaveTypeId)?.deductsBalance !== false) {
          await LeaveLedgerEntry.create({
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId,
            quantity: Number(request.quantity).toFixed(2),
            entryType: 'reversal',
            requestId: request.id,
            reason: typeof body.reason === 'string' ? body.reason.trim() || 'عكس صرف طلب ملغى' : 'عكس صرف طلب ملغى',
            createdBy: req.user!.id,
          }, { transaction });
        }
      }
      await request.update({ status: 'cancelled', decidedAt: new Date() }, { transaction });
      await AuditLog.create(audit(req, 'leave.cancelled', 'leave_request', request.id), { transaction });
      return { status: 200, data: request };
    });
    if ('message' in result) {
      res.status(result.status).json({ message: result.message });
      return;
    }
    res.json({ data: result.data });
  }

  static async adjustBalance(req: Request, res: Response): Promise<void> {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const employeeId = body.employeeId;
    const leaveTypeId = body.leaveTypeId;
    const quantity = body.quantity;
    const entryType = body.entryType;
    const reason = body.reason;
    if (Object.keys(body).some((key) => !['employeeId', 'leaveTypeId', 'quantity', 'entryType', 'reason'].includes(key)) ||
      !isUuid(employeeId) || !isUuid(leaveTypeId) ||
      typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity === 0 || Math.abs(quantity) > 10000 ||
      (entryType !== 'opening' && entryType !== 'adjustment') ||
      typeof reason !== 'string' || !reason.trim() || reason.length > 1000) {
      res.status(400).json({ message: 'أكمل الموظف ونوع الإجازة وكمية الحركة وسببها بصورة صحيحة.' });
      return;
    }
    const settings = await loadSettings();
    if (!settings.leaveTypes.some((item) => item.id === leaveTypeId && item.deductsBalance !== false)) {
      res.status(400).json({ message: 'نوع الإجازة غير موجود في إعدادات النظام.' });
      return;
    }
    const result = await sequelize.transaction(async (transaction) => {
      const employee = await employeeForRequest(employeeId, req, transaction);
      if (!employee) return { status: 404, message: 'الموظف غير موجود ضمن نطاق فرعك.' };
      if (entryType === 'opening') {
        const existingOpening = await LeaveLedgerEntry.findOne({
          where: { employeeId: employee.id, leaveTypeId, entryType: 'opening' },
          transaction,
        });
        if (existingOpening) return { status: 409, message: 'يوجد رصيد افتتاحي مسجل لهذا الموظف ونوع الإجازة.' };
      }
      const totals = await balanceTotals(employee.id, leaveTypeId, undefined, transaction);
      if (totals.available + quantity < -0.0001) {
        return { status: 400, message: 'لا يمكن أن يؤدي التعديل إلى رصيد متاح سالب.' };
      }
      const entry = await LeaveLedgerEntry.create({
        employeeId: employee.id,
        leaveTypeId,
        quantity: quantity.toFixed(2),
        entryType,
        requestId: null,
        reason: reason.trim(),
        createdBy: req.user!.id,
      }, { transaction });
      await AuditLog.create(audit(req, 'leave.balance_adjusted', 'leave_ledger_entry', entry.id), { transaction });
      return { status: 201, data: entry };
    });
    if ('message' in result) {
      res.status(result.status).json({ message: result.message });
      return;
    }
    res.status(result.status).json({ data: result.data });
  }
}

export default LeaveController;
