import { Request, Response } from 'express';
import { Op, Order } from 'sequelize';
import { Branch, Employee, SystemSetting } from '../models';
import type { EmployeeAttributes } from '../models';
import { DEFAULT_SYSTEM_SETTINGS } from '../config/systemSettings';
import { audited, diffFields } from '../utils/audit';
import { ORG_FIELDS, resolveOrgFields } from '../services/employeeOrg';
import { isDateOnly, isUuid } from '../utils/validation';

function maySeeEmployeeContact(role: string | undefined): boolean {
  return ['super_admin', 'hr_manager', 'hr_staff', 'branch_manager'].includes(role || '');
}

function maySeeEmployeeCustomFields(role: string | undefined): boolean {
  return ['super_admin', 'hr_manager', 'hr_staff'].includes(role || '');
}

export class EmployeeController {
  static async list(req: Request, res: Response): Promise<void> {
    if (req.user?.role === 'branch_manager' && !req.user.branchId) {
      res.json({ data: [], pagination: { total: 0, page: 1, pageSize: 25 } });
      return;
    }
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const branchId = req.user?.role === 'branch_manager' ? req.user.branchId : req.query.branchId;
    if (branchId && !isUuid(branchId)) {
      res.status(400).json({ message: 'معرّف الفرع غير صالح.' });
      return;
    }
    const where = {
      ...(branchId ? { branchId: String(branchId) } : {}),
      ...(search
        ? {
            [Op.or]: [
              { fullName: { [Op.iLike]: `%${search}%` } },
              { employeeNo: { [Op.iLike]: `%${search}%` } },
              { department: { [Op.iLike]: `%${search}%` } },
              { position: { [Op.iLike]: `%${search}%` } },
            ],
          }
        : {}),
    };
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
    const isRecent = req.query.recent === '1';
    const order: Order = isRecent ? [['hireDate', 'DESC'], ['fullName', 'ASC']] : [['fullName', 'ASC']];
    const attributes: Array<keyof EmployeeAttributes> | undefined = req.user?.role === 'branch_manager'
      ? ['id', 'employeeNo', 'fullName', 'email', 'phone', 'branchId', 'department', 'position', 'employmentStatus', 'hireDate']
      : maySeeEmployeeContact(req.user?.role)
        ? undefined
        : ['id', 'employeeNo', 'fullName', 'branchId', 'department', 'position', 'employmentStatus', 'hireDate'];

    const result = await Employee.findAndCountAll({
      where,
      attributes,
      include: [{ model: Branch, as: 'branch', attributes: ['id', 'code', 'name', 'city'] }],
      order,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    res.json({ data: result.rows, pagination: { total: result.count, page, pageSize } });
  }

  static async summary(req: Request, res: Response): Promise<void> {
    if (req.user?.role === 'branch_manager' && !req.user.branchId) {
      res.json({ data: { total: 0, active: 0, onLeave: 0, inactive: 0 } });
      return;
    }
    const branchId = req.user?.role === 'branch_manager' ? req.user.branchId : undefined;
    const scope = branchId ? { branchId } : undefined;
    const [total, active, onLeave] = await Promise.all([
      Employee.count({ where: scope }),
      Employee.count({ where: { ...(scope || {}), employmentStatus: 'active' } }),
      Employee.count({ where: { ...(scope || {}), employmentStatus: 'on_leave' } }),
    ]);
    res.json({ data: { total, active, onLeave, inactive: total - active - onLeave } });
  }

  static async create(req: Request, res: Response): Promise<void> {
    const input = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    if (Object.keys(input).some((field) => ![
      'employeeNo', 'fullName', 'email', 'phone', 'branchId', 'department', 'position', 'hireDate', 'customFields', ...ORG_FIELDS,
    ].includes(field))) {
      res.status(400).json({ message: 'يتضمن الطلب حقلاً غير قابل للتعديل.' });
      return;
    }
    const org = await resolveOrgFields(input);
    if (org.department) input.department = org.department;
    if (org.position) input.position = org.position;
    const required = ['employeeNo', 'fullName', 'branchId', 'department', 'position', 'hireDate'];
    if (required.some((field) => typeof input[field] !== 'string' || !String(input[field]).trim())) {
      res.status(400).json({ message: 'أكمل رقم الموظف والاسم والفرع والقسم والمنصب وتاريخ التعيين.' });
      return;
    }
    if (!isDateOnly(input.hireDate)) {
      res.status(400).json({ message: 'أدخل تاريخ تعيين صحيحاً بصيغة سنة-شهر-يوم.' });
      return;
    }
    if (!isUuid(input.branchId)) {
      res.status(400).json({ message: 'معرّف الفرع غير صالح.' });
      return;
    }
    if (req.user?.role === 'branch_manager' && input.branchId !== req.user.branchId) {
      res.status(403).json({ message: 'لا يمكنك إضافة موظف إلى فرع آخر.' });
      return;
    }
    const branch = await Branch.findByPk(String(input.branchId));
    if (!branch || !branch.isActive) {
      res.status(400).json({ message: 'اختر فرعاً نشطاً وصحيحاً.' });
      return;
    }
    const settingsRecord = await SystemSetting.findByPk('00000000-0000-4000-8000-000000000001');
    const employeeFields = (settingsRecord?.value || DEFAULT_SYSTEM_SETTINGS).employeeFields.filter((field) => field.enabled);
    const customFields = input.customFields === undefined ? {} : input.customFields;
    if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) {
      res.status(400).json({ message: 'تحقق من الحقول الإضافية للموظف.' });
      return;
    }
    const customValues = customFields as Record<string, unknown>;
    if (
      Object.keys(customValues).some((key) => !employeeFields.some((field) => field.key === key)) ||
      employeeFields.some((field) => field.required && (typeof customValues[field.key] !== 'string' && typeof customValues[field.key] !== 'number' || String(customValues[field.key]).trim() === '')) ||
      employeeFields.some((field) => {
        const value = customValues[field.key];
        if (value === undefined || value === null || value === '') return false;
        if (field.type === 'text') return typeof value !== 'string' || value.length > 500;
        if (field.type === 'number') return typeof value !== 'number' || !Number.isFinite(value);
        if (field.type === 'date') return typeof value !== 'string' || !isDateOnly(value);
        return typeof value !== 'string' || !field.options.includes(value);
      })
    ) {
      res.status(400).json({ message: 'تحقق من الحقول الإضافية المطلوبة وأنواع بياناتها.' });
      return;
    }
    const employee = await audited(req.user!.id, 'employee.created', 'employee', (transaction) => Employee.create({
      employeeNo: String(input.employeeNo).trim(),
      fullName: String(input.fullName).trim(),
      email: typeof input.email === 'string' ? input.email.trim() || null : null,
      phone: typeof input.phone === 'string' ? input.phone.trim() || null : null,
      branchId: branch.id,
      department: String(input.department).trim(),
      position: String(input.position).trim(),
      hireDate: String(input.hireDate),
      customFields: customValues as Record<string, string | number>,
      departmentId: org.departmentId ?? null,
      jobTitleId: org.jobTitleId ?? null,
      managerId: org.managerId ?? null,
      employmentType: org.employmentType ?? 'permanent',
      attendancePin: org.attendancePin ?? null,
      shiftId: org.shiftId ?? null,
      terminationDate: org.terminationDate ?? null,
    }, { transaction }));
    if (!maySeeEmployeeCustomFields(req.user?.role)) {
      const { customFields: _customFields, ...safeEmployee } = employee.toJSON();
      res.status(201).json({ data: safeEmployee });
      return;
    }
    res.status(201).json({ data: employee });
  }

  static async update(req: Request, res: Response): Promise<void> {
    const employee = await Employee.findByPk(req.params.id);
    if (!employee) {
      res.status(404).json({ message: 'الموظف غير موجود.' });
      return;
    }
    if (req.user?.role === 'branch_manager' && employee.branchId !== req.user.branchId) {
      res.status(403).json({ message: 'لا يمكنك تعديل بيانات موظف من فرع آخر.' });
      return;
    }
    const input = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const editableFields = ['employeeNo', 'fullName', 'email', 'phone', 'branchId', 'department', 'position', 'hireDate', 'employmentStatus', ...ORG_FIELDS];
    if (Object.keys(input).some((field) => !editableFields.includes(field))) {
      res.status(400).json({ message: 'يتضمن الطلب حقلاً غير قابل للتعديل.' });
      return;
    }
    // Fields that change pay are reserved for HR even when a branch manager may edit the record.
    const payrollAffecting = ['hireDate', 'terminationDate', 'employmentType', 'shiftId', 'attendancePin'];
    if (req.user?.role === 'branch_manager' && payrollAffecting.some((field) => input[field] !== undefined)) {
      res.status(403).json({ message: 'تاريخ التعيين وترك الخدمة ونوع التوظيف والدوام ورقم البصمة تعدلها الموارد البشرية فقط.' });
      return;
    }
    if (
      ['employeeNo', 'fullName', 'email', 'phone', 'branchId', 'department', 'position', 'hireDate']
        .some((field) => input[field] !== undefined && typeof input[field] !== 'string')
    ) {
      res.status(400).json({ message: 'تحقق من نوع الحقول النصية المدخلة.' });
      return;
    }
    if (
      input.employmentStatus !== undefined &&
      !['active', 'inactive', 'on_leave'].includes(String(input.employmentStatus))
    ) {
      res.status(400).json({ message: 'حالة الموظف المحددة غير صالحة.' });
      return;
    }
    const updates: {
      employeeNo?: string;
      fullName?: string;
      email?: string | null;
      phone?: string | null;
      branchId?: string;
      department?: string;
      position?: string;
      hireDate?: string;
      employmentStatus?: Employee['employmentStatus'];
      departmentId?: string | null;
      jobTitleId?: string | null;
      managerId?: string | null;
      employmentType?: Employee['employmentType'];
      attendancePin?: string | null;
      shiftId?: string | null;
      terminationDate?: string | null;
    } = {};
    const org = await resolveOrgFields(input, employee.id);
    for (const field of ORG_FIELDS) {
      if (org[field] !== undefined) (updates as Record<string, unknown>)[field] = org[field];
    }
    if (org.department) input.department = org.department;
    if (org.position) input.position = org.position;
    if (typeof input.employeeNo === 'string') updates.employeeNo = input.employeeNo.trim();
    if (typeof input.fullName === 'string') updates.fullName = input.fullName.trim();
    if (typeof input.email === 'string') updates.email = input.email.trim() || null;
    if (typeof input.phone === 'string') updates.phone = input.phone.trim() || null;
    if (typeof input.branchId === 'string') updates.branchId = input.branchId.trim();
    if (typeof input.department === 'string') updates.department = input.department.trim();
    if (typeof input.position === 'string') updates.position = input.position.trim();
    if (typeof input.hireDate === 'string') updates.hireDate = input.hireDate.trim();
    if (['active', 'inactive', 'on_leave'].includes(String(input.employmentStatus))) {
      updates.employmentStatus = input.employmentStatus as Employee['employmentStatus'];
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ message: 'أرسل حقلاً واحداً على الأقل لتحديثه.' });
      return;
    }
    if ([updates.employeeNo, updates.fullName, updates.department, updates.position]
      .some((value) => value !== undefined && !value)) {
      res.status(400).json({ message: 'لا يمكن ترك رقم الموظف أو الاسم أو القسم أو المنصب فارغاً.' });
      return;
    }
    if (updates.hireDate !== undefined && !isDateOnly(updates.hireDate)) {
      res.status(400).json({ message: 'أدخل تاريخ تعيين صحيحاً بصيغة سنة-شهر-يوم.' });
      return;
    }
    if (updates.branchId !== undefined && !isUuid(updates.branchId)) {
      res.status(400).json({ message: 'معرّف الفرع غير صالح.' });
      return;
    }
    if (req.user?.role === 'branch_manager' && updates.branchId !== undefined && updates.branchId !== req.user.branchId) {
      res.status(403).json({ message: 'لا يمكنك نقل الموظف إلى فرع آخر.' });
      return;
    }
    if (updates.branchId !== undefined) {
      const branch = await Branch.findByPk(String(updates.branchId));
      if (!branch || !branch.isActive) {
        res.status(400).json({ message: 'اختر فرعاً نشطاً وصحيحاً.' });
        return;
      }
    }
    const before = employee.toJSON() as unknown as Record<string, unknown>;
    const updatedEmployee = await audited(
      req.user!.id,
      'employee.updated',
      'employee',
      (transaction) => employee.update(updates, { transaction }),
      { changes: diffFields(before, updates as Record<string, unknown>) },
    );
    if (!maySeeEmployeeCustomFields(req.user?.role)) {
      const { customFields: _customFields, ...safeEmployee } = updatedEmployee.toJSON();
      res.json({ data: safeEmployee });
      return;
    }
    res.json({ data: updatedEmployee });
  }
}

export default EmployeeController;
