import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { Transaction } from 'sequelize';
import { DEFAULT_PAYROLL_RULES, SystemSettings, normalizeSystemSettings } from '../config/systemSettings';
import { sequelize } from '../models';
import { SETTINGS_ID } from '../services/settings';
import { loadWorkbook } from '../services/xlsx';
import { execute, select, selectOne, transaction } from './query';
import { runMigrations } from './migrator';

/**
 * One-off loader for the company's own HR workbooks (never committed: they hold
 * names and salaries). Reads every .xlsx in a folder and recognises:
 *   - branch payroll workbooks ("01 Employee Data" … "04 Payroll"), one per city;
 *   - the group employee register ("Employees" sheet with "Emp Code");
 *   - the leave system ("الموظفون" sheet with direct-manager codes).
 * It can be run again: rows are matched by employee code, so it updates rather
 * than duplicates. Monthly figures (payable days, commissions, other
 * deductions, loans) are loaded for the payroll month on each workbook's
 * dashboard.
 *
 *   npm run import:company -- /path/to/folder
 */

/** One workbook: its file name (for messages) and its bytes. */
export interface WorkbookSource { name: string; data: Buffer }

type Cell = string | number | Date | boolean | null;
type Row = Cell[];

const COMPONENT = {
  commission: '30000000-0000-4000-8000-000000000004',
  bonus: '30000000-0000-4000-8000-000000000005',
  retroactive: '30000000-0000-4000-8000-000000000006',
  carPenalties: '30000000-0000-4000-8000-000000000008',
  otherDeduction: '30000000-0000-4000-8000-000000000009',
  socialSecurity: '30000000-0000-4000-8000-000000000011',
  raise: '30000000-0000-4000-8000-000000000014',
  loans: '30000000-0000-4000-8000-000000000015',
};
const IMPORT_NOTE = 'استيراد من ملف الرواتب';

/** The eleven departments of the payroll classification, with their Arabic names. */
const DEPARTMENTS: Array<{ code: string; en: string; ar: string }> = [
  { code: 'EXE', en: 'Executive Management', ar: 'الإدارة التنفيذية' },
  { code: 'ADM', en: 'Administration', ar: 'الإدارة' },
  { code: 'AUD', en: 'Internal Audit', ar: 'التدقيق الداخلي' },
  { code: 'LEG', en: 'Legal Affairs', ar: 'الشؤون القانونية' },
  { code: 'HRM', en: 'Human Resources', ar: 'الموارد البشرية' },
  { code: 'FIN', en: 'Finance & Accounting', ar: 'المالية والحسابات' },
  { code: 'ICT', en: 'Information Technology', ar: 'تقنية المعلومات' },
  { code: 'SAL', en: 'Sales', ar: 'المبيعات' },
  { code: 'MKT', en: 'Marketing & CRM', ar: 'التسويق وعلاقات العملاء' },
  { code: 'AFS', en: 'After-Sales Services', ar: 'خدمات ما بعد البيع' },
  { code: 'LOG', en: 'Logistics', ar: 'اللوجستيات' },
];

const SECTIONS_AR: Record<string, string> = {
  'Support Services': 'الخدمات المساندة', 'Service Workshop': 'ورشة الصيانة', 'Sales Team': 'فريق المبيعات',
  CRM: 'علاقات العملاء', 'Logistics Operations': 'العمليات اللوجستية', Treasury: 'الخزينة', Security: 'الأمن والحراسة',
  Accounting: 'المحاسبة', Transport: 'النقل', 'Sales Management': 'إدارة المبيعات', Marketing: 'التسويق',
  'Workshop Management': 'إدارة الورشة', 'Spare Parts': 'قطع الغيار', 'Vehicle Preparation': 'تجهيز المركبات',
  'Finance Management': 'الإدارة المالية', 'IT Support': 'الدعم الفني', 'Banking Coordination': 'التنسيق المصرفي',
  Warehouse: 'المخازن', 'IT Management': 'إدارة تقنية المعلومات', 'Showroom Support': 'دعم المعرض',
  Management: 'الإدارة', 'Logistics Management': 'إدارة اللوجستيات', Maintenance: 'الصيانة العامة', Procurement: 'المشتريات',
};

/** Department names used in the branch workbooks → the eleven departments. */
function departmentFromPayroll(name: string): string {
  const value = name.toLowerCase();
  if (/after|service|ما بعد/.test(value)) return 'After-Sales Services';
  if (/logist/.test(value)) return 'Logistics';
  if (/account|financ/.test(value)) return 'Finance & Accounting';
  if (/crm|market/.test(value)) return 'Marketing & CRM';
  if (/sales/.test(value)) return 'Sales';
  if (/ict|it\b/.test(value)) return 'Information Technology';
  if (/law|legal/.test(value)) return 'Legal Affairs';
  if (/^hr|human/.test(value)) return 'Human Resources';
  if (/audit/.test(value)) return 'Internal Audit';
  if (/^ex|executive/.test(value)) return 'Executive Management';
  return 'Administration';
}

