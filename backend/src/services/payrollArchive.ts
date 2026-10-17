import ExcelJS from 'exceljs';
import { loadWorkbook } from './xlsx';

/**
 * Reads a month's payroll sheet that was paid outside the system, so it can
 * be kept in the payroll archive month by month. Two layouts are understood:
 * the company's branch workbook ("04 Payroll" with a dashboard holding the
 * month) and any sheet whose header has an employee-code and a net-pay column.
 */
export interface ArchiveLine {
  employeeNo: string;
  employeeName: string | null;
  currency: string;
  gross: number | null;
  totalEarnings: number | null;
  totalDeductions: number | null;
  netPay: number;
  details: Record<string, number | string>;
}

export interface ParsedArchive {
  format: 'branch-workbook' | 'generic';
  sheet: string;
  period: string | null;
  lines: ArchiveLine[];
  skipped: number;
}

type Cell = string | number | Date | boolean | null;

function plain(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if ('result' in value) return plain(value.result as ExcelJS.CellValue);
    if ('richText' in value) return value.richText.map((part) => part.text).join('');
    if ('text' in value) return String(value.text);
    return null;
  }
  return value as Cell;
}

function sheetRows(sheet: ExcelJS.Worksheet, limit = 5000): Cell[][] {
  const out: Cell[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, number) => {
    if (number > limit) return;
    out[number - 1] = (row.values as ExcelJS.CellValue[]).slice(1).map(plain);
  });
  for (let index = 0; index < out.length; index += 1) out[index] ??= [];
  return out;
}

const text = (value: Cell): string => (value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim());
const num = (value: Cell): number | null => {
  if (typeof value === 'number') return value;
  const raw = text(value).replace(/,/g, '');
  return raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
};
const code = (value: Cell): string | null => {
  const raw = text(value).replace(/\.0+$/, '');
  return /^[A-Za-z]{0,4}-?\d{2,10}$/.test(raw) ? raw : null;
};

const HEADERS = {
  code: /^(emp(loyee)?\s*)?(code|no\.?|number|id)$|^code|الرقم الوظيفي|رقم الموظف|^الرقم$|^الكود/i,
  name: /name|الاسم|اسم الموظف/i,
  net: /^final pay|^net( pay| salary)?$|صافي|الصافي|المبلغ المستحق|^المستحق/i,
  netIqd: /^final \(iqd/i,
  gross: /gross|total salary|الراتب الإجمالي|الاجمالي|الإجمالي/i,
  earnings: /total earnings|مجموع الاستحقاقات/i,
  deductions: /total deductions|^deductions$|مجموع الاستقطاعات|الاستقطاعات/i,
  currency: /currency|العملة/i,
};

function findHeader(rows: Cell[][]): { row: number; columns: Record<keyof typeof HEADERS, number> } | null {
  for (let index = 0; index < Math.min(rows.length, 20); index += 1) {
    const cells = rows[index].map(text);
    const find = (pattern: RegExp) => cells.findIndex((cell) => pattern.test(cell));
    const columns = Object.fromEntries(Object.entries(HEADERS).map(([key, pattern]) => [key, find(pattern)])) as Record<keyof typeof HEADERS, number>;
    if (columns.code >= 0 && columns.net >= 0) return { row: index, columns };
  }
  return null;
}

export async function parsePayrollArchive(data: Buffer, defaultCurrency: string): Promise<ParsedArchive> {
  const workbook = await loadWorkbook(data);
  let period: string | null = null;
  const dashboard = workbook.getWorksheet('00 Dashboard');
  if (dashboard) {
    const rows = sheetRows(dashboard, 60);
    const found = rows.find((row) => row.some((cell) => /Payroll Month/i.test(text(cell))));
    const value = found ? text(found[1]) : '';
    if (/^\d{4}-\d{2}$/.test(value)) period = value;
  }
  // Names and currencies come from the employee sheet in the branch workbook.
  const people = new Map<string, { name: string; currency: string }>();
  const employeeSheet = workbook.getWorksheet('01 Employee Data');
  if (employeeSheet) {
    const rows = sheetRows(employeeSheet);
    const header = rows.findIndex((row) => row.some((cell) => /^Code/i.test(text(cell))));
    if (header >= 0) {
      const cells = rows[header].map(text);
      const c = { code: cells.findIndex((cell) => /^Code/i.test(cell)), en: cells.findIndex((cell) => /Name \(EN\)/i.test(cell)),
        ar: cells.findIndex((cell) => /Name \(AR\)/i.test(cell)), ccy: cells.findIndex((cell) => /^Currency/i.test(cell)) };
      for (const row of rows.slice(header + 1)) {
        const key = code(row[c.code]);
        if (key) people.set(key, { name: text(row[c.ar]) || text(row[c.en]), currency: text(row[c.ccy]).toUpperCase() });
      }
    }
  }
  const preferred = workbook.getWorksheet('04 Payroll');
  const sheets = preferred ? [preferred] : workbook.worksheets;
  for (const sheet of sheets) {
    const rows = sheetRows(sheet);
    const header = findHeader(rows);
    if (!header) continue;
    const { columns } = header;
    const headerCells = rows[header.row].map(text);
    const lines: ArchiveLine[] = [];
    let skipped = 0;
    for (const row of rows.slice(header.row + 1)) {
      const key = code(row[columns.code]);
      const net = num(row[columns.net]);
      if (!key) continue;
      if (net === null) { skipped += 1; continue; }
      const person = people.get(key);
      const details: Record<string, number | string> = {};
      headerCells.forEach((label, index) => {
        if (!label || index === columns.code) return;
        const value = num(row[index]);
        if (value !== null && value !== 0) details[label.slice(0, 60)] = value;
      });
      lines.push({
        employeeNo: key,
        employeeName: (columns.name >= 0 ? text(row[columns.name]) : '') || person?.name || null,
        currency: ((columns.currency >= 0 ? text(row[columns.currency]).toUpperCase() : '') || person?.currency || defaultCurrency).slice(0, 3),
        gross: columns.gross >= 0 ? num(row[columns.gross]) : null,
        totalEarnings: columns.earnings >= 0 ? num(row[columns.earnings]) : null,
        totalDeductions: columns.deductions >= 0 ? num(row[columns.deductions]) : null,
        netPay: net,
        details,
      });
    }
    if (lines.length) return { format: preferred ? 'branch-workbook' : 'generic', sheet: sheet.name, period, lines, skipped };
  }
  throw new Error('NO_PAYROLL_SHEET');
}
