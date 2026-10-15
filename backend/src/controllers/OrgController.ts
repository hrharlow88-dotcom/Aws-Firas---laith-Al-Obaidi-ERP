import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { execute, insertRow, select, selectOne, setClause, transaction } from '../db/query';
import { recordAudit } from '../utils/audit';
import {
  assertOnlyKeys, badRequest, body, conflict, notFound, optionalNumber, optionalText, requiredText,
} from '../utils/http';
import { isUuid } from '../utils/validation';
import { employeeScopeSql } from '../services/access';
import { applyOrgPlan, orgTemplate, planOrgImport } from '../services/orgImport';
import { isXlsx } from '../services/punchParser';
import { uploadedName } from '../services/storage';

interface DepartmentRow {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  branchId: string | null;
  managerEmployeeId: string | null;
  costCenterCode: string | null;
  sortOrder: number;
  isActive: boolean;
}

const DEPARTMENT_COLUMNS = {
  code: 'code',
  name: 'name',
  parentId: 'parent_id',
  branchId: 'branch_id',
  managerEmployeeId: 'manager_employee_id',
  costCenterCode: 'cost_center_code',
  sortOrder: 'sort_order',
  isActive: 'is_active',
};

const JOB_TITLE_COLUMNS = {
  code: 'code',
  name: 'name',
  departmentId: 'department_id',
  grade: 'grade',
  description: 'description',
  isActive: 'is_active',
};

function optionalUuid(input: Record<string, unknown>, key: string): string | null | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!isUuid(value)) throw badRequest('معرّف غير صالح.', { field: key });
  return value;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw badRequest('قيمة غير صالحة.', { field: key });
  return value;
}

function code(input: Record<string, unknown>, required: boolean): string | undefined {
  const value = required ? requiredText(input, 'code', 24, 'الرمز') : optionalText(input, 'code', 24) ?? undefined;
  if (value !== undefined && !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw badRequest('الرمز يقبل الحروف الإنجليزية والأرقام والنقطة والشرطة فقط.', { field: 'code' });
  }
  return value?.toUpperCase();
}

async function departmentInput(input: Record<string, unknown>, creating: boolean) {
  assertOnlyKeys(input, Object.keys(DEPARTMENT_COLUMNS));
  const values = {
    code: code(input, creating),
    name: creating ? requiredText(input, 'name', 120, 'اسم القسم') : optionalText(input, 'name', 120) ?? undefined,
    parentId: optionalUuid(input, 'parentId'),
    branchId: optionalUuid(input, 'branchId'),
    managerEmployeeId: optionalUuid(input, 'managerEmployeeId'),
    costCenterCode: optionalText(input, 'costCenterCode', 40),
    sortOrder: optionalNumber(input, 'sortOrder', { min: 0, max: 10000, integer: true }) ?? undefined,
    isActive: optionalBoolean(input, 'isActive'),
  };
  if (values.parentId && !(await selectOne('SELECT 1 FROM departments WHERE id = :id', { id: values.parentId }))) {
    throw badRequest('القسم الأعلى غير موجود.');
  }
  if (values.branchId && !(await selectOne('SELECT 1 FROM branches WHERE id = :id', { id: values.branchId }))) {
    throw badRequest('الفرع المحدد غير موجود.');
  }
  if (values.managerEmployeeId && !(await selectOne('SELECT 1 FROM employees WHERE id = :id', { id: values.managerEmployeeId }))) {
    throw badRequest('مدير القسم المحدد غير موجود.');
  }
  return values;
}

