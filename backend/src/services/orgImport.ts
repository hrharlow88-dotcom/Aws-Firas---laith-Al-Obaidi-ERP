import ExcelJS from 'exceljs';
import { Transaction } from 'sequelize';
import { randomUUID } from 'node:crypto';
import { execute, select } from '../db/query';
import { loadWorkbook } from './xlsx';

/**
 * Bulk update of who reports to whom, departments, positions and branches
 * from one Excel sheet. HR downloads the sheet filled with today's data, edits
 * it, uploads it, sees every change and every problem, and only then applies.
 * Nothing is written while any row has an error.
 */

export const ORG_COLUMNS = [
  { key: 'employeeNo', header: 'رقم الموظف', width: 12 },
  { key: 'fullName', header: 'الاسم (للمرجع فقط)', width: 30 },
  { key: 'managerNo', header: 'رقم المدير المباشر', width: 16 },
  { key: 'managerName', header: 'اسم المدير (للمرجع فقط)', width: 28 },
  { key: 'department', header: 'القسم', width: 26 },
  { key: 'section', header: 'الشعبة', width: 24 },
  { key: 'position', header: 'المسمى الوظيفي', width: 28 },
  { key: 'branch', header: 'الفرع', width: 22 },
] as const;

interface Current {
  id: string; employeeNo: string; fullName: string; managerId: string | null; departmentId: string | null;
  jobTitleId: string | null; branchId: string; status: string;
}
interface Department { id: string; code: string; name: string; parentId: string | null }
interface Named { id: string; code: string; name: string }

export type ChangeField = 'manager' | 'department' | 'position' | 'branch';
export interface RowResult {
  row: number;
  employeeNo: string;
  employeeId: string | null;
  fullName: string | null;
  changes: Array<{ field: ChangeField; from: string | null; to: string | null }>;
  errors: string[];
  warnings: string[];
}
export interface OrgPlan {
  rows: RowResult[];
  newJobTitles: string[];
  summary: { rows: number; changed: number; unchanged: number; errors: number; managerChanges: number };
  /** Resolved values to write, per employee. */
  updates: Map<string, { managerId?: string | null; departmentId?: string; jobTitleId?: string | null; jobTitleName?: string; branchId?: string }>;
}

const norm = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
const key = (value: unknown) => norm(value).toLowerCase();
const cellText = (value: ExcelJS.CellValue): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('richText' in value) return value.richText.map((part) => part.text).join('');
    if ('text' in value) return String(value.text);
    return '';
  }
  return String(value).replace(/\.0+$/, '');
};

async function reference(transaction?: Transaction) {
  const [employees, departments, titles, branches] = await Promise.all([
    select<Current>(
      `SELECT id, employee_no AS "employeeNo", full_name AS "fullName", manager_id AS "managerId",
              department_id AS "departmentId", job_title_id AS "jobTitleId", branch_id AS "branchId",
              employment_status AS status
       FROM employees`, {}, transaction,
    ),
    select<Department>('SELECT id, code, name, parent_id AS "parentId" FROM departments WHERE is_active', {}, transaction),
    select<Named>('SELECT id, code, name FROM job_titles WHERE is_active', {}, transaction),
    select<Named>('SELECT id, code, name FROM branches WHERE is_active', {}, transaction),
  ]);
  return { employees, departments, titles, branches };
}

/** The sheet HR edits, filled with the current structure. */
export async function orgTemplate(): Promise<ExcelJS.Workbook> {
  const { employees, departments, titles, branches } = await reference();
  const byId = new Map(employees.map((item) => [item.id, item]));
  const dept = new Map(departments.map((item) => [item.id, item]));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('الهيكل', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  sheet.columns = ORG_COLUMNS.map((column) => ({ header: column.header, key: column.key, width: column.width }));
  for (const employee of [...employees].filter((item) => item.status !== 'inactive').sort((a, b) => a.employeeNo.localeCompare(b.employeeNo))) {
    const own = employee.departmentId ? dept.get(employee.departmentId) : undefined;
    const parent = own?.parentId ? dept.get(own.parentId) : undefined;
    const manager = employee.managerId ? byId.get(employee.managerId) : undefined;
    sheet.addRow({
      employeeNo: employee.employeeNo,
      fullName: employee.fullName,
      managerNo: manager?.employeeNo ?? '',
      managerName: manager?.fullName ?? '',
      department: parent ? parent.name : own?.name ?? '',
      section: parent ? own?.name ?? '' : '',
      position: titles.find((item) => item.id === employee.jobTitleId)?.name ?? '',
      branch: branches.find((item) => item.id === employee.branchId)?.name ?? '',
    });
  }
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D1B1F' } };
  for (const column of ['B', 'D']) sheet.getColumn(column).font = { color: { argb: 'FF8A817C' } };

  const help = workbook.addWorksheet('تعليمات', { views: [{ rightToLeft: true }] });
  help.columns = [{ width: 110 }];
  [
    'عدّل الأعمدة: رقم المدير المباشر، القسم، الشعبة، المسمى الوظيفي، الفرع. عمودا الاسم واسم المدير للمرجع ولا يُقرآن.',
    'اترك الخلية كما هي إذا لا تريد تغييرها. اكتب «-» في رقم المدير لإزالة المدير المباشر.',
    'القسم والشعبة والفرع تُكتب بالاسم كما في النظام (القوائم في الأوراق التالية) أو بالرمز.',
    'المسمى غير الموجود يُنشأ تلقائياً ويظهر في المعاينة قبل الحفظ.',
    'ارفع الملف من «الأقسام والهيكل ← استيراد من Excel». لا يُحفظ شيء قبل أن تراجع المعاينة وتضغط «اعتماد التغييرات»، ولا يُحفظ أي سطر إذا وُجد خطأ في الملف.',
  ].forEach((line) => help.addRow([line]));
  const lists = workbook.addWorksheet('القوائم', { views: [{ rightToLeft: true }] });
  lists.columns = [{ header: 'الأقسام والشعب', width: 40 }, { header: 'الرمز', width: 14 }, { header: 'الفروع', width: 28 }, { header: 'الرمز', width: 14 }];
  const sortedDepts = [...departments].sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0) || a.name.localeCompare(b.name));
  const rows = Math.max(sortedDepts.length, branches.length);
  for (let index = 0; index < rows; index += 1) {
    const d = sortedDepts[index];
    const b = branches[index];
    lists.addRow([
      d ? (d.parentId ? `   ${dept.get(d.parentId)?.name ?? ''} / ${d.name}` : d.name) : '', d?.code ?? '', b?.name ?? '', b?.code ?? '',
    ]);
  }
  lists.getRow(1).font = { bold: true };
  return workbook;
}

