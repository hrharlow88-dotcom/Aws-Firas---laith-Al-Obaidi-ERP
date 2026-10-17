import { EMPLOYMENT_TYPES, EmploymentType } from '../models';
import { select, selectOne } from '../db/query';
import { badRequest, conflict } from '../utils/http';
import { isDateOnly, isUuid } from '../utils/validation';

export const ORG_FIELDS = [
  'departmentId', 'jobTitleId', 'managerId', 'employmentType', 'attendancePin', 'shiftId', 'terminationDate',
] as const;

export interface OrgFieldValues {
  departmentId?: string | null;
  department?: string;
  jobTitleId?: string | null;
  position?: string;
  managerId?: string | null;
  employmentType?: EmploymentType;
  attendancePin?: string | null;
  shiftId?: string | null;
  terminationDate?: string | null;
}

function uuidOrNull(input: Record<string, unknown>, key: string): string | null | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!isUuid(value)) throw badRequest('معرّف غير صالح.', { field: key });
  return value;
}

/**
 * Validates the organizational fields of an employee and resolves the
 * department and job title names, which are also kept as text on the
 * employee for screens and exports from phase one.
 */
export async function resolveOrgFields(input: Record<string, unknown>, employeeId?: string): Promise<OrgFieldValues> {
  const values: OrgFieldValues = {
    departmentId: uuidOrNull(input, 'departmentId'),
    jobTitleId: uuidOrNull(input, 'jobTitleId'),
    managerId: uuidOrNull(input, 'managerId'),
    shiftId: uuidOrNull(input, 'shiftId'),
  };
  if (values.departmentId) {
    const department = await selectOne<{ name: string; isActive: boolean }>(
      'SELECT name, is_active AS "isActive" FROM departments WHERE id = :id', { id: values.departmentId },
    );
    if (!department || !department.isActive) throw badRequest('اختر قسماً نشطاً وصحيحاً.');
    values.department = department.name;
  }
  if (values.jobTitleId) {
    const title = await selectOne<{ name: string; isActive: boolean }>(
      'SELECT name, is_active AS "isActive" FROM job_titles WHERE id = :id', { id: values.jobTitleId },
    );
    if (!title || !title.isActive) throw badRequest('اختر مسمى وظيفياً نشطاً وصحيحاً.');
    values.position = title.name;
  }
  if (values.shiftId) {
    const shift = await selectOne('SELECT 1 FROM shifts WHERE id = :id AND is_active', { id: values.shiftId });
    if (!shift) throw badRequest('اختر دواماً نشطاً وصحيحاً.');
  }
  if (values.managerId) {
    if (values.managerId === employeeId) throw badRequest('لا يمكن أن يكون الموظف مديراً لنفسه.');
    const manager = await selectOne('SELECT 1 FROM employees WHERE id = :id', { id: values.managerId });
    if (!manager) throw badRequest('المدير المباشر المحدد غير موجود.');
    if (employeeId) {
      // Refuse A → B → A loops in the reporting line.
      const loop = await select(
        `WITH RECURSIVE chain AS (
           SELECT id, manager_id, 1 AS depth FROM employees WHERE id = :managerId
           UNION ALL
           SELECT e.id, e.manager_id, c.depth + 1 FROM employees e JOIN chain c ON e.id = c.manager_id WHERE c.depth < 50
         ) SELECT 1 FROM chain WHERE id = :employeeId LIMIT 1`,
        { managerId: values.managerId, employeeId },
      );
      if (loop.length) throw conflict('هذا التعيين يجعل الموظف مديراً لمديره.');
    }
  }
  if (input.employmentType !== undefined) {
    if (!EMPLOYMENT_TYPES.includes(input.employmentType as EmploymentType)) throw badRequest('نوع التوظيف غير صالح.');
    values.employmentType = input.employmentType as EmploymentType;
  }
  if (input.attendancePin !== undefined) {
    const pin = input.attendancePin === null ? '' : String(input.attendancePin).trim();
    if (pin && !/^[A-Za-z0-9_-]{1,40}$/.test(pin)) throw badRequest('رقم البصمة يقبل أرقاماً وحروفاً إنجليزية فقط.');
    values.attendancePin = pin || null;
  }
  if (input.terminationDate !== undefined) {
    if (input.terminationDate !== null && input.terminationDate !== '' && !isDateOnly(input.terminationDate)) {
      throw badRequest('أدخل تاريخ ترك الخدمة بصيغة سنة-شهر-يوم.');
    }
    values.terminationDate = (input.terminationDate || null) as string | null;
  }
  return values;
}