/** True when making `parentId` the parent of `id` would close a loop. */
async function createsCycle(id: string, parentId: string): Promise<boolean> {
  const rows = await select<{ id: string }>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id FROM departments WHERE id = :parentId
       UNION ALL
       SELECT d.id, d.parent_id FROM departments d JOIN ancestors a ON d.id = a.parent_id
     )
     SELECT id FROM ancestors WHERE id = :id LIMIT 1`,
    { id, parentId },
  );
  return rows.length > 0;
}

export class OrgController {
  static async listDepartments(_req: Request, res: Response): Promise<void> {
    const rows = await select<DepartmentRow & { employeeCount: number; managerName: string | null; branchName: string | null }>(
      `SELECT d.id, d.code, d.name, d.parent_id AS "parentId", d.branch_id AS "branchId",
              d.manager_employee_id AS "managerEmployeeId", d.cost_center_code AS "costCenterCode",
              d.sort_order AS "sortOrder", d.is_active AS "isActive",
              m.full_name AS "managerName", b.name AS "branchName",
              (SELECT count(*)::int FROM employees e WHERE e.department_id = d.id AND e.employment_status <> 'inactive') AS "employeeCount"
       FROM departments d
       LEFT JOIN employees m ON m.id = d.manager_employee_id
       LEFT JOIN branches b ON b.id = d.branch_id
       ORDER BY d.sort_order, d.name`,
    );
    res.json({ data: rows });
  }

  static async createDepartment(req: Request, res: Response): Promise<void> {
    const values = await departmentInput(body(req), true);
    const id = randomUUID();
    await transaction(async (tx) => {
      await insertRow('departments', { id, ...values }, { id: 'id', ...DEPARTMENT_COLUMNS }, tx);
      await recordAudit(req, tx, 'department.created', 'department', id, { code: values.code, name: values.name });
    });
    res.status(201).json({ data: { id } });
  }

  static async updateDepartment(req: Request, res: Response): Promise<void> {
    const id = req.params.id;
    const existing = await selectOne<DepartmentRow>('SELECT id FROM departments WHERE id = :id', { id });
    if (!existing) throw notFound('القسم غير موجود.');
    const values = await departmentInput(body(req), false);
    if (values.parentId && (values.parentId === id || await createsCycle(id, values.parentId))) {
      throw conflict('لا يمكن جعل القسم تابعاً لأحد أقسامه الفرعية.');
    }
    if (values.isActive === false) {
      const active = await selectOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM employees WHERE department_id = :id AND employment_status <> 'inactive'`,
        { id },
      );
      if (active && active.count > 0) throw conflict('انقل موظفي القسم قبل تعطيله.');
    }
    const { sql, params } = setClause(values, DEPARTMENT_COLUMNS);
    if (!sql) throw badRequest('أرسل حقلاً واحداً على الأقل لتحديثه.');
    await transaction(async (tx) => {
      await execute(`UPDATE departments SET ${sql}, updated_at = now() WHERE id = :id`, { id, ...params }, tx);
      if (values.name) {
        // Keep the denormalized department label on employees in sync.
        await execute('UPDATE employees SET department = :name, updated_at = now() WHERE department_id = :id', { id, name: values.name }, tx);
      }
      await recordAudit(req, tx, 'department.updated', 'department', id, values as Record<string, unknown>);
    });
    res.json({ data: { id } });
  }

  static async listJobTitles(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT j.id, j.code, j.name, j.department_id AS "departmentId", j.grade, j.description,
              j.is_active AS "isActive", d.name AS "departmentName",
              (SELECT count(*)::int FROM employees e WHERE e.job_title_id = j.id AND e.employment_status <> 'inactive') AS "employeeCount"
       FROM job_titles j LEFT JOIN departments d ON d.id = j.department_id
       ORDER BY j.name`,
    );
    res.json({ data: rows });
  }

  static async createJobTitle(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, Object.keys(JOB_TITLE_COLUMNS));
    const values = {
      code: code(input, true),
      name: requiredText(input, 'name', 120, 'المسمى الوظيفي'),
      departmentId: optionalUuid(input, 'departmentId') ?? null,
      grade: optionalText(input, 'grade', 20) ?? null,
      description: optionalText(input, 'description', 2000) ?? null,
    };
    if (values.departmentId && !(await selectOne('SELECT 1 FROM departments WHERE id = :id', { id: values.departmentId }))) {
      throw badRequest('القسم المحدد غير موجود.');
    }
    const id = randomUUID();
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO job_titles (id, code, name, department_id, grade, description)
         VALUES (:id, :code, :name, :departmentId, :grade, :description)`,
        { id, ...values },
        tx,
      );
      await recordAudit(req, tx, 'job_title.created', 'job_title', id, { code: values.code, name: values.name });
    });
    res.status(201).json({ data: { id } });
  }

  static async updateJobTitle(req: Request, res: Response): Promise<void> {
    const id = req.params.id;
    if (!(await selectOne('SELECT 1 FROM job_titles WHERE id = :id', { id }))) throw notFound('المسمى الوظيفي غير موجود.');
    const input = body(req);
    assertOnlyKeys(input, Object.keys(JOB_TITLE_COLUMNS));
    const values = {
      code: code(input, false),
      name: optionalText(input, 'name', 120) ?? undefined,
      departmentId: optionalUuid(input, 'departmentId'),
      grade: optionalText(input, 'grade', 20),
      description: optionalText(input, 'description', 2000),
      isActive: optionalBoolean(input, 'isActive'),
    };
    const { sql, params } = setClause(values, JOB_TITLE_COLUMNS);
    if (!sql) throw badRequest('أرسل حقلاً واحداً على الأقل لتحديثه.');
    await transaction(async (tx) => {
      await execute(`UPDATE job_titles SET ${sql}, updated_at = now() WHERE id = :id`, { id, ...params }, tx);
      if (values.name) {
        await execute('UPDATE employees SET "position" = :name, updated_at = now() WHERE job_title_id = :id', { id, name: values.name }, tx);
      }
      await recordAudit(req, tx, 'job_title.updated', 'job_title', id, values as Record<string, unknown>);
    });
    res.json({ data: { id } });
  }

  /** Departments plus the people in them, for the org chart view. */
  static async chart(req: Request, res: Response): Promise<void> {
    const scope = employeeScopeSql(req);
    const [departments, employees] = await Promise.all([
      select(
        `SELECT id, code, name, parent_id AS "parentId", manager_employee_id AS "managerEmployeeId", sort_order AS "sortOrder"
         FROM departments WHERE is_active ORDER BY sort_order, name`,
      ),
      select(
        `SELECT e.id, e.employee_no AS "employeeNo", e.full_name AS "fullName", e.department_id AS "departmentId",
                e.manager_id AS "managerId", COALESCE(j.name, e."position") AS "jobTitle",
                e.photo_document_id IS NOT NULL AS "hasPhoto", b.name AS "branchName"
         FROM employees e
         LEFT JOIN job_titles j ON j.id = e.job_title_id
         JOIN branches b ON b.id = e.branch_id
         WHERE e.employment_status <> 'inactive'${scope.sql}
         ORDER BY e.full_name`,
        scope.params,
      ),
    ]);
    res.json({ data: { departments, employees } });
  }

  /** Excel sheet of the current structure, for HR to edit and upload back. */
  static async importTemplate(req: Request, res: Response): Promise<void> {
    const workbook = await orgTemplate();
    await recordAudit(req, null, 'org.template_exported', 'organization', null);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="org-structure.xlsx"');
    res.setHeader('Cache-Control', 'private, no-store');
    await workbook.xlsx.write(res);
    res.end();
  }

  /** Reads the uploaded sheet and reports every change and problem; writes nothing. */
  static async importPreview(req: Request, res: Response): Promise<void> {
    const plan = await readPlan(req);
    res.json({ data: { rows: plan.rows, newJobTitles: plan.newJobTitles, summary: plan.summary } });
  }

  /** Applies the same sheet after review. Refused while any row has an error. */
  static async importApply(req: Request, res: Response): Promise<void> {
    const count = await transaction(async (tx) => {
      // Re-read inside the transaction so the plan reflects what is in the database now.
      const plan = await readPlan(req, tx);
      if (plan.summary.errors) throw badRequest(`في الملف ${plan.summary.errors} سطر بأخطاء. صححها ثم أعد المعاينة.`);
      if (!plan.updates.size) throw badRequest('لا توجد تغييرات لاعتمادها.');
      const updated = await applyOrgPlan(plan, tx);
      await recordAudit(req, tx, 'org.structure_imported', 'organization', null, {
        file: uploadedName(req.file!, 'org.xlsx'), employees: updated, managerChanges: plan.summary.managerChanges,
        newJobTitles: plan.newJobTitles,
        changes: plan.rows.filter((row) => row.changes.length).slice(0, 400).map((row) => ({ employeeNo: row.employeeNo, changes: row.changes })),
      });
      return updated;
    });
    res.json({ data: { updated: count } });
  }
}

export default OrgController;

async function readPlan(req: Request, tx?: import('sequelize').Transaction) {
  const file = req.file;
  if (!file || !isXlsx(file.buffer)) throw badRequest('ارفع ملف Excel (.xlsx) بنفس أعمدة نموذج الهيكل.');
  try {
    return await planOrgImport(file.buffer, tx);
  } catch (error) {
    if (error instanceof Error && error.message === 'NO_EMPLOYEE_COLUMN') throw badRequest('لم يُعثر على عمود «رقم الموظف». استخدم نموذج الهيكل المنزّل من النظام.');
    if (error instanceof Error && error.message === 'EMPTY') throw badRequest('الملف فارغ.');
    throw error;
  }
}