const BRANCHES: Array<{ code: string; name: string; city: string; match: RegExp }> = [
  { code: 'BGD-NAH1', name: 'بغداد - النهضة 1', city: 'بغداد', match: /nahda\s*\.?\s*1/i },
  { code: 'BGD-NAH2', name: 'بغداد - النهضة 2', city: 'بغداد', match: /nahda\s*\.?\s*2/i },
  { code: 'BGD-OQBA', name: 'بغداد - عقبة', city: 'بغداد', match: /oqba/i },
  { code: 'BGD-BAYA', name: 'بغداد - البياع', city: 'بغداد', match: /bayaa/i },
  { code: 'BGD-PTUN', name: 'بغداد - نفق الشرطة', city: 'بغداد', match: /police|shurta/i },
  { code: 'BGD-FAHW', name: 'بغداد - مخزن الفحامة', city: 'بغداد', match: /fahama/i },
  { code: 'EBL', name: 'أربيل', city: 'أربيل', match: /erbil/i },
  { code: 'MSL-1', name: 'الموصل 1', city: 'الموصل', match: /mosul\s*\.?\s*1/i },
  { code: 'MSL-2', name: 'الموصل 2', city: 'الموصل', match: /mosul\s*\.?\s*2/i },
];

const LEAVE_TYPES = {
  annual: '40000000-0000-4000-8000-000000000001',
  sick: '40000000-0000-4000-8000-000000000002',
};

function plain(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if ('result' in value) return plain(value.result as ExcelJS.CellValue);
    if ('richText' in value) return value.richText.map((part) => part.text).join('');
    if ('text' in value) return String(value.text);
    if ('error' in value) return null;
    return null;
  }
  return value as Cell;
}

function rows(sheet: ExcelJS.Worksheet): Row[] {
  const out: Row[] = [];
  sheet.eachRow({ includeEmpty: true }, (row, number) => {
    const values = (row.values as ExcelJS.CellValue[]).slice(1).map(plain);
    out[number - 1] = values;
  });
  for (let index = 0; index < out.length; index += 1) out[index] ??= [];
  return out;
}

const text = (value: Cell): string => (value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim());
const num = (value: Cell): number => (typeof value === 'number' ? value : Number(text(value).replace(/,/g, '')) || 0);
const code = (value: Cell): string | null => {
  const raw = text(value);
  return /^\d{3,8}$/.test(raw.replace(/\.0+$/, '')) ? raw.replace(/\.0+$/, '') : null;
};
function isoDate(value: Cell): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const raw = text(value);
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

/** Column index (0-based) whose header in `headerRow` matches. */
function column(sheetRows: Row[], headerRow: number, pattern: RegExp, required = true): number {
  const index = (sheetRows[headerRow - 1] ?? []).findIndex((cell) => pattern.test(text(cell)));
  if (index < 0 && required) throw new Error(`Column ${pattern} not found in header row ${headerRow}`);
  return index;
}

function addMonths(period: string, months: number): string {
  const [year, month] = period.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + months, 1));
  return date.toISOString().slice(0, 7);
}

interface PayrollEmployee {
  code: string;
  nameEn: string;
  nameAr: string | null;
  governorate: string;
  branch: string;
  department: string;
  position: string;
  hireDate: string | null;
  status: 'Active' | 'Terminated' | 'On Hold' | string;
  gross: number;
  currency: string;
  raise: number;
  socialSecurityBase: number;
  terminationDate: string | null;
  notes: string;
  payableDays: number | null;
  absenceDays: number;
  otherDeduction: number;
  /** Amounts typed into the payroll sheet for the month (commission, bonus, …) keyed by component id. */
  monthly: Record<string, number>;
  annualBalance: number | null;
  sickBalance: number | null;
  file: string;
}

interface Loan {
  code: string; currency: string; principal: number; months: number; installment: number; paidCount: number;
  thisMonth: number; active: boolean; notes: string; row: number;
}

interface BranchWorkbook {
  file: string;
  period: string;
  fxRate: number;
  employees: PayrollEmployee[];
  loans: Loan[];
  commissions: Array<{ code: string; amount: number; note: string }>;
  expectedNet: Map<string, { net: number; totalEarnings: number; netIqd: number }>;
}

