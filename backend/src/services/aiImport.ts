import ExcelJS from 'exceljs';
import { askJson } from './ai';
import { loadWorkbook } from './xlsx';

export const IMPORT_FIELDS = [
  'employeeNo', 'fullName', 'nameEn', 'branch', 'department', 'jobTitle', 'hireDate', 'birthDate', 'gender', 'phone', 'email',
  'nationality', 'nationalIdNo', 'passportNo', 'passportExpiry', 'residencyType', 'residencyExpiry', 'salary', 'currency',
  'bankName', 'bankAccountNo', 'employmentType', 'address', 'motherName', 'maritalStatus', 'educationLevel', 'bloodType',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Header words (Arabic and English) recognised for each field. */
const SYNONYMS: Record<ImportField, RegExp> = {
  employeeNo: /(الرقم الوظيفي|رقم الموظف|الرقم الوظيفى|كود|code|emp\.?\s*(no|id|#)|employee\s*(no|id|number)|staff\s*id)/i,
  fullName: /(الاسم الكامل|اسم الموظف|الاسم الرباعي|الاسم الثلاثي|^الاسم$|full\s*name|employee\s*name|^name$)/i,
  nameEn: /(الاسم بالانكليزي|الاسم بالإنكليزي|english\s*name|name\s*\(en\)|name en)/i,
  branch: /(الفرع|المعرض|branch|location|الموقع)/i,
  department: /(القسم|الإدارة|الادارة|department|dept)/i,
  jobTitle: /(المسمى|العنوان الوظيفي|الوظيفة|المنصب|job\s*title|position|designation)/i,
  hireDate: /(تاريخ المباشرة|تاريخ التعيين|تاريخ الالتحاق|hire\s*date|joining|date\s*of\s*join|start\s*date)/i,
  birthDate: /(تاريخ الميلاد|المواليد|birth|dob)/i,
  gender: /(^الجنس$|^gender$|^sex$)/i,
  phone: /(الهاتف|الموبايل|رقم الهاتف|mobile|phone|tel)/i,
  email: /(البريد|الإيميل|الايميل|e-?mail)/i,
  nationality: /(الجنسية|nationality)/i,
  nationalIdNo: /(البطاقة الموحدة|البطاقة الوطنية|رقم الهوية|national\s*id|id\s*no)/i,
  passportNo: /(رقم الجواز|جواز السفر|passport\s*(no|number)?$|passport\s*no)/i,
  passportExpiry: /(انتهاء الجواز|نفاذ الجواز|صلاحية الجواز|passport\s*exp)/i,
  residencyType: /(نوع الإقامة|نوع الاقامة|نوع الفيزا|residency\s*type|visa\s*type)/i,
  residencyExpiry: /(انتهاء الإقامة|انتهاء الاقامة|انتهاء الفيزا|صلاحية الإقامة|residency\s*exp|visa\s*exp)/i,
  salary: /(الراتب الإجمالي|الراتب الاجمالي|الراتب الكلي|إجمالي الراتب|اجمالي الراتب|^الراتب$|gross|salary|total\s*salary)/i,
  currency: /(العملة|currency|ccy)/i,
  bankName: /(اسم المصرف|المصرف|البنك|bank\s*name)/i,
  bankAccountNo: /(رقم الحساب|الحساب المصرفي|iban|account\s*(no|number))/i,
  employmentType: /(نوع التعيين|نوع العقد|employment\s*type|contract\s*type)/i,
  address: /(العنوان|السكن|address)/i,
  motherName: /(اسم الأم|اسم الام|mother)/i,
  maritalStatus: /(الحالة الاجتماعية|الحالة الزوجية|marital)/i,
  educationLevel: /(التحصيل الدراسي|الشهادة|المؤهل|education|qualification)/i,
  bloodType: /(فصيلة الدم|blood)/i,
};

export type Cell = string | number | Date | boolean | null;
export interface SheetSample { name: string; headerRow: number; headers: string[]; rows: Cell[][]; total: number }

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
export const text = (value: Cell): string => (value === null || value === undefined ? '' : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).replace(/\s+/g, ' ').trim());

/** Every sheet with its header row (the row in the first 15 with the most text cells) and its data rows. */
export async function readSheets(buffer: Buffer): Promise<SheetSample[]> {
  const workbook = await loadWorkbook(buffer);
  const out: SheetSample[] = [];
  for (const sheet of workbook.worksheets) {
    const rows: Cell[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row, number) => {
      if (number > 6000) return;
      rows[number - 1] = (row.values as ExcelJS.CellValue[]).slice(1).map(plain);
    });
    for (let index = 0; index < rows.length; index += 1) rows[index] ??= [];
    let headerRow = -1;
    let best = 0;
    for (let index = 0; index < Math.min(15, rows.length); index += 1) {
      const score = rows[index].filter((cell) => typeof cell === 'string' && cell.trim() && !/^\d+$/.test(cell.trim())).length;
      if (score > best) { best = score; headerRow = index; }
    }
    if (headerRow < 0 || best < 2) continue;
    const headers = rows[headerRow].map((cell) => text(cell));
    const data = rows.slice(headerRow + 1).filter((row) => row.some((cell) => text(cell)));
    out.push({ name: sheet.name, headerRow: headerRow + 1, headers, rows: data, total: data.length });
  }
  return out;
}

/** Column index for each field, by header words. */
export function guessMapping(headers: string[]): Partial<Record<ImportField, number>> {
  const mapping: Partial<Record<ImportField, number>> = {};
  const used = new Set<number>();
  // Specific fields first so "تاريخ انتهاء الجواز" is not taken as the passport number, and so on.
  const order: ImportField[] = ['passportExpiry', 'residencyExpiry', 'residencyType', 'hireDate', 'birthDate', 'nameEn', 'motherName', 'bankName', 'bankAccountNo',
    ...IMPORT_FIELDS.filter((field) => !['passportExpiry', 'residencyExpiry', 'residencyType', 'hireDate', 'birthDate', 'nameEn', 'motherName', 'bankName', 'bankAccountNo'].includes(field))];
  for (const field of order) {
    const index = headers.findIndex((header, position) => header && !used.has(position) && SYNONYMS[field].test(header));
    if (index >= 0) { mapping[field] = index; used.add(index); }
  }
  return mapping;
}

const SYSTEM = `You map spreadsheet columns of an Iraqi company's HR / payroll file to fields of an HR system.
Fields: ${IMPORT_FIELDS.join(', ')}.
Return ONLY JSON: {"sheets":[{"name": sheet name, "use": true|false (does the sheet hold one row per employee?), "mapping": {field: column index (0-based)}}], "notesAr": [short Arabic notes]}.
Map a field only when you are confident. salary = the monthly gross/total salary. employeeNo is required for a sheet to be used.`;

/** Lets the AI choose the sheets and columns (when switched on); the header-word guess is the fallback and the check. */
export async function mapSheets(sheets: SheetSample[], useAi: boolean): Promise<{ engine: 'ai' | 'rules'; plan: Array<{ sheet: SheetSample; mapping: Partial<Record<ImportField, number>> }>; notes: string[] }> {
  const guessed = sheets.map((sheet) => ({ sheet, mapping: guessMapping(sheet.headers) }));
  if (useAi) {
    const brief = sheets.map((sheet) => ({ name: sheet.name, headers: sheet.headers.map((header, index) => `${index}: ${header}`), sample: sheet.rows.slice(0, 4).map((row) => row.map(text)) }));
    const answer = await askJson<{ sheets?: Array<{ name: string; use?: boolean; mapping?: Record<string, number> }>; notesAr?: string[] }>(SYSTEM, JSON.stringify(brief), 3000);
    const plan = (answer.sheets ?? []).filter((item) => item.use !== false).map((item) => {
      const sheet = sheets.find((candidate) => candidate.name === item.name);
      if (!sheet) return null;
      const mapping: Partial<Record<ImportField, number>> = {};
      for (const [field, index] of Object.entries(item.mapping ?? {})) {
        if ((IMPORT_FIELDS as readonly string[]).includes(field) && Number.isInteger(index) && index >= 0 && index < sheet.headers.length) mapping[field as ImportField] = index;
      }
      return mapping.employeeNo !== undefined ? { sheet, mapping } : null;
    }).filter((item): item is { sheet: SheetSample; mapping: Partial<Record<ImportField, number>> } => Boolean(item));
    if (plan.length) return { engine: 'ai', plan, notes: (answer.notesAr ?? []).filter((note) => typeof note === 'string').slice(0, 20) };
  }
  return { engine: 'rules', plan: guessed.filter((item) => item.mapping.employeeNo !== undefined), notes: [] };
}

export function excelDate(value: Cell): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && value > 20000 && value < 80000) return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
  const raw = text(value);
  let match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  match = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  return null;
}

export function amount(value: Cell): number | null {
  if (typeof value === 'number') return value;
  const raw = text(value).replace(/[,،\s]/g, '').replace(/[^\d.]/g, '');
  return raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
}
