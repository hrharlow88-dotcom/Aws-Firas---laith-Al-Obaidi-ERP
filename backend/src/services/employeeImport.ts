import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { Transaction } from 'sequelize';
import { execute, select } from '../db/query';
import { detectColumns, nameKey, parseDate, readSheet } from './sheetRead';

/**
 * One Excel sheet for the employees' master data: names in both languages,
 * fingerprint number, personal e-mail and phone, manager, department,
 * position, governorate and branch, joining date and salary. HR downloads it
 * filled with today's data (or uploads their own sheet with some of these
 * columns), sees every change and every problem, then applies it in one go.
 * A row whose employee number is new adds the employee. Empty cells change
 * nothing; «-» clears an optional value.
 */

export const EMPLOYEE_COLUMNS = [
  { key: 'employeeNo', header: 'رقم الموظف', width: 12 },
  { key: 'fullName', header: 'الاسم بالعربي', width: 30 },
  { key: 'nameEn', header: 'الاسم بالإنكليزي', width: 30 },
  { key: 'attendancePin', header: 'رقم البصمة', width: 12 },
  { key: 'email', header: 'البريد الشخصي', width: 28 },
  { key: 'phone', header: 'الهاتف الشخصي', width: 16 },
  { key: 'managerNo', header: 'رقم المدير المباشر', width: 16 },
  { key: 'managerName', header: 'اسم المدير (للمرجع فقط)', width: 26 },
  { key: 'department', header: 'القسم', width: 24 },
  { key: 'section', header: 'الشعبة', width: 22 },
  { key: 'position', header: 'المسمى الوظيفي', width: 26 },
  { key: 'governorate', header: 'المحافظة', width: 12 },
  { key: 'branch', header: 'الفرع', width: 22 },
  { key: 'hireDate', header: 'تاريخ المباشرة', width: 14 },
  { key: 'salary', header: 'الراتب', width: 14 },
  { key: 'currency', header: 'العملة', width: 9 },
  { key: 'salaryFrom', header: 'سريان الراتب من', width: 15 },
  { key: 'photo', header: 'الصورة (للمرجع فقط)', width: 14 },
] as const;

export type EmployeeField = (typeof EMPLOYEE_COLUMNS)[number]['key'];

/** Other names the same column carries in sheets HR already keeps. */
const ALIASES: Record<EmployeeField, string[]> = {
  employeeNo: ['رقم الموظف', 'الرقم الوظيفي', 'رقم الموظف الوظيفي', 'employee no', 'employee number', 'emp no', 'staff no', 'employee id'],
  fullName: ['الاسم بالعربي', 'الاسم', 'الاسم الكامل', 'اسم الموظف', 'الاسم العربي', 'الاسم الثلاثي', 'الاسم الرباعي', 'name', 'full name', 'arabic name', 'employee name'],
  nameEn: ['الاسم بالإنكليزي', 'الاسم بالانكليزي', 'الاسم بالإنجليزي', 'الاسم بالانجليزي', 'الاسم الانكليزي', 'الاسم الإنجليزي', 'english name', 'name en', 'name english'],
  attendancePin: ['رقم البصمة', 'البصمة', 'رقم جهاز البصمة', 'pin', 'ac no', 'ac-no', 'enroll no', 'user id', 'fingerprint no', 'fingerprint id', 'fingerprint'],
  email: ['البريد الشخصي', 'البريد الإلكتروني', 'البريد الالكتروني', 'البريد', 'الايميل', 'الإيميل', 'الايميل الشخصي', 'email', 'e-mail', 'personal email', 'mail'],
  phone: ['الهاتف الشخصي', 'الهاتف', 'رقم الهاتف', 'الموبايل', 'رقم الموبايل', 'التلفون', 'رقم التلفون', 'الجوال', 'phone', 'mobile', 'personal phone', 'phone no'],
  managerNo: ['رقم المدير المباشر', 'رقم المدير', 'manager no', 'manager number'],
  managerName: ['اسم المدير (للمرجع فقط)', 'اسم المدير', 'المدير المباشر', 'manager', 'manager name'],
  department: ['القسم', 'الإدارة', 'الادارة', 'department'],
  section: ['الشعبة', 'الوحدة', 'section', 'unit'],
  position: ['المسمى الوظيفي', 'المسمى', 'المنصب', 'الوظيفة', 'البوزشن', 'العنوان الوظيفي', 'position', 'job title', 'title'],
  governorate: ['المحافظة', 'governorate'],
  branch: ['الفرع', 'branch'],
  hireDate: ['تاريخ المباشرة', 'تاريخ المباشره', 'تاريخ التعيين', 'المباشرة', 'تاريخ التوظيف', 'hire date', 'joining date', 'date of joining', 'start date'],
  salary: ['الراتب', 'الراتب الإجمالي', 'الراتب الاجمالي', 'الراتب الكلي', 'الراتب الشهري', 'salary', 'gross salary', 'gross'],
  currency: ['العملة', 'currency'],
  salaryFrom: ['سريان الراتب من', 'تاريخ سريان الراتب', 'يسري من', 'salary from', 'effective from'],
  photo: ['الصورة (للمرجع فقط)', 'الصورة', 'photo'],
};

const LABEL: Record<EmployeeField, string> = Object.fromEntries(EMPLOYEE_COLUMNS.map((column) => [column.key, column.header.replace(/ \(للمرجع فقط\)$/, '')])) as Record<EmployeeField, string>;

interface Current {
  id: string; employeeNo: string; fullName: string; nameEn: string | null; attendancePin: string | null;
  email: string | null; phone: string | null; managerId: string | null; departmentId: string | null;
  jobTitleId: string | null; branchId: string; hireDate: string; status: string; hasPhoto: boolean;
}
interface Department { id: string; code: string; name: string; parentId: string | null }
interface Named { id: string; code: string; name: string }
interface Branch extends Named { governorateId: string | null }
interface Governorate { id: string; code: string; nameAr: string; nameEn: string | null }
interface Salary { employeeId: string; effectiveFrom: string; grossSalary: number; currency: string }