/** Reads the uploaded sheet and works out every change, without writing anything. */
export async function planOrgImport(buffer: Buffer, transaction?: Transaction): Promise<OrgPlan> {
  const workbook = await loadWorkbook(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('EMPTY');
  const header = (sheet.getRow(1).values as ExcelJS.CellValue[]).map((value) => norm(cellText(value)));
  const column = (label: string) => header.findIndex((value) => value === label);
  const col = Object.fromEntries(ORG_COLUMNS.map((item) => [item.key, column(item.header)])) as Record<(typeof ORG_COLUMNS)[number]['key'], number>;
  if (col.employeeNo < 0) throw new Error('NO_EMPLOYEE_COLUMN');

  const { employees, departments, titles, branches } = await reference(transaction);
  const byNo = new Map(employees.map((item) => [item.employeeNo, item]));
  const byId = new Map(employees.map((item) => [item.id, item]));
  const deptById = new Map(departments.map((item) => [item.id, item]));
  const findDept = (value: string, parentId: string | null | undefined) => departments.find((item) =>
    (key(item.name) === key(value) || key(item.code) === key(value)) && (parentId === undefined || item.parentId === parentId));
  const findNamed = (list: Named[], value: string) => list.find((item) => key(item.name) === key(value) || key(item.code) === key(value));
  const titleName = (id: string | null) => (id ? titles.find((item) => item.id === id)?.name ?? null : null);
  const deptLabel = (id: string | null) => {
    if (!id) return null;
    const own = deptById.get(id);
    const parent = own?.parentId ? deptById.get(own.parentId) : undefined;
    return own ? (parent ? `${parent.name} / ${own.name}` : own.name) : null;
  };

  const rows: RowResult[] = [];
  const updates: OrgPlan['updates'] = new Map();
  const newTitles = new Set<string>();
  const seen = new Set<string>();
  sheet.eachRow({ includeEmpty: false }, (row, number) => {
    if (number === 1) return;
    const values = row.values as ExcelJS.CellValue[];
    const read = (field: keyof typeof col) => (col[field] >= 0 ? norm(cellText(values[col[field]])) : '');
    const employeeNo = read('employeeNo');
    if (!employeeNo) return;
    const result: RowResult = { row: number, employeeNo, employeeId: null, fullName: null, changes: [], errors: [], warnings: [] };
    rows.push(result);
    const employee = byNo.get(employeeNo);
    if (!employee) { result.errors.push('رقم الموظف غير موجود في النظام'); return; }
    if (seen.has(employeeNo)) { result.errors.push('الموظف مكرر في الملف'); return; }
    seen.add(employeeNo);
    result.employeeId = employee.id;
    result.fullName = employee.fullName;
    const update: NonNullable<ReturnType<typeof updates.get>> = {};

    // Manager
    const managerNo = read('managerNo');
    if (col.managerNo >= 0 && managerNo) {
      const target = managerNo === '-' ? null : byNo.get(managerNo);
      if (managerNo !== '-' && !target) result.errors.push(`رقم المدير ${managerNo} غير موجود`);
      else if (target && target.id === employee.id) result.errors.push('لا يكون الموظف مديراً لنفسه');
      else {
        if (target && target.status === 'inactive') result.warnings.push('المدير المحدد منتهية خدمته');
        const nextId = target?.id ?? null;
        if (nextId !== employee.managerId) {
          update.managerId = nextId;
          result.changes.push({ field: 'manager', from: employee.managerId ? byId.get(employee.managerId)?.fullName ?? null : null, to: target?.fullName ?? null });
        }
      }
    }

    // Department and section
    const department = read('department');
    const section = read('section');
    if (department) {
      const parent = findDept(department, null) ?? findDept(department, undefined);
      if (!parent) result.errors.push(`القسم «${department}» غير موجود`);
      else {
        let target = parent;
        if (section) {
          const child = findDept(section, parent.id);
          if (!child) result.errors.push(`الشعبة «${section}» غير موجودة تحت «${parent.name}»`);
          else target = child;
        }
        if (target && target.id !== employee.departmentId && !result.errors.length) {
          update.departmentId = target.id;
          result.changes.push({ field: 'department', from: deptLabel(employee.departmentId), to: deptLabel(target.id) });
        }
      }
    }

    // Position
    const position = read('position');
    if (position) {
      const title = findNamed(titles, position);
      if (!title) {
        newTitles.add(position);
        update.jobTitleName = position;
        update.jobTitleId = null;
        result.changes.push({ field: 'position', from: titleName(employee.jobTitleId), to: `${position} (جديد)` });
      } else if (title.id !== employee.jobTitleId) {
        update.jobTitleId = title.id;
        result.changes.push({ field: 'position', from: titleName(employee.jobTitleId), to: title.name });
      }
    }

    // Branch
    const branch = read('branch');
    if (branch) {
      const target = findNamed(branches, branch);
      if (!target) result.errors.push(`الفرع «${branch}» غير موجود`);
      else if (target.id !== employee.branchId) {
        update.branchId = target.id;
        result.changes.push({ field: 'branch', from: branches.find((item) => item.id === employee.branchId)?.name ?? null, to: target.name });
      }
    }
    if (!result.errors.length && result.changes.length) updates.set(employee.id, update);
  });

  // Reporting lines must stay a tree once every change is applied.
  const managerOf = new Map(employees.map((item) => [item.id, item.managerId]));
  for (const [id, update] of updates) if (update.managerId !== undefined) managerOf.set(id, update.managerId);
  for (const result of rows) {
    if (!result.employeeId || !updates.get(result.employeeId)?.hasOwnProperty('managerId')) continue;
    const path = new Set<string>([result.employeeId]);
    let cursor = managerOf.get(result.employeeId) ?? null;
    let steps = 0;
    while (cursor && steps < 500) {
      if (path.has(cursor)) {
        result.errors.push('يُنشئ حلقة في التبعية (الموظف يصبح مديراً لمديره)');
        updates.delete(result.employeeId);
        break;
      }
      path.add(cursor);
      cursor = managerOf.get(cursor) ?? null;
      steps += 1;
    }
  }

  const changed = rows.filter((item) => item.changes.length && !item.errors.length).length;
  return {
    rows,
    newJobTitles: [...newTitles],
    updates,
    summary: {
      rows: rows.length,
      changed,
      unchanged: rows.filter((item) => !item.changes.length && !item.errors.length).length,
      errors: rows.filter((item) => item.errors.length).length,
      managerChanges: rows.filter((item) => !item.errors.length && item.changes.some((change) => change.field === 'manager')).length,
    },
  };
}

/** Writes a plan that has no errors. Returns how many employees changed. */
export async function applyOrgPlan(plan: OrgPlan, transaction: Transaction): Promise<number> {
  const titleIds = new Map<string, string>();
  const existing = await select<{ code: string }>('SELECT code FROM job_titles', {}, transaction);
  let next = existing.length + 1;
  for (const name of plan.newJobTitles) {
    const id = randomUUID();
    let code = `JT-${String(next).padStart(3, '0')}`;
    while (existing.some((item) => item.code === code)) { next += 1; code = `JT-${String(next).padStart(3, '0')}`; }
    next += 1;
    await execute('INSERT INTO job_titles (id, code, name) VALUES (:id, :code, :name)', { id, code, name: name.slice(0, 120) }, transaction);
    titleIds.set(name, id);
  }
  for (const [employeeId, update] of plan.updates) {
    const sets: string[] = [];
    const params: Record<string, unknown> = { employeeId };
    if (update.managerId !== undefined) { sets.push('manager_id = :managerId'); params.managerId = update.managerId; }
    if (update.departmentId) {
      sets.push('department_id = :departmentId', 'department = (SELECT name FROM departments WHERE id = :departmentId)');
      params.departmentId = update.departmentId;
    }
    const jobTitleId = update.jobTitleName ? titleIds.get(update.jobTitleName) : update.jobTitleId;
    if (jobTitleId) {
      sets.push('job_title_id = :jobTitleId', '"position" = (SELECT name FROM job_titles WHERE id = :jobTitleId)');
      params.jobTitleId = jobTitleId;
    }
    if (update.branchId) { sets.push('branch_id = :branchId'); params.branchId = update.branchId; }
    if (sets.length) await execute(`UPDATE employees SET ${sets.join(', ')}, updated_at = now() WHERE id = :employeeId`, params, transaction);
  }
  return plan.updates.size;
}