async function readBranchWorkbook(source: WorkbookSource): Promise<BranchWorkbook> {
  const workbook = await loadWorkbook(source.data);
  const sheet = (name: string) => {
    const found = workbook.getWorksheet(name);
    if (!found) throw new Error(`${source.name}: sheet "${name}" missing`);
    return rows(found);
  };
  const dashboard = sheet('00 Dashboard');
  const setting = (label: RegExp): Cell => dashboard.find((row) => row.some((cell) => label.test(text(cell))))?.[1] ?? null;
  const period = text(setting(/Payroll Month/i));
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error(`${source.name}: payroll month not found on the dashboard`);
  const fxRate = num(setting(/USD Rate/i)) || 1500;

  const data = sheet('01 Employee Data');
  const H = 5;
  const c = {
    code: column(data, H, /^Code/i), en: column(data, H, /Name \(EN\)/i), ar: column(data, H, /Name \(AR\)/i),
    gov: column(data, H, /المحافظة|Governorate/i), branch: column(data, H, /^Branch/i), dept: column(data, H, /^Dept/i),
    position: column(data, H, /^Position/i), start: column(data, H, /Start Date/i), status: column(data, H, /^Status/i),
    gross: column(data, H, /Gross Salary/i), ccy: column(data, H, /^Currency/i), raise: column(data, H, /Salary Raise/i),
    ss: column(data, H, /SS Platform/i), term: column(data, H, /Termination Date/i), notes: column(data, H, /^Notes/i),
  };
  const attendance = sheet('02 Attendance & Leave');
  const a = {
    code: column(attendance, H, /^Code/i), payable: column(attendance, H, /Payable Days/i),
    absence: column(attendance, H, /^Absence/i), other: column(attendance, H, /Other Deduction/i),
    balance: column(attendance, H, /Cumulative Balance/i), sick: column(attendance, H, /^Sick Balance/i),
  };
  const attendanceByCode = new Map<string, Row>();
  for (const row of attendance.slice(H)) {
    const key = code(row[a.code]);
    if (key) attendanceByCode.set(key, row);
  }

  const employees: PayrollEmployee[] = [];
  for (const row of data.slice(H)) {
    const key = code(row[c.code]);
    if (!key) continue;
    const att = attendanceByCode.get(key);
    employees.push({
      code: key,
      nameEn: text(row[c.en]),
      nameAr: text(row[c.ar]) || null,
      governorate: text(row[c.gov]),
      branch: text(row[c.branch]),
      department: text(row[c.dept]),
      position: text(row[c.position]),
      hireDate: isoDate(row[c.start]),
      status: text(row[c.status]),
      gross: num(row[c.gross]),
      currency: text(row[c.ccy]).toUpperCase() || 'IQD',
      raise: num(row[c.raise]),
      socialSecurityBase: num(row[c.ss]),
      terminationDate: isoDate(row[c.term]),
      notes: text(row[c.notes]),
      payableDays: att && text(att[a.payable]) !== '' ? num(att[a.payable]) : null,
      absenceDays: att ? num(att[a.absence]) : 0,
      otherDeduction: att ? num(att[a.other]) : 0,
      monthly: {},
      annualBalance: att && text(att[a.balance]) !== '' ? num(att[a.balance]) : null,
      sickBalance: att && text(att[a.sick]) !== '' ? num(att[a.sick]) : null,
      file: source.name,
    });
  }

  const loanSheet = sheet('03 Loans & Commissions');
  const commissionHeader = loanSheet.findIndex((row, index) => index > H && /Month/i.test(text(row[2])) && /Name/i.test(text(row[1])));
  const loans: Loan[] = [];
  for (let index = H; index < (commissionHeader > 0 ? commissionHeader - 1 : loanSheet.length); index += 1) {
    const row = loanSheet[index];
    const key = code(row[0]);
    if (!key || !num(row[4])) continue;
    loans.push({
      code: key, currency: text(row[3]).toUpperCase(), principal: num(row[4]), months: num(row[5]), installment: num(row[6]),
      paidCount: num(row[7]), thisMonth: num(row[9]), active: /active/i.test(text(row[10])), notes: text(row[12]) || text(row[11]),
      row: index + 1,
    });
  }
  const commissions: BranchWorkbook['commissions'] = [];
  if (commissionHeader > 0) {
    for (const row of loanSheet.slice(commissionHeader + 1)) {
      const key = code(row[0]);
      if (!key || text(row[2]) !== period || !num(row[6])) continue;
      commissions.push({ code: key, amount: num(row[6]), note: [text(row[3]), text(row[7])].filter(Boolean).join(' - ') });
    }
  }

  // The payroll sheet is what was actually paid: HR types some amounts straight
  // into it over the formulas, so the month's figures are read from there.
  const payroll = sheet('04 Payroll');
  const p = {
    code: column(payroll, H, /^Code/i), total: column(payroll, H, /^Total Salary/i),
    net: column(payroll, H, /^Final Pay/i), netIqd: column(payroll, H, /^Final \(IQD/i),
    payable: column(payroll, H, /^Payable Days/i), absence: column(payroll, H, /^Abs(ence|\.)(?!.*Ded)/i),
    retro: column(payroll, H, /^Retroactive/i), commission: column(payroll, H, /^Commission/i), bonus: column(payroll, H, /^Bonus/i),
    car: column(payroll, H, /^Car Penalties/i), other: column(payroll, H, /^Other Ded/i),
  };
  const byCode = new Map(employees.map((employee) => [employee.code, employee]));
  const expectedNet = new Map<string, { net: number; totalEarnings: number; netIqd: number }>();
  for (const row of payroll.slice(H)) {
    const key = code(row[p.code]);
    if (!key) continue;
    expectedNet.set(key, { net: num(row[p.net]), totalEarnings: num(row[p.total]), netIqd: num(row[p.netIqd]) });
    const employee = byCode.get(key);
    if (!employee) continue;
    if (text(row[p.payable]) !== '') employee.payableDays = num(row[p.payable]);
    employee.absenceDays = num(row[p.absence]);
    employee.otherDeduction = num(row[p.other]);
    employee.monthly = {
      [COMPONENT.retroactive]: num(row[p.retro]), [COMPONENT.commission]: num(row[p.commission]),
      [COMPONENT.bonus]: num(row[p.bonus]), [COMPONENT.carPenalties]: num(row[p.car]),
    };
  }
  return { file: source.name, period, fxRate, employees, loans, commissions, expectedNet };
}

interface RegisterRow {
  code: string; department: string; section: string; position: string; branch: string; gender: string | null;
  nationality: string | null; startDate: string | null; status: string;
}

async function readRegister(source: WorkbookSource): Promise<Map<string, RegisterRow>> {
  const workbook = await loadWorkbook(source.data);
  const sheetRows = rows(workbook.getWorksheet('Employees')!);
  const headerRow = sheetRows.findIndex((row) => row.some((cell) => /Emp Code/i.test(text(cell)))) + 1;
  const c = {
    code: column(sheetRows, headerRow, /Emp Code/i), dept: column(sheetRows, headerRow, /^Department/i),
    section: column(sheetRows, headerRow, /Section/i), position: column(sheetRows, headerRow, /^Position/i),
    branch: column(sheetRows, headerRow, /^Branch/i), gender: column(sheetRows, headerRow, /^Gender/i),
    nationality: column(sheetRows, headerRow, /^Nationality/i), start: column(sheetRows, headerRow, /Start Date/i),
    status: column(sheetRows, headerRow, /^Status/i),
  };
  const out = new Map<string, RegisterRow>();
  for (const row of sheetRows.slice(headerRow)) {
    const key = code(row[c.code]);
    if (!key) continue;
    out.set(key, {
      code: key, department: text(row[c.dept]), section: text(row[c.section]), position: text(row[c.position]),
      branch: text(row[c.branch]), gender: text(row[c.gender]) || null, nationality: text(row[c.nationality]) || null,
      startDate: isoDate(row[c.start]), status: text(row[c.status]),
    });
  }
  return out;
}

async function readLeaveSystem(source: WorkbookSource): Promise<Map<string, { nameAr: string | null; managerCode: string | null }>> {
  const workbook = await loadWorkbook(source.data);
  const sheetRows = rows(workbook.getWorksheet('الموظفون')!);
  const headerRow = sheetRows.findIndex((row) => row.some((cell) => text(cell) === 'كود الموظف')) + 1;
  const c = {
    code: column(sheetRows, headerRow, /^كود الموظف$/), ar: column(sheetRows, headerRow, /الاسم بالعربي/),
    manager: column(sheetRows, headerRow, /كود المدير المباشر/),
  };
  const out = new Map<string, { nameAr: string | null; managerCode: string | null }>();
  for (const row of sheetRows.slice(headerRow)) {
    const key = code(row[c.code]);
    if (key) out.set(key, { nameAr: text(row[c.ar]) || null, managerCode: code(row[c.manager]) });
  }
  return out;
}

async function sheetNames(source: WorkbookSource): Promise<string[]> {
  const workbook = await loadWorkbook(source.data);
  return workbook.worksheets.map((sheet) => sheet.name);
}

async function upsertBranch(branch: typeof BRANCHES[number], tx: Transaction): Promise<string> {
  const existing = await selectOne<{ id: string }>('SELECT id FROM branches WHERE code = :code', { code: branch.code }, tx);
  if (existing) {
    await execute('UPDATE branches SET name = :name, city = :city, updated_at = now() WHERE id = :id', { ...branch, id: existing.id }, tx);
    return existing.id;
  }
  const id = randomUUID();
  await execute(
    'INSERT INTO branches (id, code, name, city, is_active, created_at, updated_at) VALUES (:id, :code, :name, :city, true, now(), now())',
    { id, code: branch.code, name: branch.name, city: branch.city },
    tx,
  );
  return id;
}

async function upsertDepartment(codeValue: string, name: string, parentId: string | null, sortOrder: number, tx: Transaction): Promise<string> {
  const existing = await selectOne<{ id: string }>('SELECT id FROM departments WHERE code = :code', { code: codeValue }, tx);
  if (existing) {
    await execute('UPDATE departments SET name = :name, parent_id = :parentId, sort_order = :sortOrder, updated_at = now() WHERE id = :id',
      { id: existing.id, name, parentId, sortOrder }, tx);
    return existing.id;
  }
  const id = randomUUID();
  await execute(
    `INSERT INTO departments (id, code, name, parent_id, cost_center_code, sort_order)
     VALUES (:id, :code, :name, :parentId, :costCenter, :sortOrder)`,
    { id, code: codeValue, name, parentId, costCenter: parentId ? null : codeValue, sortOrder },
    tx,
  );
  return id;
}

/**
 * Loads the company's workbooks. Used by the CLI below and by the
 * administrator's upload screen; returns the summary lines instead of printing.
 */
export async function importCompany(files: WorkbookSource[], importedBy?: string): Promise<string[]> {
  const branchBooks: BranchWorkbook[] = [];
  let register = new Map<string, RegisterRow>();
  let leaveSystem = new Map<string, { nameAr: string | null; managerCode: string | null }>();
  for (const file of files) {
    const names = await sheetNames(file);
    if (names.includes('01 Employee Data') && names.includes('04 Payroll')) branchBooks.push(await readBranchWorkbook(file));
    else if (names.includes('Employees')) register = await readRegister(file);
    else if (names.includes('الموظفون')) leaveSystem = await readLeaveSystem(file);
  }
  if (!branchBooks.length) throw new Error('لم يُعثر على ملف رواتب فرع (ورقتا 01 Employee Data و04 Payroll).');
  const periods = [...new Set(branchBooks.map((book) => book.period))];
  if (periods.length > 1) throw new Error(`Workbooks are for different months: ${periods.join(', ')}`);
  const period = periods[0];

  const admin = importedBy ? { id: importedBy }
    : await selectOne<{ id: string }>("SELECT id FROM users WHERE role = 'super_admin' AND is_active ORDER BY created_at LIMIT 1");
  if (!admin) throw new Error('Start the API once so the administrator account exists, then run the import.');
  const userId = admin.id;
  const report: string[] = [];

  await transaction(async (tx) => {
    // Settings: social security as the company applies it, leavers paid by settlement, leave types.
    const settingsRow = await selectOne<{ value: Partial<SystemSettings> }>('SELECT value FROM system_settings WHERE id = :id', { id: SETTINGS_ID }, tx);
    const settings = normalizeSystemSettings((settingsRow?.value ?? null) as SystemSettings | null);
    const components = [...settings.payrollRules.components];
    for (const required of DEFAULT_PAYROLL_RULES.components) {
      if (!components.some((item) => item.id === required.id)) components.push(required);
    }
    const ss = components.find((item) => item.id === COMPONENT.socialSecurity)!;
    Object.assign(ss, {
      calculation: 'percentage_of_ss_base', rate: 5, minBase: 350000, maxBase: 1750000, roundingDigits: 0,
      active: true, legalApproved: true,
    });
    settings.payrollRules = { ...settings.payrollRules, components, monthlyDivisor: 30, terminatedPaidBySettlement: true, approvalChain: true, launchPeriod: settings.payrollRules.launchPeriod ?? '2026-09' };
    if (!settings.company.legalName) settings.company.legalName = 'شركة ليث العبيدي للسيارات';
    if (!settings.leaveTypes.length) {
      settings.leaveTypes = [
        { id: LEAVE_TYPES.annual, name: 'إجازة سنوية', unit: 'days', paid: true, active: true, annualEntitlement: 21, carryForwardLimit: null, dayCountBasis: 'working' },
        { id: LEAVE_TYPES.sick, name: 'إجازة مرضية', unit: 'days', paid: true, active: true, annualEntitlement: 15, carryForwardLimit: 180, requiresMedicalCertificate: true },
        { id: '40000000-0000-4000-8000-000000000003', name: 'إجازة طارئة', unit: 'days', paid: true, active: true, annualEntitlement: 6, carryForwardLimit: 0 },
        { id: '40000000-0000-4000-8000-000000000004', name: 'إجازة زواج', unit: 'days', paid: true, active: true, annualEntitlement: 5, carryForwardLimit: 0, deductsBalance: false },
        { id: '40000000-0000-4000-8000-000000000005', name: 'إجازة وفاة / عزاء', unit: 'days', paid: true, active: true, annualEntitlement: 5, carryForwardLimit: 0, deductsBalance: false },
        { id: '40000000-0000-4000-8000-000000000006', name: 'إجازة بدون راتب', unit: 'days', paid: false, active: true, annualEntitlement: null, carryForwardLimit: null, deductsBalance: false },
        { id: '40000000-0000-4000-8000-000000000007', name: 'إجازة زمنية', unit: 'hours', paid: true, active: true, annualEntitlement: null, carryForwardLimit: null, deductsBalance: false },
      ];
      settings.leaveRules = { ...settings.leaveRules, workingDays: [0, 1, 2, 3, 4, 6] };
    }
    await execute(
      `INSERT INTO system_settings (id, value, updated_by, updated_at) VALUES (:id, :value::jsonb, :userId, now())
       ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      { id: SETTINGS_ID, value: JSON.stringify(settings), userId },
      tx,
    );

    // Branches and the department tree (department → section).
    const branchIds = new Map<string, string>();
    for (const branch of BRANCHES) branchIds.set(branch.code, await upsertBranch(branch, tx));
    // Dollar rates: the Baghdad workbook's rate by default, each city's own rate for its branches.
    const cityRate = (pattern: RegExp) => branchBooks.find((book) => book.employees.some((item) => pattern.test(item.governorate)))?.fxRate;
    const defaultRate = cityRate(/baghdad/i) ?? branchBooks[0].fxRate;
    const branchUsdRates: Record<string, number> = {};
    for (const branch of BRANCHES) {
      const rate = cityRate(branch.code.startsWith('EBL') ? /erbil/i : branch.code.startsWith('MSL') ? /mosul/i : /baghdad/i);
      if (rate && rate !== defaultRate) branchUsdRates[branchIds.get(branch.code)!] = rate;
    }
    await execute(
      `UPDATE system_settings SET value = jsonb_set(jsonb_set(value, '{payrollRules,usdRate}', to_jsonb(:rate::numeric)),
         '{payrollRules,branchUsdRates}', :rates::jsonb) WHERE id = :id`,
      { id: SETTINGS_ID, rate: defaultRate, rates: JSON.stringify(branchUsdRates) },
      tx,
    );
    const branchFor = (employee: PayrollEmployee, reg?: RegisterRow): string => {
      const candidates = [reg?.branch, employee.branch].filter((value): value is string => Boolean(value));
      for (const candidate of candidates) {
        const found = BRANCHES.find((branch) => branch.match.test(candidate));
        if (found) return branchIds.get(found.code)!;
      }
      const city = /erbil/i.test(employee.governorate) ? 'EBL' : /mosul/i.test(employee.governorate) ? 'MSL-1' : 'BGD-NAH1';
      report.push(`${employee.code}: لا يوجد فرع في الملف، وُضع على ${BRANCHES.find((branch) => branch.code === city)!.name}`);
      return branchIds.get(city)!;
    };
    const departmentIds = new Map<string, string>();
    for (const [index, department] of DEPARTMENTS.entries()) {
      departmentIds.set(department.en, await upsertDepartment(department.code, department.ar, null, index, tx));
    }
    const sectionIds = new Map<string, string>();
    const sectionFor = async (department: string, section: string): Promise<string> => {
      const parent = departmentIds.get(department)!;
      if (!section || section === department) return parent;
      const key = `${department}|${section}`;
      if (!sectionIds.has(key)) {
        const parentCode = DEPARTMENTS.find((item) => item.en === department)!.code;
        const slug = section.replace(/[^A-Za-z]/g, '').slice(0, 10).toUpperCase();
        sectionIds.set(key, await upsertDepartment(`${parentCode}-${slug}`, SECTIONS_AR[section] ?? section, parent, sectionIds.size, tx));
      }
      return sectionIds.get(key)!;
    };

    // Job titles by name.
    const titleIds = new Map<string, string>();
    for (const title of await select<{ id: string; name: string }>('SELECT id, name FROM job_titles', {}, tx)) {
      titleIds.set(title.name.toLowerCase(), title.id);
    }
    const titleFor = async (name: string): Promise<string | null> => {
      const clean = name.trim();
      if (!clean) return null;
      const key = clean.toLowerCase();
      if (!titleIds.has(key)) {
        const id = randomUUID();
        await execute('INSERT INTO job_titles (id, code, name) VALUES (:id, :code, :name)',
          { id, code: `JT-${String(titleIds.size + 1).padStart(3, '0')}`, name: clean.slice(0, 120) }, tx);
        titleIds.set(key, id);
      }
      return titleIds.get(key)!;
    };

    const employeeIds = new Map<string, string>();
    const all = branchBooks.flatMap((book) => book.employees);
    for (const employee of all) {
      const reg = register.get(employee.code);
      const leave = leaveSystem.get(employee.code);
      const department = reg?.department && departmentIds.has(reg.department) ? reg.department : departmentFromPayroll(employee.department);
      const departmentId = await sectionFor(department, reg?.section ?? '');
      const position = reg?.position || employee.position || 'غير محدد';
      const jobTitleId = await titleFor(position);
      const hireDate = employee.hireDate ?? reg?.startDate ?? null;
      if (!hireDate) report.push(`${employee.code}: لا يوجد تاريخ مباشرة، استُخدم 2026-01-01 مؤقتاً`);
      const status = /hold/i.test(employee.status) ? 'suspended' : /terminat/i.test(employee.status) ? 'inactive' : 'active';
      if (status === 'inactive' && !employee.terminationDate) report.push(`${employee.code}: منتهي الخدمة بلا تاريخ ترك`);
      const fullName = (employee.nameAr || leave?.nameAr || employee.nameEn).slice(0, 180);
      const values = {
        employeeNo: employee.code, fullName, branchId: branchFor(employee, reg),
        department: (DEPARTMENTS.find((item) => item.en === department)?.ar ?? department).slice(0, 120),
        position: position.slice(0, 120), hireDate: hireDate ?? '2026-01-01', status,
        departmentId, jobTitleId, terminationDate: status === 'inactive' ? employee.terminationDate : null,
      };
      const existing = await selectOne<{ id: string }>('SELECT id FROM employees WHERE employee_no = :code', { code: employee.code }, tx);
      const id = existing?.id ?? randomUUID();
      if (existing) {
        await execute(
          `UPDATE employees SET full_name = :fullName, branch_id = :branchId, department = :department, "position" = :position,
             hire_date = :hireDate, employment_status = :status::enum_employees_employment_status, department_id = :departmentId,
             job_title_id = :jobTitleId, termination_date = :terminationDate, updated_at = now()
           WHERE id = :id`,
          { ...values, id }, tx,
        );
      } else {
        await execute(
          `INSERT INTO employees (id, employee_no, full_name, branch_id, department, "position", hire_date, employment_status,
             custom_fields, department_id, job_title_id, termination_date, employment_type, created_at, updated_at)
           VALUES (:id, :employeeNo, :fullName, :branchId, :department, :position, :hireDate,
             :status::enum_employees_employment_status, '{}'::jsonb, :departmentId, :jobTitleId, :terminationDate, 'permanent', now(), now())`,
          { ...values, id }, tx,
        );
      }
      employeeIds.set(employee.code, id);

      const gender = /female/i.test(reg?.gender ?? '') ? 'female' : /male/i.test(reg?.gender ?? '') ? 'male' : null;
      await execute(
        `INSERT INTO employee_profiles (employee_id, name_en, gender, nationality, governorate, updated_by, updated_at)
         VALUES (:id, :nameEn, :gender, :nationality, :governorate, :userId, now())
         ON CONFLICT (employee_id) DO UPDATE SET name_en = EXCLUDED.name_en,
           gender = COALESCE(EXCLUDED.gender, employee_profiles.gender),
           nationality = COALESCE(EXCLUDED.nationality, employee_profiles.nationality),
           governorate = COALESCE(EXCLUDED.governorate, employee_profiles.governorate), updated_at = now()`,
        { id, nameEn: employee.nameEn.slice(0, 180) || null, gender, nationality: reg?.nationality ?? null, governorate: employee.governorate || null, userId },
        tx,
      );

      // Salary record effective from the hire date (or 1 January when hired earlier).
      const effectiveFrom = hireDate && hireDate > '2026-01-01' ? hireDate : '2026-01-01';
      const overrides = employee.raise ? { [COMPONENT.raise]: employee.raise } : {};
      await execute(
        `INSERT INTO employee_compensation (id, employee_id, effective_from, gross_salary, currency, component_overrides,
           social_security_base, reason, created_by)
         VALUES (:cid, :id, :effectiveFrom, :gross, :currency, :overrides::jsonb, :ssBase, :reason, :userId)
         ON CONFLICT (employee_id, effective_from) DO UPDATE SET gross_salary = EXCLUDED.gross_salary, currency = EXCLUDED.currency,
           component_overrides = EXCLUDED.component_overrides, social_security_base = EXCLUDED.social_security_base`,
        {
          cid: randomUUID(), id, effectiveFrom, gross: employee.gross, currency: employee.currency,
          overrides: JSON.stringify(overrides), ssBase: employee.socialSecurityBase || null,
          reason: `${IMPORT_NOTE} ${period}`, userId,
        },
        tx,
      );
    }

    // Direct managers from the leave system.
    for (const [employeeCode, entry] of leaveSystem) {
      const id = employeeIds.get(employeeCode);
      const managerId = entry.managerCode ? employeeIds.get(entry.managerCode) : undefined;
      if (id && managerId && managerId !== id) {
        await execute('UPDATE employees SET manager_id = :managerId WHERE id = :id', { id, managerId }, tx);
      }
    }

    // Monthly figures for the payroll month: replace what an earlier import loaded.
    const ids = [...employeeIds.values()];
    await execute(`DELETE FROM payroll_inputs WHERE period = :period AND note LIKE :note AND employee_id IN (:ids)`,
      { period, note: `${IMPORT_NOTE}%`, ids }, tx);
    for (const book of branchBooks) {
      for (const employee of book.employees) {
        const id = employeeIds.get(employee.code)!;
        if (employee.status !== 'Active') continue;
        if (employee.payableDays !== null || employee.absenceDays) {
          await execute(
            `INSERT INTO payroll_day_adjustments (period, employee_id, payable_days, absence_days, note, updated_by)
             VALUES (:period, :id, :payable, :absence, :note, :userId)
             ON CONFLICT (period, employee_id) DO UPDATE SET payable_days = EXCLUDED.payable_days,
               absence_days = EXCLUDED.absence_days, note = EXCLUDED.note, updated_at = now()`,
            { period, id, payable: employee.payableDays, absence: employee.absenceDays, note: IMPORT_NOTE, userId },
            tx,
          );
        }
        const amounts = { ...employee.monthly, [COMPONENT.otherDeduction]: employee.otherDeduction };
        for (const [component, amount] of Object.entries(amounts)) {
          if (!(amount > 0)) continue;
          const commissionNote = component === COMPONENT.commission
            ? book.commissions.filter((item) => item.code === employee.code).map((item) => item.note).filter(Boolean).join('، ')
            : '';
          await execute(
            `INSERT INTO payroll_inputs (id, period, employee_id, component_id, amount, note, created_by)
             VALUES (:iid, :period, :id, :component, :amount, :note, :userId)`,
            { iid: randomUUID(), period, id, component, amount, note: `${IMPORT_NOTE}${commissionNote ? ` - ${commissionNote}` : ''}`.slice(0, 500), userId },
            tx,
          );
        }
      }
      for (const loan of book.loans) {
        const id = employeeIds.get(loan.code);
        if (!id) { report.push(`سلفة لرمز غير موجود ${loan.code}`); continue; }
        const paidBefore = Math.min(loan.principal, loan.paidCount * loan.installment);
        const remaining = loan.principal - paidBefore;
        const final = loan.months > 0 && loan.paidCount + 1 >= loan.months && remaining < 2 * loan.installment;
        const expected = loan.active ? (final ? remaining : Math.min(loan.installment, remaining)) : 0;
        if (Math.abs(expected - loan.thisMonth) > 0.01) {
          report.push(`سلفة ${loan.code} (سطر ${loan.row}): استقطاع الملف ${loan.thisMonth} والمحسوب ${expected}`);
        }
        const reference = `XL-${loan.code}-${loan.row}`;
        const status = loan.active && remaining > 0 ? 'active' : remaining > 0 ? 'suspended' : 'closed';
        const existing = await selectOne<{ id: string }>('SELECT id FROM employee_loans WHERE reference = :reference', { reference }, tx);
        const values = {
          id, currency: loan.currency || 'IQD', principal: loan.principal, installment: loan.installment || loan.principal,
          paidBefore, startPeriod: addMonths(period, -loan.paidCount), status,
          installmentsTotal: loan.months > 0 ? Math.round(loan.months) : null, paidCount: Math.round(loan.paidCount), reference, notes: loan.notes.slice(0, 1000) || null, userId,
        };
        // A loan already in the system is left alone: corrections made there win over the sheet.
        if (existing) continue;
        {
          await execute(
            `INSERT INTO employee_loans (id, employee_id, currency, principal, installment, paid_before, installments_total,
               installments_paid_before, start_period, status, reference, notes, created_by)
             VALUES (:loanId, :id, :currency, :principal, :installment, :paidBefore, :installmentsTotal, :paidCount,
               :startPeriod, :status, :reference, :notes, :userId)`,
            { ...values, loanId: randomUUID() }, tx,
          );
        }
      }
    }

    // Leave balances at the end of the payroll month, as opening entries.
    let openings = 0;
    for (const employee of all) {
      const id = employeeIds.get(employee.code)!;
      for (const [typeId, quantity] of [[LEAVE_TYPES.annual, employee.annualBalance], [LEAVE_TYPES.sick, employee.sickBalance]] as const) {
        if (quantity === null || employee.status === 'Terminated') continue;
        const exists = await selectOne('SELECT 1 FROM leave_ledger_entries WHERE employee_id = :id AND leave_type_id = :typeId AND entry_type = \'opening\'', { id, typeId }, tx);
        if (exists) continue;
        await execute(
          `INSERT INTO leave_ledger_entries (id, employee_id, leave_type_id, quantity, entry_type, reason, created_by, created_at)
           VALUES (:lid, :id, :typeId, :quantity, 'opening', :reason, :userId, now())`,
          { lid: randomUUID(), id, typeId, quantity: quantity.toFixed(2), reason: `رصيد نهاية ${period} من ملف الرواتب`, userId },
          tx,
        );
        openings += 1;
      }
    }

    await execute(
      `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details, created_at)
       VALUES (:id, :userId, 'company.data_imported', 'company', NULL, :details::jsonb, now())`,
      {
        id: randomUUID(), userId,
        details: JSON.stringify({ period, employees: all.length, files: files.length, loans: branchBooks.reduce((sum, book) => sum + book.loans.length, 0), openings }),
      },
      tx,
    );
  });

  const all = branchBooks.flatMap((book) => book.employees);
  const lines = [
    `Imported ${all.length} employees for ${period} from ${branchBooks.length} payroll workbooks.`,
    `  register rows: ${register.size}, leave system rows: ${leaveSystem.size}`,
    ...branchBooks.map((book) => `  ${book.file.split('/').pop()}: ${book.employees.length} employees, ${book.loans.length} loans, ${book.commissions.length} commissions, FX ${book.fxRate}`),
  ];
  if (report.length) lines.push('Notes:', ...report.map((line) => `  ${line}`));
  return lines;
}

async function main(): Promise<void> {
  const folder = process.argv[2];
  if (!folder) throw new Error('Usage: npm run import:company -- /path/to/folder-with-xlsx');
  await runMigrations();
  const files = readdirSync(folder).filter((name) => name.toLowerCase().endsWith('.xlsx'))
    .map((name) => ({ name, data: readFileSync(join(folder, name)) }));
  for (const line of await importCompany(files)) console.log(line);
  await sequelize.close();
}

if (require.main === module) {
  void main().catch(async (error: unknown) => {
    console.error('Import failed:', error instanceof Error ? error.stack : error);
    await sequelize.close().catch(() => undefined);
    process.exit(1);
  });
}