export interface ImportAccess {
  canCreate: boolean;
  canUpdate: boolean;
  canSeeSalary: boolean;
  canChangeSalary: boolean;
  /** Branch-limited users touch only their branch. */
  branchId: string | null;
  /** First day of the current month in the company's time zone (YYYY-MM-DD). */
  monthStart: string;
  baseCurrency: string;
  /** Employee fields the company made required; the sheet cannot fill them. */
  requiredCustomFields: string[];
}

export interface EmployeeRowResult {
  row: number;
  action: 'create' | 'update' | 'none' | 'error';
  employeeNo: string;
  employeeId: string | null;
  fullName: string | null;
  changes: Array<{ field: EmployeeField; label: string; from: string | null; to: string | null }>;
  errors: string[];
  warnings: string[];
}

interface Create {
  id: string; employeeNo: string; fullName: string; nameEn: string | null; attendancePin: string | null;
  email: string | null; phone: string | null; managerNo: string | null; departmentId: string; jobTitleId: string | null;
  jobTitleName: string | null; branchId: string; hireDate: string;
}
type Update = Partial<{
  fullName: string; nameEn: string | null; attendancePin: string | null; email: string | null; phone: string | null;
  managerId: string | null; departmentId: string; jobTitleId: string | null; jobTitleName: string; branchId: string; hireDate: string;
}>;

export interface EmployeePlan {
  columns: EmployeeField[];
  rows: EmployeeRowResult[];
  newJobTitles: string[];
  summary: { rows: number; create: number; update: number; unchanged: number; errors: number; salaries: number };
  creates: Create[];
  updates: Map<string, Update>;
  /** Manager links resolved after creates (new employees may manage each other). */
  managers: Map<string, string | null>;
  salaries: Array<{ employeeId: string; effectiveFrom: string; grossSalary: number; currency: string }>;
}

const norm = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
const lower = (value: unknown) => nameKey(norm(value));
const CLEAR = '-';

export function cleanPin(value: string): string | null {
  const pin = value.trim().replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/^0+(?=\d)/, '');
  return /^[A-Za-z0-9_-]{1,40}$/.test(pin) ? pin : null;
}

/** Keeps a leading + and the digits; Iraqi numbers are 07xx… or +9647xx…. */
export function cleanPhone(value: string): string | null {
  const ascii = value.replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
  const plus = ascii.trim().startsWith('+') || ascii.trim().startsWith('00');
  const digits = ascii.replace(/\D/g, '').replace(/^00/, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return plus ? `+${digits}` : digits;
}

export function cleanEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

/** 1,250,000 · 1250000 IQD · $900 · 900 دولار → amount and the currency it names. */
export function parseMoney(value: string): { amount: number; currency: string | null } | null {
  const text = value.replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/٬/g, ',').replace(/٫/g, '.');
  const currency = /\$|usd|دولار/i.test(text) ? 'USD' : /iqd|د\.?ع|دينار/i.test(text) ? 'IQD' : null;
  const number = text.replace(/[^\d.]/g, '');
  if (!number || !/^\d+(\.\d+)?$/.test(number)) return null;
  const amount = Number(number);
  return Number.isFinite(amount) && amount >= 0 && amount <= 1e12 ? { amount, currency } : null;
}

const addDay = (date: string) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
};

async function reference(transaction?: Transaction) {
  // One after another: inside a transaction they share a single connection.
  const run = async <T extends unknown[]>(queries: { [K in keyof T]: () => Promise<T[K]> }): Promise<T> => {
    const results: unknown[] = [];
    for (const query of queries as Array<() => Promise<unknown>>) results.push(await query());
    return results as T;
  };
  const [employees, departments, titles, branches, governorates, salaries, locks, shift] = await run<[
    Current[], Department[], Named[], Branch[], Governorate[], Salary[], Array<{ employeeId: string; endsOn: string; period: string }>, Array<{ id: string }>,
  ]>([
    () => select<Current>(
      `SELECT e.id, e.employee_no AS "employeeNo", e.full_name AS "fullName", p.name_en AS "nameEn",
              e.attendance_pin AS "attendancePin", e.email, e.phone, e.manager_id AS "managerId",
              e.department_id AS "departmentId", e.job_title_id AS "jobTitleId", e.branch_id AS "branchId",
              to_char(e.hire_date, 'YYYY-MM-DD') AS "hireDate", e.employment_status AS status,
              e.photo_document_id IS NOT NULL AS "hasPhoto"
       FROM employees e LEFT JOIN employee_profiles p ON p.employee_id = e.id`, {}, transaction,
    ),
    () => select<Department>('SELECT id, code, name, parent_id AS "parentId" FROM departments WHERE is_active', {}, transaction),
    () => select<Named>('SELECT id, code, name FROM job_titles WHERE is_active', {}, transaction),
    () => select<Branch>('SELECT id, code, name, governorate_id AS "governorateId" FROM branches WHERE is_active', {}, transaction),
    () => select<Governorate>('SELECT id, code, name_ar AS "nameAr", name_en AS "nameEn" FROM governorates WHERE is_active', {}, transaction),
    () => select<Salary>(
      `SELECT DISTINCT ON (employee_id) employee_id AS "employeeId", to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
              gross_salary::float AS "grossSalary", currency
       FROM employee_compensation ORDER BY employee_id, effective_from DESC`, {}, transaction,
    ),
    () => select<{ employeeId: string; endsOn: string; period: string }>(
      `SELECT DISTINCT ON (l.employee_id) l.employee_id AS "employeeId", to_char(r.ends_on, 'YYYY-MM-DD') AS "endsOn", r.period
       FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
       WHERE r.status IN ('approved','posted') ORDER BY l.employee_id, r.ends_on DESC`, {}, transaction,
    ),
    () => select<{ id: string }>('SELECT id FROM shifts WHERE is_default AND is_active LIMIT 1', {}, transaction),
  ]);
  const compensationDates = await select<{ employeeId: string; effectiveFrom: string }>(
    `SELECT employee_id AS "employeeId", to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom" FROM employee_compensation`, {}, transaction,
  );
  return { employees, departments, titles, branches, governorates, salaries, locks, defaultShiftId: shift[0]?.id ?? null, compensationDates };
}

/** The sheet HR fills in, with today's data. Salaries only for those allowed to see them. */
export async function employeeTemplate(access: Pick<ImportAccess, 'canSeeSalary' | 'branchId'>): Promise<ExcelJS.Workbook> {
  const { employees, departments, titles, branches, governorates, salaries } = await reference();
  const byId = new Map(employees.map((item) => [item.id, item]));
  const dept = new Map(departments.map((item) => [item.id, item]));
  const salaryOf = new Map(salaries.map((item) => [item.employeeId, item]));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('الموظفون', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  sheet.columns = EMPLOYEE_COLUMNS.map((column) => ({ header: column.header, key: column.key, width: column.width }));
  const list = employees
    .filter((item) => item.status !== 'inactive' && (!access.branchId || item.branchId === access.branchId))
    .sort((a, b) => a.employeeNo.localeCompare(b.employeeNo, 'en', { numeric: true }));
  for (const employee of list) {
    const own = employee.departmentId ? dept.get(employee.departmentId) : undefined;
    const parent = own?.parentId ? dept.get(own.parentId) : undefined;
    const manager = employee.managerId ? byId.get(employee.managerId) : undefined;
    const branch = branches.find((item) => item.id === employee.branchId);
    const salary = access.canSeeSalary ? salaryOf.get(employee.id) : undefined;
    sheet.addRow({
      employeeNo: employee.employeeNo,
      fullName: employee.fullName,
      nameEn: employee.nameEn ?? '',
      attendancePin: employee.attendancePin ?? '',
      email: employee.email ?? '',
      phone: employee.phone ?? '',
      managerNo: manager?.employeeNo ?? '',
      managerName: manager?.fullName ?? '',
      department: parent ? parent.name : own?.name ?? '',
      section: parent ? own?.name ?? '' : '',
      position: titles.find((item) => item.id === employee.jobTitleId)?.name ?? '',
      governorate: governorates.find((item) => item.id === branch?.governorateId)?.nameAr ?? '',
      branch: branch?.name ?? '',
      hireDate: employee.hireDate ? new Date(`${employee.hireDate}T00:00:00Z`) : '',
      salary: salary ? salary.grossSalary : '',
      currency: salary ? salary.currency : '',
      salaryFrom: '',
      photo: employee.hasPhoto ? 'موجودة' : 'لا توجد',
    });
  }
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D1B1F' } };
  sheet.getRow(1).height = 22;
  for (const key of ['managerName', 'photo'] as const) {
    const index = EMPLOYEE_COLUMNS.findIndex((column) => column.key === key) + 1;
    sheet.getColumn(index).font = { color: { argb: 'FF8A817C' } };
  }
  const column = (key: EmployeeField) => sheet.getColumn(EMPLOYEE_COLUMNS.findIndex((item) => item.key === key) + 1);
  column('hireDate').numFmt = 'yyyy-mm-dd';
  column('salaryFrom').numFmt = 'yyyy-mm-dd';
  column('salary').numFmt = '#,##0.##';
  for (const key of ['employeeNo', 'attendancePin', 'phone', 'managerNo'] as const) column(key).numFmt = '@';
  const last = Math.max(list.length + 200, 500);
  const letter = (key: EmployeeField) => column(key).letter;
  for (let row = 2; row <= last; row += 1) {
    sheet.getCell(`${letter('currency')}${row}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"IQD,USD"'] };
    if (governorates.length) {
      sheet.getCell(`${letter('governorate')}${row}`).dataValidation = {
        type: 'list', allowBlank: true, formulae: [`"${governorates.map((item) => item.nameAr).join(',')}"`],
      };
    }
  }

  const help = workbook.addWorksheet('تعليمات', { views: [{ rightToLeft: true }] });
  help.columns = [{ width: 120 }];
  [
    'كل سطر موظف واحد، ويُعرف برقم الموظف. اكتب رقماً جديداً غير موجود في النظام لإضافة موظف جديد.',
    'الخلية الفارغة لا تغيّر شيئاً. اكتب «-» لمسح قيمة اختيارية (الاسم بالإنكليزي، رقم البصمة، البريد، الهاتف، المدير المباشر).',
    'الموظف الجديد يحتاج: رقم الموظف، الاسم بالعربي، القسم، المسمى الوظيفي، الفرع، تاريخ المباشرة. ويُسند له الدوام الافتراضي للبصمة.',
    'رقم البصمة هو رقم الموظف في جهاز البصمة؛ به تُقرأ ملفات الحضور والإجازات والمهام. لا يتكرر لموظفين.',
    'المحافظة اختيارية؛ إذا كتبتها يجب أن يكون الفرع منها. القسم والشعبة والفرع والمحافظة تُكتب كما في ورقة «القوائم» أو بالرمز.',
    'المسمى الوظيفي غير الموجود يُنشأ تلقائياً ويظهر في المعاينة قبل الحفظ.',
    'الراتب: الإجمالي الشهري بعملة عمود «العملة» (IQD أو USD). يُضاف سطر راتب جديد إذا تغيّر المبلغ أو العملة، ويسري من تاريخ «سريان الراتب من»؛ إن تُرك فارغاً: تاريخ المباشرة للموظف الجديد، وأول الشهر الحالي (أو بعد آخر مسير معتمد) للموجود. لا يسري راتب قبل نهاية مسير معتمد.',
    'التواريخ بصيغة سنة-شهر-يوم (2026-10-01) أو يوم/شهر/سنة (01/10/2026).',
    'عمودا «اسم المدير» و«الصورة» للمرجع فقط ولا يُقرآن. الصور تُرفع من شاشة «الصور» دفعة واحدة باسم رقم الموظف (10123.jpg) أو تُعتمد من بوابة الموظف.',
    'ارفع الملف من «الموظفون ← استيراد وتحديث». لا يُحفظ شيء قبل أن تراجع المعاينة وتضغط «اعتماد»، ولا يُحفظ أي سطر إذا وُجد خطأ في الملف.',
    'يمكنك أيضاً رفع ملف من عندك بجزء من هذه الأعمدة فقط (مثلاً: رقم الموظف، رقم البصمة، البريد، الهاتف) بنفس العناوين.',
  ].forEach((line) => help.addRow([line]));
  help.getColumn(1).alignment = { wrapText: true, vertical: 'top' };

  const lists = workbook.addWorksheet('القوائم', { views: [{ rightToLeft: true }] });
  lists.columns = [
    { header: 'الأقسام والشعب', width: 40 }, { header: 'الرمز', width: 12 },
    { header: 'الفروع', width: 28 }, { header: 'المحافظة', width: 12 }, { header: 'الرمز', width: 12 },
    { header: 'المسميات الوظيفية', width: 36 },
  ];
  const sortedDepts = [...departments].sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0) || a.name.localeCompare(b.name));
  const sortedTitles = [...titles].sort((a, b) => a.name.localeCompare(b.name));
  const rows = Math.max(sortedDepts.length, branches.length, sortedTitles.length);
  for (let index = 0; index < rows; index += 1) {
    const d = sortedDepts[index];
    const b = branches[index];
    lists.addRow([
      d ? (d.parentId ? `   ${dept.get(d.parentId)?.name ?? ''} / ${d.name}` : d.name) : '', d?.code ?? '',
      b?.name ?? '', b ? governorates.find((item) => item.id === b.governorateId)?.nameAr ?? '' : '', b?.code ?? '',
      sortedTitles[index]?.name ?? '',
    ]);
  }
  lists.getRow(1).font = { bold: true };
  return workbook;
}

export class EmployeeSheetError extends Error {}

/** Reads the uploaded sheet and works out every change, without writing anything. */
export async function planEmployeeImport(buffer: Buffer, access: ImportAccess, transaction?: Transaction): Promise<EmployeePlan> {
  const table = await readSheet(buffer);
  if (!table.rows.length) throw new EmployeeSheetError('الملف فارغ.');
  const detected = detectColumns(table, ALIASES);
  if (!detected) throw new EmployeeSheetError('لم يُعثر على عناوين الأعمدة. استخدم نموذج الموظفين المنزّل من النظام أو نفس عناوينه.');
  const col = detected.columns;
  if (col.employeeNo < 0 && col.attendancePin < 0 && col.fullName < 0) {
    throw new EmployeeSheetError('يلزم عمود «رقم الموظف» (أو «رقم البصمة» أو «الاسم») لمعرفة كل موظف.');
  }
  const columns = (Object.keys(col) as EmployeeField[]).filter((field) => col[field] >= 0);

  const ref = await reference(transaction);
  const { employees, departments, titles, branches, governorates } = ref;
  const byNo = new Map(employees.map((item) => [item.employeeNo, item]));
  const byId = new Map(employees.map((item) => [item.id, item]));
  const byPin = new Map(employees.filter((item) => item.attendancePin).map((item) => [item.attendancePin!, item]));
  const byName = new Map<string, Current[]>();
  for (const employee of employees) {
    const key = nameKey(employee.fullName);
    byName.set(key, [...(byName.get(key) ?? []), employee]);
  }
  const deptById = new Map(departments.map((item) => [item.id, item]));
  const salaryOf = new Map(ref.salaries.map((item) => [item.employeeId, item]));
  const lockOf = new Map(ref.locks.map((item) => [item.employeeId, item]));
  const salaryDates = new Set(ref.compensationDates.map((item) => `${item.employeeId}|${item.effectiveFrom}`));
  const findDept = (value: string, parentId: string | null | undefined) => departments.find((item) =>
    (lower(item.name) === lower(value) || lower(item.code) === lower(value)) && (parentId === undefined || item.parentId === parentId));
  const findNamed = <T extends Named>(list: T[], value: string) => list.find((item) => lower(item.name) === lower(value) || lower(item.code) === lower(value));
  const findGovernorate = (value: string) => governorates.find((item) =>
    [item.nameAr, item.nameEn ?? '', item.code].some((name) => name && lower(name) === lower(value)));
  const deptLabel = (id: string | null) => {
    if (!id) return null;
    const own = deptById.get(id);
    const parent = own?.parentId ? deptById.get(own.parentId) : undefined;
    return own ? (parent ? `${parent.name} / ${own.name}` : own.name) : null;
  };
  const titleName = (id: string | null) => (id ? titles.find((item) => item.id === id)?.name ?? null : null);
  const branchName = (id: string | null) => (id ? branches.find((item) => item.id === id)?.name ?? null : null);

  const rows: EmployeeRowResult[] = [];
  const creates: Create[] = [];
  const updates = new Map<string, Update>();
  const managerCells = new Map<string, { row: EmployeeRowResult; value: string }>();
  const salaries: EmployeePlan['salaries'] = [];
  const newTitles = new Set<string>();
  const seen = new Map<string, EmployeeRowResult>();
  const newNos = new Map<string, Create>();

  for (const tableRow of table.rows.slice(detected.headerIndex + 1)) {
    const read = (field: EmployeeField) => (col[field] >= 0 ? norm(tableRow.cells[col[field]]) : '');
    const employeeNoCell = read('employeeNo').replace(/^0+(?=\d)/, '');
    const pinCell = read('attendancePin');
    const nameCell = read('fullName');
    if (!employeeNoCell && !pinCell && !nameCell) continue;
    const result: EmployeeRowResult = {
      row: tableRow.number, action: 'none', employeeNo: employeeNoCell, employeeId: null, fullName: nameCell || null,
      changes: [], errors: [], warnings: [],
    };
    rows.push(result);
    const change = (field: EmployeeField, from: string | null, to: string | null) => result.changes.push({ field, label: LABEL[field], from, to });

    // Who is this row?
    let employee: Current | undefined;
    if (employeeNoCell) employee = byNo.get(employeeNoCell);
    else if (pinCell && pinCell !== CLEAR) {
      const pin = cleanPin(pinCell);
      employee = pin ? byPin.get(pin) ?? byNo.get(pin) : undefined;
    }
    if (!employee && !employeeNoCell && nameCell) {
      const sameNamed = byName.get(nameKey(nameCell)) ?? [];
      if (sameNamed.length === 1) {
        employee = sameNamed[0];
        result.warnings.push('طوبق بالاسم فقط؛ تأكد أنه الموظف المقصود');
      } else if (sameNamed.length > 1) {
        result.errors.push(`الاسم مكرر لـ ${sameNamed.length} موظفين؛ أضف رقم الموظف`);
        result.action = 'error';
        continue;
      }
    }
    if (employee) {
      result.employeeId = employee.id;
      result.employeeNo = employee.employeeNo;
      result.fullName = employee.fullName;
      const key = employee.id;
      if (seen.has(key)) { result.errors.push(`الموظف مكرر في الملف (السطر ${seen.get(key)!.row})`); result.action = 'error'; continue; }
      seen.set(key, result);
      if (access.branchId && employee.branchId !== access.branchId) {
        result.errors.push('الموظف خارج فرعك');
        result.action = 'error';
        continue;
      }
    } else if (!employeeNoCell) {
      result.errors.push(pinCell ? `رقم البصمة ${pinCell} لا يطابق موظفاً؛ أضف رقم الموظف` : 'لا يطابق أي موظف؛ أضف رقم الموظف');
      result.action = 'error';
      continue;
    } else if (newNos.has(employeeNoCell)) {
      result.errors.push('رقم الموظف الجديد مكرر في الملف');
      result.action = 'error';
      continue;
    }

    const update: Update = {};
    const isNew = !employee;

    // Names
    if (nameCell && nameCell !== CLEAR) {
      if (nameCell.length > 180) result.errors.push('الاسم أطول من 180 حرفاً');
      else if (employee && nameCell !== norm(employee.fullName)) {
        update.fullName = nameCell;
        change('fullName', employee.fullName, nameCell);
      }
    } else if (nameCell === CLEAR) result.errors.push('لا يُمسح الاسم بالعربي');
    const nameEnCell = read('nameEn');
    let nameEn: string | null | undefined;
    if (nameEnCell) {
      nameEn = nameEnCell === CLEAR ? null : nameEnCell;
      if (nameEn && nameEn.length > 180) result.errors.push('الاسم بالإنكليزي أطول من 180 حرفاً');
      else if (employee && (nameEn ?? '') !== (employee.nameEn ?? '')) {
        update.nameEn = nameEn;
        change('nameEn', employee.nameEn, nameEn);
      }
    }

    // Fingerprint number
    let pin: string | null | undefined;
    if (pinCell) {
      pin = pinCell === CLEAR ? null : cleanPin(pinCell);
      if (pin === null && pinCell !== CLEAR) result.errors.push(`رقم البصمة «${pinCell}» يقبل أرقاماً وحروفاً إنجليزية فقط`);
      else if (employee && (pin ?? null) !== (employee.attendancePin ?? null)) {
        update.attendancePin = pin ?? null;
        change('attendancePin', employee.attendancePin, pin ?? null);
      }
    }

    // E-mail and phone
    const emailCell = read('email');
    let email: string | null | undefined;
    if (emailCell) {
      email = emailCell === CLEAR ? null : cleanEmail(emailCell);
      if (email === null && emailCell !== CLEAR) result.errors.push(`البريد «${emailCell}» غير صحيح`);
      else if (employee && (email ?? null) !== (employee.email?.toLowerCase() ?? null)) {
        update.email = email ?? null;
        change('email', employee.email, email ?? null);
      }
    }
    const phoneCell = read('phone');
    let phone: string | null | undefined;
    if (phoneCell) {
      phone = phoneCell === CLEAR ? null : cleanPhone(phoneCell);
      if (phone === null && phoneCell !== CLEAR) result.errors.push(`الهاتف «${phoneCell}» غير صحيح`);
      else if (employee && (phone ?? null) !== (employee.phone ? cleanPhone(employee.phone) ?? employee.phone : null)) {
        update.phone = phone ?? null;
        change('phone', employee.phone, phone ?? null);
      }
    }

    // Manager (resolved after every row is known: the manager may be new in this file)
    const managerCell = read('managerNo').replace(/^0+(?=\d)/, '');
    if (managerCell) managerCells.set(employee?.id ?? `new:${employeeNoCell}`, { row: result, value: managerCell });

    // Department and section
    const department = read('department');
    const section = read('section');
    let departmentId: string | undefined;
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
        departmentId = target.id;
        if (employee && target.id !== employee.departmentId) {
          update.departmentId = target.id;
          change('department', deptLabel(employee.departmentId), deptLabel(target.id));
        }
      }
    } else if (section) result.errors.push('اكتب القسم مع الشعبة');

    // Position
    const position = read('position');
    let jobTitleId: string | null | undefined;
    let jobTitleName: string | null = null;
    if (position) {
      const title = findNamed(titles, position);
      if (!title) {
        if (position.length > 120) result.errors.push('المسمى أطول من 120 حرفاً');
        else {
          newTitles.add(position);
          jobTitleName = position;
          jobTitleId = null;
          if (employee) {
            update.jobTitleName = position;
            update.jobTitleId = null;
            change('position', titleName(employee.jobTitleId), `${position} (جديد)`);
          }
        }
      } else {
        jobTitleId = title.id;
        if (employee && title.id !== employee.jobTitleId) {
          update.jobTitleId = title.id;
          change('position', titleName(employee.jobTitleId), title.name);
        }
      }
    }

    // Governorate and branch
    const governorateCell = read('governorate');
    const branchCell = read('branch');
    const governorate = governorateCell ? findGovernorate(governorateCell) : undefined;
    if (governorateCell && !governorate) result.errors.push(`المحافظة «${governorateCell}» غير موجودة`);
    let branchId: string | undefined;
    if (branchCell) {
      const target = findNamed(branches, branchCell);
      if (!target) result.errors.push(`الفرع «${branchCell}» غير موجود`);
      else if (governorate && target.governorateId !== governorate.id) result.errors.push(`الفرع «${target.name}» ليس في محافظة ${governorate.nameAr}`);
      else if (access.branchId && target.id !== access.branchId) result.errors.push('لا يمكنك النقل أو الإضافة إلى فرع آخر');
      else {
        branchId = target.id;
        if (employee && target.id !== employee.branchId) {
          update.branchId = target.id;
          change('branch', branchName(employee.branchId), target.name);
        }
      }
    } else if (governorate && employee) {
      const current = branches.find((item) => item.id === employee!.branchId);
      if (current && current.governorateId !== governorate.id) result.errors.push(`فرعه الحالي ليس في ${governorate.nameAr}؛ اكتب الفرع الجديد`);
    }

    // Joining date
    const hireCell = read('hireDate');
    let hireDate: string | undefined;
    if (hireCell) {
      const parsed = parseDate(hireCell);
      if (!parsed) result.errors.push(`تاريخ المباشرة «${hireCell}» غير مفهوم`);
      else {
        hireDate = parsed;
        if (employee && parsed !== employee.hireDate) {
          update.hireDate = parsed;
          change('hireDate', employee.hireDate, parsed);
          result.warnings.push('تغيير تاريخ المباشرة يغيّر سنوات الخدمة واستحقاق الإجازة');
        }
      }
    }

    // Salary
    const salaryCell = read('salary');
    if (salaryCell && salaryCell !== CLEAR) {
      const money = parseMoney(salaryCell);
      const currencyCell = read('currency').toUpperCase();
      const current = employee ? salaryOf.get(employee.id) : undefined;
      const currency = (currencyCell === 'IQD' || currencyCell === 'USD') ? currencyCell
        : /دولار/.test(currencyCell) ? 'USD' : /دينار/.test(currencyCell) ? 'IQD'
          : money?.currency ?? current?.currency ?? access.baseCurrency;
      if (!money) result.errors.push(`الراتب «${salaryCell}» ليس رقماً`);
      else if (currencyCell && !['IQD', 'USD'].includes(currency)) result.errors.push(`العملة «${currencyCell}» غير معروفة (IQD أو USD)`);
      else if (!access.canChangeSalary) {
        if (!current || current.grossSalary !== money.amount || current.currency !== currency) result.errors.push('لا تملك صلاحية تعديل الرواتب؛ اترك عمود الراتب فارغاً');
      } else if (!current || Math.abs(current.grossSalary - money.amount) > 0.004 || current.currency !== currency) {
        const fromCell = read('salaryFrom');
        const lock = employee ? lockOf.get(employee.id) : undefined;
        let effectiveFrom: string | null;
        if (fromCell) effectiveFrom = parseDate(fromCell);
        else if (!employee) effectiveFrom = hireDate ?? null;
        else effectiveFrom = lock && lock.endsOn >= access.monthStart ? addDay(lock.endsOn) : access.monthStart;
        if (fromCell && !effectiveFrom) result.errors.push(`تاريخ سريان الراتب «${fromCell}» غير مفهوم`);
        else if (!effectiveFrom) result.errors.push('حدد تاريخ المباشرة أو تاريخ سريان الراتب');
        else if (lock && effectiveFrom <= lock.endsOn) result.errors.push(`لا يسري راتب قبل نهاية مسير ${lock.period} المعتمد (${lock.endsOn})`);
        else if (employee && salaryDates.has(`${employee.id}|${effectiveFrom}`)) result.errors.push(`يوجد راتب يسري من ${effectiveFrom}؛ اختر تاريخاً آخر`);
        else {
          salaries.push({ employeeId: employee?.id ?? `new:${employeeNoCell}`, effectiveFrom, grossSalary: money.amount, currency });
          change('salary', current ? `${current.grossSalary.toLocaleString('en-US')} ${current.currency}` : null,
            `${money.amount.toLocaleString('en-US')} ${currency} من ${effectiveFrom}`);
        }
      }
    }

    if (isNew) {
      if (!access.canCreate) result.errors.push('رقم الموظف غير موجود، ولا تملك صلاحية إضافة موظفين');
      if (employeeNoCell.length > 40 || !/^[A-Za-z0-9_-]+$/.test(employeeNoCell)) result.errors.push('رقم الموظف يقبل أرقاماً وحروفاً إنجليزية فقط');
      const missing = [
        !nameCell && 'الاسم بالعربي', !departmentId && !department && 'القسم', !position && 'المسمى الوظيفي',
        !branchId && !branchCell && 'الفرع', !hireDate && !hireCell && 'تاريخ المباشرة',
      ].filter(Boolean);
      if (missing.length) result.errors.push(`رقم الموظف ${employeeNoCell} غير موجود في النظام. لإضافته موظفاً جديداً أكمل: ${missing.join('، ')}`);
      if (access.requiredCustomFields.length) result.errors.push(`الإضافة من هنا غير ممكنة: حقول إضافية إلزامية (${access.requiredCustomFields.join('، ')}). أضفه من نموذج الموظف`);
      if (nameCell && (byName.get(nameKey(nameCell)) ?? []).length) {
        const twin = byName.get(nameKey(nameCell))![0];
        result.warnings.push(`الاسم مطابق لموظف موجود (${twin.employeeNo}) — تأكد أنه ليس مكرراً`);
      }
      if (!result.errors.length && departmentId && branchId && hireDate) {
        const create: Create = {
          id: randomUUID(), employeeNo: employeeNoCell, fullName: nameCell, nameEn: nameEn ?? null, attendancePin: pin ?? null,
          email: email ?? null, phone: phone ?? null, managerNo: null, departmentId, jobTitleId: jobTitleId ?? null,
          jobTitleName, branchId, hireDate,
        };
        creates.push(create);
        newNos.set(employeeNoCell, create);
        result.action = 'create';
        result.changes.unshift({ field: 'employeeNo', label: 'موظف جديد', from: null, to: `${employeeNoCell} · ${nameCell}` });
      }
    } else if (!access.canUpdate && result.changes.length) {
      result.errors.push('لا تملك صلاحية تعديل بيانات الموظفين');
    }
    if (employee && Object.keys(update).length) updates.set(employee.id, update);
    if (result.errors.length) result.action = 'error';
    else if (!isNew) result.action = result.changes.length ? 'update' : 'none';
  }

  // Managers: existing or new in this file; «-» removes.
  const managers = new Map<string, string | null>();
  const newIdOf = (no: string) => newNos.get(no)?.id;
  for (const [subject, { row, value }] of managerCells) {
    if (row.errors.length) continue;
    const subjectId = subject.startsWith('new:') ? newIdOf(subject.slice(4)) : subject;
    if (!subjectId) continue;
    const current = subject.startsWith('new:') ? null : byId.get(subject)?.managerId ?? null;
    let target: string | null = null;
    let label: string | null = null;
    if (value !== CLEAR) {
      const existing = byNo.get(value);
      const created = newNos.get(value);
      target = existing?.id ?? created?.id ?? null;
      label = existing?.fullName ?? created?.fullName ?? null;
      if (!target) { row.errors.push(`رقم المدير ${value} غير موجود`); row.action = 'error'; continue; }
      if (target === subjectId) { row.errors.push('لا يكون الموظف مديراً لنفسه'); row.action = 'error'; continue; }
      if (existing && existing.status === 'inactive') row.warnings.push('المدير المحدد منتهية خدمته');
    }
    if (target !== current) {
      if (!subject.startsWith('new:') && !access.canUpdate) {
        row.errors.push('لا تملك صلاحية تعديل بيانات الموظفين');
        row.action = 'error';
        continue;
      }
      managers.set(subjectId, target);
      row.changes.push({ field: 'managerNo', label: 'المدير المباشر', from: current ? byId.get(current)?.fullName ?? null : null, to: label });
      if (row.action === 'none') row.action = 'update';
    }
  }

  // Reporting lines stay a tree once everything is applied.
  const managerOf = new Map<string, string | null>(employees.map((item) => [item.id, item.managerId]));
  for (const create of creates) managerOf.set(create.id, null);
  for (const [id, managerId] of managers) managerOf.set(id, managerId);
  for (const [id] of managers) {
    const path = new Set<string>([id]);
    let cursor = managerOf.get(id) ?? null;
    let steps = 0;
    while (cursor && steps < 500) {
      if (path.has(cursor)) {
        const row = rows.find((item) => item.employeeId === id || (item.action === 'create' && newIdOf(item.employeeNo) === id));
        if (row) { row.errors.push('يُنشئ حلقة في التبعية (الموظف يصبح مديراً لمديره)'); row.action = 'error'; }
        break;
      }
      path.add(cursor);
      cursor = managerOf.get(cursor) ?? null;
      steps += 1;
    }
  }

  // A fingerprint number belongs to one person once every change is applied.
  const pinOwner = new Map<string, string>();
  const finalPins = new Map<string, string | null>(employees.map((item) => [item.id, item.attendancePin]));
  for (const [id, update] of updates) if (update.attendancePin !== undefined) finalPins.set(id, update.attendancePin);
  for (const create of creates) finalPins.set(create.id, create.attendancePin);
  const rowOf = (id: string) => rows.find((item) => item.employeeId === id || (item.action !== 'error' && newIdOf(item.employeeNo) === id));
  for (const [id, value] of finalPins) {
    if (!value) continue;
    const other = pinOwner.get(value);
    if (other) {
      for (const owner of [id, other]) {
        const row = rowOf(owner);
        const otherId = owner === id ? other : id;
        const otherName = byId.get(otherId)?.fullName ?? creates.find((item) => item.id === otherId)?.fullName ?? '';
        if (row && !row.errors.some((error) => error.startsWith('رقم البصمة'))) {
          row.errors.push(`رقم البصمة ${value} مستخدم أيضاً لـ ${otherName}`);
          row.action = 'error';
        }
      }
    } else pinOwner.set(value, id);
  }

  // New employees' salary rows get their final ids.
  const resolvedSalaries = salaries
    .map((item) => ({ ...item, employeeId: item.employeeId.startsWith('new:') ? newIdOf(item.employeeId.slice(4)) ?? '' : item.employeeId }))
    .filter((item) => item.employeeId);

  // Drop the writes of rows that ended with an error (the plan is refused anyway; this keeps it honest).
  const failed = new Set(rows.filter((row) => row.errors.length).map((row) => row.employeeId ?? newIdOf(row.employeeNo) ?? ''));
  const keptCreates = creates.filter((item) => !failed.has(item.id));
  for (const id of failed) { updates.delete(id); managers.delete(id); }

  const usedTitles = new Set([
    ...keptCreates.map((item) => item.jobTitleName).filter((name): name is string => Boolean(name)),
    ...[...updates.values()].map((item) => item.jobTitleName).filter((name): name is string => Boolean(name)),
  ]);
  return {
    columns,
    rows,
    newJobTitles: [...newTitles].filter((name) => usedTitles.has(name)),
    creates: keptCreates,
    updates,
    managers,
    salaries: resolvedSalaries.filter((item) => !failed.has(item.employeeId)),
    summary: {
      rows: rows.length,
      create: rows.filter((row) => row.action === 'create').length,
      update: rows.filter((row) => row.action === 'update').length,
      unchanged: rows.filter((row) => row.action === 'none').length,
      errors: rows.filter((row) => row.action === 'error').length,
      salaries: resolvedSalaries.filter((item) => !failed.has(item.employeeId)).length,
    },
  };
}

/** Writes a plan that has no errors. */
export async function applyEmployeePlan(
  plan: EmployeePlan, userId: string, defaultShiftId: string | null, transaction: Transaction,
): Promise<{ created: number; updated: number; salaries: number; titleIds: Map<string, string> }> {
  const titleIds = new Map<string, string>();
  const existing = await select<{ code: string }>('SELECT code FROM job_titles', {}, transaction);
  const codes = new Set(existing.map((item) => item.code));
  let next = existing.length + 1;
  for (const name of plan.newJobTitles) {
    let code = `JT-${String(next).padStart(3, '0')}`;
    while (codes.has(code)) { next += 1; code = `JT-${String(next).padStart(3, '0')}`; }
    codes.add(code);
    next += 1;
    const id = randomUUID();
    await execute('INSERT INTO job_titles (id, code, name) VALUES (:id, :code, :name)', { id, code, name: name.slice(0, 120) }, transaction);
    titleIds.set(name, id);
  }
  const titleFor = (jobTitleId: string | null | undefined, name: string | null | undefined) => (name ? titleIds.get(name) ?? null : jobTitleId ?? null);

  // Fingerprint numbers that move between people are released first.
  const releasing = [...plan.updates.entries()].filter(([, update]) => update.attendancePin !== undefined).map(([id]) => id);
  if (releasing.length) {
    await execute('UPDATE employees SET attendance_pin = NULL WHERE id IN (:ids)', { ids: releasing }, transaction);
  }

  for (const create of plan.creates) {
    const jobTitleId = titleFor(create.jobTitleId, create.jobTitleName);
    await execute(
      `INSERT INTO employees (id, employee_no, full_name, email, phone, branch_id, department, "position", hire_date,
         employment_status, custom_fields, created_at, updated_at, department_id, job_title_id, employment_type, attendance_pin, shift_id)
       VALUES (:id, :employeeNo, :fullName, :email, :phone, :branchId,
         (SELECT name FROM departments WHERE id = :departmentId),
         COALESCE((SELECT name FROM job_titles WHERE id = :jobTitleId), :positionText),
         :hireDate, 'active', '{}'::jsonb, now(), now(), :departmentId, :jobTitleId, 'permanent', :pin, :shiftId)`,
      {
        id: create.id, employeeNo: create.employeeNo, fullName: create.fullName, email: create.email, phone: create.phone,
        branchId: create.branchId, departmentId: create.departmentId, jobTitleId, positionText: create.jobTitleName ?? '',
        hireDate: create.hireDate, pin: create.attendancePin, shiftId: defaultShiftId,
      },
      transaction,
    );
    if (create.nameEn) {
      await execute(
        `INSERT INTO employee_profiles (employee_id, name_en, updated_by, updated_at) VALUES (:id, :nameEn, :userId, now())`,
        { id: create.id, nameEn: create.nameEn, userId }, transaction,
      );
    }
  }

  for (const [employeeId, update] of plan.updates) {
    const sets: string[] = [];
    const params: Record<string, unknown> = { employeeId };
    if (update.fullName !== undefined) { sets.push('full_name = :fullName'); params.fullName = update.fullName; }
    if (update.attendancePin !== undefined) { sets.push('attendance_pin = :pin'); params.pin = update.attendancePin; }
    if (update.email !== undefined) { sets.push('email = :email'); params.email = update.email; }
    if (update.phone !== undefined) { sets.push('phone = :phone'); params.phone = update.phone; }
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
    if (update.hireDate) { sets.push('hire_date = :hireDate'); params.hireDate = update.hireDate; }
    if (sets.length) await execute(`UPDATE employees SET ${sets.join(', ')}, updated_at = now() WHERE id = :employeeId`, params, transaction);
    if (update.nameEn !== undefined) {
      await execute(
        `INSERT INTO employee_profiles (employee_id, name_en, updated_by, updated_at) VALUES (:employeeId, :nameEn, :userId, now())
         ON CONFLICT (employee_id) DO UPDATE SET name_en = EXCLUDED.name_en, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        { employeeId, nameEn: update.nameEn, userId }, transaction,
      );
    }
  }

  for (const [employeeId, managerId] of plan.managers) {
    await execute('UPDATE employees SET manager_id = :managerId, updated_at = now() WHERE id = :employeeId', { employeeId, managerId }, transaction);
  }

  for (const salary of plan.salaries) {
    await execute(
      `INSERT INTO employee_compensation (id, employee_id, effective_from, gross_salary, currency, component_overrides, reason, created_by)
       VALUES (:id, :employeeId, :effectiveFrom, :grossSalary, :currency, '{}'::jsonb, :reason, :userId)`,
      { id: randomUUID(), ...salary, reason: 'استيراد إكسل الموظفين', userId },
      transaction,
    );
  }
  const updatedIds = new Set([...plan.updates.keys(), ...plan.managers.keys()].filter((id) => !plan.creates.some((item) => item.id === id)));
  return { created: plan.creates.length, updated: updatedIds.size, salaries: plan.salaries.length, titleIds };
}

export async function defaultShift(transaction?: Transaction): Promise<string | null> {
  const [row] = await select<{ id: string }>('SELECT id FROM shifts WHERE is_default AND is_active LIMIT 1', {}, transaction);
  return row?.id ?? null;
}
