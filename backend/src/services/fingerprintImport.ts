import { randomUUID } from 'node:crypto';
import { Transaction } from 'sequelize';
import type { SystemSettings } from '../config/systemSettings';
import { execute, select } from '../db/query';
import { cleanPin } from './employeeImport';
import { calendarDayCount, leaveQuantity, workingDayCount } from './leaveDays';
import { DateOrder, detectColumns, nameKey, normalizeHeader, parseDate, parseTime, readSheet, sameName, SheetTable } from './sheetRead';

/**
 * The fingerprint system's three exports, each uploaded on its own:
 *  - attendance: punches (a date-time per row, or a day row with in/out times);
 *  - leaves: every leave type the system records, with from/to dates or hours;
 *  - tasks: punches and assignments from the fingerprint app for external work.
 * Rows are read by the employee's fingerprint number, checked against the
 * name in the file, and dated day by day. Nothing is written until HR sees
 * the preview and applies it.
 */

export type FileKind = 'attendance' | 'leaves' | 'tasks';
export const FILE_KINDS: FileKind[] = ['attendance', 'leaves', 'tasks'];

interface FieldDef { label: string; aliases: string[]; required?: boolean }

const PIN: FieldDef = {
  label: 'رقم البصمة', required: true,
  aliases: ['رقم البصمة', 'رقم الموظف بالبصمة', 'رقم البصمه', 'رقم الموظف', 'الرقم الوظيفي', 'رقم المستخدم', 'كود الموظف', 'الكود', 'الرقم',
    'pin', 'ac no', 'acno', 'enroll no', 'enrollno', 'enroll number', 'user id', 'userid', 'user no', 'emp no', 'employee no', 'employee id',
    'emp id', 'person id', 'personnel id', 'personnel no', 'staff id', 'badge', 'badge no', 'id', 'no', 'code', 'employee code'],
};
const NAME: FieldDef = {
  label: 'الاسم',
  aliases: ['الاسم', 'اسم الموظف', 'الاسم الكامل', 'name', 'employee name', 'full name', 'first name', 'emp name', 'user name', 'person name', 'staff name'],
};
const DATE: FieldDef = {
  label: 'التاريخ',
  aliases: ['التاريخ', 'اليوم', 'تاريخ اليوم', 'تاريخ الحركة', 'date', 'day', 'att date', 'attendance date', 'work date', 'punch date', 'record date'],
};
const DATETIME: FieldDef = {
  label: 'التاريخ والوقت',
  aliases: ['التاريخ والوقت', 'وقت البصمة', 'وقت الحركة', 'تاريخ ووقت', 'datetime', 'date time', 'check time', 'checktime', 'punch time',
    'time stamp', 'timestamp', 'record time', 'transaction time', 'att time', 'verify time'],
};
const TIME: FieldDef = { label: 'الوقت', aliases: ['الوقت', 'الساعة', 'time', 'punch', 'clock time'] };
const IN: FieldDef = {
  label: 'الدخول',
  aliases: ['الدخول', 'وقت الدخول', 'الحضور', 'وقت الحضور', 'دخول', 'حضور', 'بداية', 'in', 'check in', 'clock in', 'time in', 'in time',
    'on duty', 'first in', 'first punch', 'start time', 'from time', 'من الساعة'],
};
const OUT: FieldDef = {
  label: 'الخروج',
  aliases: ['الخروج', 'وقت الخروج', 'الانصراف', 'وقت الانصراف', 'خروج', 'انصراف', 'نهاية', 'out', 'check out', 'clock out', 'time out',
    'out time', 'off duty', 'last out', 'last punch', 'end time', 'to time', 'الى الساعة'],
};

export const FIELDS: Record<FileKind, Record<string, FieldDef>> = {
  attendance: { pin: PIN, name: NAME, dateTime: DATETIME, date: DATE, time: TIME, in: IN, out: OUT },
  leaves: {
    pin: PIN,
    name: NAME,
    type: { label: 'نوع الإجازة', aliases: ['نوع الإجازة', 'نوع الاجازة', 'الإجازة', 'الاجازة', 'نوع الغياب', 'نوع الطلب', 'النوع', 'نوع', 'leave type', 'leave', 'type', 'leave name', 'exception', 'category', 'leave category'] },
    from: { label: 'من تاريخ', aliases: ['من تاريخ', 'من', 'تاريخ البداية', 'البداية', 'بداية الإجازة', 'تاريخ بداية الإجازة', 'تاريخ الانفكاك', 'start date', 'from date', 'from', 'start', 'start time', 'begin', 'leave start', 'start datetime'] },
    to: { label: 'إلى تاريخ', aliases: ['الى تاريخ', 'إلى تاريخ', 'الى', 'إلى', 'لغاية', 'تاريخ النهاية', 'النهاية', 'نهاية الإجازة', 'تاريخ المباشرة', 'end date', 'to date', 'to', 'end', 'end time', 'finish', 'leave end', 'end datetime'] },
    date: DATE,
    fromTime: { label: 'من الساعة', aliases: ['من الساعة', 'من ساعة', 'وقت البداية', 'ساعة البداية', 'from hour', 'start hour', 'time from'] },
    toTime: { label: 'إلى الساعة', aliases: ['الى الساعة', 'إلى الساعة', 'الى ساعة', 'وقت النهاية', 'ساعة النهاية', 'to hour', 'end hour', 'time to'] },
    days: { label: 'المدة', aliases: ['المدة', 'عدد الأيام', 'عدد الايام', 'الأيام', 'الايام', 'عدد الساعات', 'الساعات', 'days', 'duration', 'day count', 'total days', 'hours', 'total'] },
    reason: { label: 'السبب', aliases: ['السبب', 'سبب الإجازة', 'الملاحظات', 'ملاحظات', 'ملاحظة', 'reason', 'remark', 'remarks', 'note', 'notes', 'description', 'apply reason'] },
    status: { label: 'الحالة', aliases: ['الحالة', 'حالة الطلب', 'حالة الموافقة', 'status', 'approval status', 'state', 'audit status', 'approve status'] },
  },
  tasks: {
    pin: PIN,
    name: NAME,
    dateTime: DATETIME,
    date: DATE,
    time: TIME,
    in: { ...IN, label: 'من الساعة (الخروج للمهمة)' },
    out: { ...OUT, label: 'إلى الساعة (العودة)' },
    title: { label: 'المهمة', aliases: ['المهمة', 'المهمه', 'نوع المهمة', 'اسم المهمة', 'العمل', 'التكليف', 'نوع التكليف', 'task', 'task name', 'task type', 'assignment', 'job', 'work type', 'type', 'النوع', 'event', 'punch type'] },
    location: { label: 'الموقع', aliases: ['الموقع', 'العنوان', 'المكان', 'الموقع الجغرافي', 'location', 'address', 'place', 'area', 'gps', 'coordinates', 'site', 'gps location'] },
    note: { label: 'ملاحظة', aliases: ['ملاحظة', 'ملاحظات', 'الوصف', 'note', 'notes', 'remark', 'remarks', 'description', 'comment'] },
  },
};

export interface ImportOptions {
  kind: FileKind;
  dateOrder: DateOrder;
  /** Overrides of the detected columns: field → column index (-1 = none). */
  mapping?: Record<string, number>;
  /** Index of the header row among the file's rows, when detection picked the wrong one. */
  headerIndex?: number;
  /** Leaves: the file's type names → a system leave type id, or 'skip'. */
  typeMap?: Record<string, string>;
  /** Leaves: type used where the file has no type column or an empty cell. */
  defaultTypeId?: string | null;
  /** Users confined to a branch touch only their branch. */
  branchId: string | null;
  /** The importer's own employee record (nobody imports their own leave). */
  ownEmployeeId: string | null;
}

export type RowStatus = 'ok' | 'duplicate' | 'skip' | 'unmatched' | 'error';
export interface PreviewRow {
  row: number;
  pin: string;
  name: string;
  employee: { id: string; employeeNo: string; fullName: string } | null;
  date: string | null;
  detail: string;
  status: RowStatus;
  note: string | null;
  warnings: string[];
}

interface Person { id: string; employeeNo: string; fullName: string; attendancePin: string | null; branchId: string; status: string }

class Matcher {
  private byPin = new Map<string, Person>();
  private byNo = new Map<string, Person>();
  private byName = new Map<string, Person[]>();
  /** PINs found by name in this file, to save on the employee. */
  readonly assign = new Map<string, string>();
  private assignedTo = new Map<string, string>();

  constructor(people: Person[], private branchId: string | null) {
    for (const person of people) {
      if (person.attendancePin) this.byPin.set(person.attendancePin, person);
      this.byNo.set(person.employeeNo, person);
      const key = nameKey(person.fullName);
      this.byName.set(key, [...(this.byName.get(key) ?? []), person]);
    }
  }

  find(rawPin: string, name: string): { person: Person | null; pin: string | null; warnings: string[]; error?: string } {
    const pin = rawPin ? cleanPin(rawPin) : null;
    const warnings: string[] = [];
    let person = pin ? this.byPin.get(pin) ?? this.byNo.get(pin) ?? null : null;
    if (!person && pin && this.assignedTo.has(pin)) person = this.byNo.get(this.assignedTo.get(pin)!) ?? null;
    if (person) {
      if (name && !sameName(name, person.fullName)) warnings.push(`الاسم في الملف «${name}» واسمه في النظام «${person.fullName}»`);
    } else if (name) {
      const candidates = (this.byName.get(nameKey(name)) ?? []).filter((item) => item.status !== 'inactive');
      if (candidates.length > 1) return { person: null, pin, warnings, error: `الاسم «${name}» لعدة موظفين؛ اربط رقم البصمة من ملف الموظف أو إكسل الموظفين` };
      if (candidates.length === 1) {
        const candidate = candidates[0];
        if (pin && candidate.attendancePin && candidate.attendancePin !== pin) {
          return { person: null, pin, warnings, error: `الاسم يطابق «${candidate.fullName}» لكن رقم بصمته ${candidate.attendancePin}` };
        }
        if (pin && !candidate.attendancePin) {
          const earlier = this.assign.get(candidate.id);
          if (earlier && earlier !== pin) return { person: null, pin, warnings, error: `للموظف «${candidate.fullName}» رقمان في الملف (${earlier} و${pin})` };
          this.assign.set(candidate.id, pin);
          this.assignedTo.set(pin, candidate.employeeNo);
          warnings.push(`طوبق بالاسم؛ سيُحفظ رقم البصمة ${pin} في ملفه`);
        } else warnings.push('طوبق بالاسم');
        person = candidate;
      }
    }
    if (person && this.branchId && person.branchId !== this.branchId) return { person: null, pin, warnings, error: 'الموظف خارج فرعك' };
    return { person, pin, warnings };
  }
}

async function people(transaction?: Transaction): Promise<Person[]> {
  return select<Person>(
    `SELECT id, employee_no AS "employeeNo", full_name AS "fullName", attendance_pin AS "attendancePin",
            branch_id AS "branchId", employment_status AS status
     FROM employees`, {}, transaction,
  );
}

/** Every time written in a cell: «08:01 16:05», «8:01 AM», or the time of a date-time. */
function timesIn(text: string): string[] {
  if (!text) return [];
  const direct = parseTime(text);
  const found = [...text.matchAll(/\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|ص|م)?/gi)].map((match) => parseTime(match[0])).filter((value): value is string => Boolean(value));
  if (found.length > 1) return found;
  return direct ? [direct] : found;
}

const hm = (time: string) => time.slice(0, 5);

function detail(parts: Array<string | null | false | undefined>): string {
  return parts.filter(Boolean).join(' · ');
}

interface Layout { headerIndex: number; header: string[]; columns: Record<string, number> }

function layout(table: SheetTable, options: ImportOptions): Layout {
  const fields = FIELDS[options.kind];
  const aliases = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.aliases])) as Record<string, string[]>;
  const detected = detectColumns(table, aliases);
  const headerIndex = options.headerIndex !== undefined && options.headerIndex >= 0 && options.headerIndex < table.rows.length
    ? options.headerIndex : detected?.headerIndex ?? 0;
  const header = table.rows[headerIndex]?.cells ?? [];
  const columns: Record<string, number> = {};
  for (const key of Object.keys(fields)) {
    const override = options.mapping?.[key];
    if (override !== undefined && Number.isInteger(override) && override >= -1 && override < Math.max(header.length, 60)) columns[key] = override;
    else if (detected && detected.headerIndex === headerIndex) columns[key] = detected.columns[key] ?? -1;
    else {
      const names = fields[key].aliases.map(normalizeHeader);
      columns[key] = header.findIndex((cell) => names.includes(normalizeHeader(cell)));
    }
  }
  return { headerIndex, header, columns };
}

export interface FilePlan {
  kind: FileKind;
  format: string;
  headerIndex: number;
  header: string[];
  sample: string[][];
  /** The file's first rows as they are, to pick the header row by hand. */
  top: string[][];
  mapping: Record<string, number>;
  fields: Array<{ key: string; label: string; required: boolean }>;
  rows: PreviewRow[];
  summary: Record<string, number | string | null>;
  /** Leaves: what each type name in the file maps to. */
  leaveTypes?: Array<{ name: string; count: number; typeId: string | null }>;
  /** What apply writes. */
  writes: {
    assign: Map<string, string>;
    punches: Array<{ pin: string; at: string; employeeId: string | null; note?: string | null }>;
    leaves: Array<{ employeeId: string; typeId: string; startsOn: string; endsOn: string; startTime: string | null; endTime: string | null; quantity: number; reason: string; deducts: boolean }>;
    tasks: Array<{ employeeId: string; pin: string | null; date: string; startTime: string | null; endTime: string | null; title: string; location: string | null; note: string | null }>;
  };
}

const APPROVED = ['approved', 'approve', 'approval', 'agree', 'agreed', 'pass', 'passed', 'done', 'yes', 'ok', 'accepted', 'accept', 'confirmed',
  'موافق', 'موافقه', 'موافق عليه', 'موافق عليها', 'معتمد', 'معتمده', 'مقبول', 'مقبوله', 'تمت الموافقه', 'نعم', 'مصادق', 'مصادقه', 'منجز'].map(nameKey);

/** Common names of leave types in fingerprint programs, by what they mean. */
const TYPE_HINTS: Array<{ words: string[]; match: RegExp }> = [
  { words: ['annual', 'vacation', 'اعتيادي', 'اعتياديه', 'سنوي', 'سنويه', 'اجازه اعتياديه'], match: /اعتياد|سنوي|annual/ },
  { words: ['sick', 'medical', 'مرضي', 'مرضيه'], match: /مرض|sick|medical/ },
  { words: ['unpaid', 'بدون راتب', 'بلا راتب'], match: /بدون|بلا راتب|unpaid/ },
  { words: ['hourly', 'زمني', 'زمنيه', 'ساعي', 'ساعات'], match: /زمني|ساع|hour/ },
  { words: ['maternity', 'امومه', 'وضع'], match: /امومه|وضع|maternity/ },
  { words: ['compensatory', 'تعويضي', 'تعويضيه', 'بديل'], match: /تعويض|بديل|compens/ },
];

export function guessType(name: string, types: SystemSettings['leaveTypes']): string | null {
  const key = nameKey(name);
  if (!key) return null;
  const active = types.filter((type) => type.active);
  const exact = active.find((type) => nameKey(type.name) === key);
  if (exact) return exact.id;
  const contains = active.filter((type) => key.includes(nameKey(type.name).replace(/^اجازه /, '')) || nameKey(type.name).includes(key));
  if (contains.length === 1) return contains[0].id;
  for (const hint of TYPE_HINTS) {
    if (hint.words.some((word) => key.includes(nameKey(word)))) {
      const found = active.filter((type) => hint.match.test(nameKey(type.name)));
      if (found.length === 1) return found[0].id;
    }
  }
  return null;
}

/** Reads the file with the given (or detected) columns and works out every row, writing nothing. */
export async function planFile(buffer: Buffer, options: ImportOptions, settings: SystemSettings, transaction?: Transaction): Promise<FilePlan> {
  const table = await readSheet(buffer);
  const fields = FIELDS[options.kind];
  const { headerIndex, header, columns } = layout(table, options);
  const matcher = new Matcher(await people(transaction), options.branchId);
  const dataRows = table.rows.slice(headerIndex + 1);
  const cell = (cells: string[], key: string) => (columns[key] >= 0 ? (cells[columns[key]] ?? '').trim() : '');
  const plan: FilePlan = {
    kind: options.kind,
    format: table.format,
    headerIndex,
    header,
    sample: dataRows.slice(0, 6).map((row) => row.cells),
    top: table.rows.slice(0, 12).map((row) => row.cells.slice(0, 30)),
    mapping: columns,
    fields: Object.entries(fields).map(([key, field]) => ({ key, label: field.label, required: Boolean(field.required) })),
    rows: [],
    summary: {},
    writes: { assign: matcher.assign, punches: [], leaves: [], tasks: [] },
  };
  if (columns.pin < 0 && columns.name < 0) {
    plan.summary = { problem: 'حدد عمود رقم البصمة (أو الاسم) ليُعرف كل موظف.' };
    return plan;
  }
  const dateOf = (cells: string[]) => {
    for (const key of ['date', 'dateTime', 'time', 'in', 'from']) {
      const value = cell(cells, key);
      const parsed = value ? parseDate(value, options.dateOrder) : null;
      if (parsed) return parsed;
    }
    return null;
  };

  if (options.kind === 'attendance' || options.kind === 'tasks') {
    const isTasks = options.kind === 'tasks';
    const existingTasks = new Set<string>();
    for (const tableRow of dataRows) {
      const cells = tableRow.cells;
      const pinCell = cell(cells, 'pin');
      const name = cell(cells, 'name');
      if (!pinCell && !name) continue;
      if (pinCell && !cleanPin(pinCell) && !name) continue; // totals, sub-headings
      const row: PreviewRow = { row: tableRow.number, pin: pinCell, name, employee: null, date: null, detail: '', status: 'ok', note: null, warnings: [] };
      plan.rows.push(row);
      const found = matcher.find(pinCell, name);
      row.warnings.push(...found.warnings);
      if (found.person) row.employee = { id: found.person.id, employeeNo: found.person.employeeNo, fullName: found.person.fullName };
      if (found.error) { row.status = 'error'; row.note = found.error; continue; }
      const date = dateOf(cells);
      row.date = date;
      if (!date) { row.status = 'error'; row.note = 'التاريخ غير مفهوم'; continue; }
      const single = timesIn(cell(cells, 'dateTime') || cell(cells, 'time'));
      const ins = timesIn(cell(cells, 'in'));
      const outs = timesIn(cell(cells, 'out'));
      const times = [...single, ...ins, ...outs].filter((value, index, all) => all.indexOf(value) === index).sort();
      const devicePin = found.pin ?? found.person?.attendancePin ?? found.person?.employeeNo ?? null;
      if (!isTasks) {
        if (!times.length) { row.status = 'skip'; row.note = 'لا بصمات في هذا اليوم'; continue; }
        if (!devicePin) { row.status = 'error'; row.note = 'رقم البصمة غير صالح'; continue; }
        row.detail = times.map(hm).join(' ، ');
        if (!found.person) { row.status = 'unmatched'; row.note = 'رقم غير مربوط: تُحفظ البصمات وتُربط لاحقاً'; }
        for (const time of times) plan.writes.punches.push({ pin: devicePin, at: `${date}T${time}`, employeeId: found.person?.id ?? null });
        continue;
      }
      // Tasks
      if (!found.person) { row.status = 'error'; row.note = pinCell ? `رقم البصمة ${pinCell} غير مربوط بموظف` : 'لا يطابق أي موظف'; continue; }
      const title = (cell(cells, 'title') || 'مهمة خارجية').slice(0, 200);
      const location = cell(cells, 'location').slice(0, 300) || null;
      const note = cell(cells, 'note').slice(0, 500) || null;
      const window = ins.length && outs.length ? { start: ins[0], end: outs[outs.length - 1] }
        : times.length > 1 ? { start: times[0], end: times[times.length - 1] } : null;
      const startTime = window ? window.start : times[0] ?? null;
      const endTime = window ? window.end : null;
      row.detail = detail([title, startTime ? (endTime ? `${hm(startTime)} – ${hm(endTime)}` : hm(startTime)) : 'اليوم كله', location]);
      const key = `${found.person.id}|${date}|${startTime ?? ''}|${endTime ?? ''}`;
      if (existingTasks.has(key)) { row.status = 'duplicate'; row.note = 'مكررة في الملف'; continue; }
      existingTasks.add(key);
      plan.writes.tasks.push({ employeeId: found.person.id, pin: devicePin, date, startTime, endTime, title, location, note });
      for (const time of times) {
        plan.writes.punches.push({
          pin: devicePin ?? found.person.employeeNo, at: `${date}T${time}`, employeeId: found.person.id,
          note: `مهمة: ${title}${location ? ` — ${location}` : ''}`.slice(0, 500),
        });
      }
    }

    // Already in the system?
    const pins = [...new Set(plan.writes.punches.map((item) => item.pin))];
    const dates = plan.writes.punches.map((item) => item.at.slice(0, 10)).sort();
    const existing = pins.length ? await select<{ pin: string; at: string }>(
      `SELECT device_pin AS pin, to_char(punched_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS at FROM attendance_punches
       WHERE device_pin IN (:pins) AND punched_at >= :from::date AND punched_at < (:to::date + 1)`,
      { pins, from: dates[0], to: dates[dates.length - 1] }, transaction,
    ) : [];
    const known = new Set(existing.map((item) => `${item.pin}|${item.at}`));
    let taskKnown = new Set<string>();
    if (isTasks && plan.writes.tasks.length) {
      const taskRows = await select<{ key: string }>(
        `SELECT employee_id || '|' || to_char(work_date, 'YYYY-MM-DD') || '|' || COALESCE(to_char(start_time, 'HH24:MI:SS'), '') || '|' || COALESCE(to_char(end_time, 'HH24:MI:SS'), '') AS key
         FROM attendance_tasks WHERE employee_id IN (:ids) AND voided_at IS NULL AND work_date BETWEEN :from AND :to`,
        { ids: [...new Set(plan.writes.tasks.map((item) => item.employeeId))], from: plan.writes.tasks.map((item) => item.date).sort()[0], to: plan.writes.tasks.map((item) => item.date).sort().reverse()[0] },
        transaction,
      );
      taskKnown = new Set(taskRows.map((item) => item.key));
      // Tasks already recorded are not written again.
      plan.writes.tasks = plan.writes.tasks.filter((item) => !taskKnown.has(`${item.employeeId}|${item.date}|${item.startTime ?? ''}|${item.endTime ?? ''}`));
    }
    let duplicatePunches = 0;
    for (const row of plan.rows) {
      if (row.status !== 'ok' && row.status !== 'unmatched') continue;
      const own = plan.writes.punches.filter((item) => item.at.startsWith(row.date ?? '~') && (row.employee ? item.employeeId === row.employee.id : item.pin === cleanPin(row.pin)));
      if (isTasks) {
        const written = plan.writes.tasks.some((item) => row.employee && item.employeeId === row.employee.id && item.date === row.date);
        if (!written) { row.status = 'duplicate'; row.note = 'موجودة مسبقاً'; }
      } else if (own.length && own.every((item) => known.has(`${item.pin}|${item.at}`))) { row.status = 'duplicate'; row.note = 'موجودة مسبقاً'; }
    }
    duplicatePunches = plan.writes.punches.filter((item) => known.has(`${item.pin}|${item.at}`)).length;
    // The days touched: punches and (for tasks) whole days without a punch.
    const touched = [...dates, ...plan.writes.tasks.map((item) => item.date)].sort();
    const okRows = plan.rows.filter((row) => row.status === 'ok' || row.status === 'unmatched');
    plan.summary = {
      rows: plan.rows.length,
      ok: plan.rows.filter((row) => row.status === 'ok').length,
      unmatched: plan.rows.filter((row) => row.status === 'unmatched').length,
      duplicate: plan.rows.filter((row) => row.status === 'duplicate').length,
      skip: plan.rows.filter((row) => row.status === 'skip').length,
      error: plan.rows.filter((row) => row.status === 'error').length,
      punches: plan.writes.punches.length - duplicatePunches,
      tasks: isTasks ? plan.writes.tasks.length : null,
      employees: new Set(okRows.map((row) => row.employee?.id).filter(Boolean)).size,
      pinsToSave: matcher.assign.size,
      from: touched[0] ?? null,
      to: touched[touched.length - 1] ?? null,
    };
    return plan;
  }

  // Leaves
  const typeNames = new Map<string, number>();
  for (const tableRow of dataRows) {
    const name = cell(tableRow.cells, 'type');
    if (name && (cell(tableRow.cells, 'pin') || cell(tableRow.cells, 'name'))) typeNames.set(name, (typeNames.get(name) ?? 0) + 1);
  }
  const typeFor = (name: string): string | null => {
    if (!name) return options.defaultTypeId ?? null;
    const chosen = options.typeMap?.[name];
    if (chosen) return chosen;
    return guessType(name, settings.leaveTypes) ?? options.defaultTypeId ?? null;
  };
  plan.leaveTypes = [...typeNames.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count, typeId: typeFor(name) }));

  const candidates: Array<{ row: PreviewRow; employeeId: string; typeId: string; startsOn: string; endsOn: string; startTime: string | null; endTime: string | null; quantity: number; reason: string; deducts: boolean }> = [];
  for (const tableRow of dataRows) {
    const cells = tableRow.cells;
    const pinCell = cell(cells, 'pin');
    const name = cell(cells, 'name');
    if (!pinCell && !name) continue;
    if (pinCell && !cleanPin(pinCell) && !name) continue;
    const row: PreviewRow = { row: tableRow.number, pin: pinCell, name, employee: null, date: null, detail: '', status: 'ok', note: null, warnings: [] };
    plan.rows.push(row);
    const found = matcher.find(pinCell, name);
    row.warnings.push(...found.warnings);
    if (found.error) { row.status = 'error'; row.note = found.error; continue; }
    if (!found.person) { row.status = 'error'; row.note = pinCell ? `رقم البصمة ${pinCell} غير مربوط بموظف` : 'لا يطابق أي موظف'; continue; }
    const person = found.person;
    row.employee = { id: person.id, employeeNo: person.employeeNo, fullName: person.fullName };
    if (options.ownEmployeeId && person.id === options.ownEmployeeId) { row.status = 'error'; row.note = 'إجازتك يستوردها موظف آخر'; continue; }

    const status = cell(cells, 'status');
    if (status && !APPROVED.includes(nameKey(status))) { row.status = 'skip'; row.note = `الحالة «${status}» ليست موافقة`; continue; }
    const typeName = cell(cells, 'type');
    const typeChoice = typeFor(typeName);
    if (typeChoice === 'skip') { row.status = 'skip'; row.note = `نوع «${typeName}» متجاهل`; continue; }
    const type = settings.leaveTypes.find((item) => item.id === typeChoice && item.active);
    if (!type) { row.status = 'error'; row.note = typeName ? `اربط نوع «${typeName}» بنوع إجازة في النظام` : 'حدد نوع الإجازة'; continue; }

    const fromCell = cell(cells, 'from') || cell(cells, 'date');
    const toCell = cell(cells, 'to') || fromCell;
    const startsOn = parseDate(fromCell, options.dateOrder);
    const endsOn = parseDate(toCell, options.dateOrder);
    row.date = startsOn;
    if (!startsOn || !endsOn) { row.status = 'error'; row.note = 'تاريخ الإجازة غير مفهوم'; continue; }
    if (endsOn < startsOn) { row.status = 'error'; row.note = 'تاريخ النهاية قبل البداية'; continue; }
    if (calendarDayCount(startsOn, endsOn) > 366) { row.status = 'error'; row.note = 'الفترة أطول من سنة'; continue; }
    let startTime: string | null = null;
    let endTime: string | null = null;
    if (type.unit === 'hours') {
      startTime = parseTime(cell(cells, 'fromTime')) ?? (/\d:\d/.test(fromCell) ? parseTime(fromCell) : null);
      endTime = parseTime(cell(cells, 'toTime')) ?? (/\d:\d/.test(toCell) ? parseTime(toCell) : null);
      if (!startTime || !endTime || endTime <= startTime) { row.status = 'error'; row.note = 'الإجازة الزمنية تحتاج وقت بداية ونهاية في نفس اليوم'; continue; }
      if (startsOn !== endsOn) { row.status = 'error'; row.note = 'الإجازة الزمنية في يوم واحد'; continue; }
      if (workingDayCount(startsOn, endsOn, settings) !== 1) { row.status = 'error'; row.note = 'إجازة زمنية في يوم غير عامل'; continue; }
      startTime = startTime.slice(0, 5);
      endTime = endTime.slice(0, 5);
    }
    const quantity = leaveQuantity(type, startsOn, endsOn, settings, startTime && endTime ? { start: startTime, end: endTime } : null);
    if (quantity <= 0) { row.status = 'skip'; row.note = 'الفترة لا تتضمن أيام عمل'; continue; }
    const unit = type.unit === 'hours' ? 'ساعة' : 'يوم';
    row.detail = detail([type.name, startsOn === endsOn ? startsOn : `${startsOn} → ${endsOn}`, startTime && `${startTime} – ${endTime}`, `${Number(quantity.toFixed(2))} ${unit}`]);
    const fileDays = Number(cell(cells, 'days').replace(/[^\d.]/g, ''));
    if (fileDays && Math.abs(fileDays - quantity) > 0.01) row.warnings.push(`المدة في الملف ${fileDays} والنظام يحسبها ${Number(quantity.toFixed(2))} ${unit}`);
    if (person.status !== 'active') row.warnings.push('الموظف ليس على رأس العمل');
    candidates.push({
      row, employeeId: person.id, typeId: type.id, startsOn, endsOn, startTime, endTime, quantity,
      reason: (cell(cells, 'reason') || `من ملف إجازات البصمة: ${typeName || type.name}`).slice(0, 1000),
      deducts: type.deductsBalance !== false,
    });
  }

  // Already recorded, overlapping in the file, balance and payroll locks.
  const ids = [...new Set(candidates.map((item) => item.employeeId))];
  const range = candidates.map((item) => item.startsOn).sort()[0];
  const rangeEnd = candidates.map((item) => item.endsOn).sort().reverse()[0];
  const recorded = ids.length ? await select<{ employeeId: string; typeId: string; startsOn: string; endsOn: string; startTime: string | null; endTime: string | null }>(
    `SELECT employee_id AS "employeeId", leave_type_id AS "typeId", to_char(starts_on, 'YYYY-MM-DD') AS "startsOn",
            to_char(ends_on, 'YYYY-MM-DD') AS "endsOn", to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime"
     FROM leave_requests WHERE employee_id IN (:ids) AND status IN ('pending','approved') AND starts_on <= :to AND ends_on >= :from`,
    { ids, from: range, to: rangeEnd }, transaction,
  ) : [];
  const balances = ids.length ? await select<{ employeeId: string; typeId: string; available: number }>(
    `SELECT x.employee_id AS "employeeId", x.leave_type_id AS "typeId", sum(x.quantity)::float AS available FROM (
       SELECT employee_id, leave_type_id, quantity FROM leave_ledger_entries WHERE employee_id IN (:ids)
       UNION ALL
       SELECT employee_id, leave_type_id, -quantity FROM leave_requests WHERE employee_id IN (:ids) AND status = 'pending'
     ) x GROUP BY x.employee_id, x.leave_type_id`,
    { ids }, transaction,
  ) : [];
  const locked = ids.length ? await select<{ employeeId: string; date: string }>(
    `SELECT employee_id AS "employeeId", to_char(work_date, 'YYYY-MM-DD') AS date FROM attendance_days
     WHERE employee_id IN (:ids) AND payroll_run_id IS NOT NULL AND work_date BETWEEN :from AND :to`,
    { ids, from: range, to: rangeEnd }, transaction,
  ) : [];
  const available = new Map(balances.map((item) => [`${item.employeeId}|${item.typeId}`, item.available]));
  const unitOf = (typeId: string) => settings.leaveTypes.find((item) => item.id === typeId)?.unit ?? 'days';
  const clash = (a: { typeId: string; startsOn: string; endsOn: string; startTime: string | null; endTime: string | null }, b: typeof a) => {
    if (a.startsOn > b.endsOn || a.endsOn < b.startsOn) return false;
    if (unitOf(a.typeId) !== 'hours' || unitOf(b.typeId) !== 'hours') return true;
    return (a.startTime ?? '') < (b.endTime ?? '') && (a.endTime ?? '') > (b.startTime ?? '');
  };
  const accepted: typeof candidates = [];
  for (const item of candidates) {
    if (recorded.some((other) => other.employeeId === item.employeeId && clash(item, other))) {
      item.row.status = 'duplicate'; item.row.note = 'مسجلة مسبقاً في النظام'; continue;
    }
    if (accepted.some((other) => other.employeeId === item.employeeId && clash(item, other))) {
      item.row.status = 'duplicate'; item.row.note = 'تتداخل مع سطر سابق في الملف'; continue;
    }
    if (item.deducts) {
      const key = `${item.employeeId}|${item.typeId}`;
      const before = available.get(key) ?? 0;
      if (before - item.quantity < -0.0001) item.row.warnings.push(`الرصيد سيصبح سالباً (المتاح ${Number(before.toFixed(2))})`);
      available.set(key, before - item.quantity);
    }
    if (locked.some((day) => day.employeeId === item.employeeId && day.date >= item.startsOn && day.date <= item.endsOn)) {
      item.row.warnings.push('ضمن مسير معتمد: يُخصم من الرصيد ولا تتغير أيام الحضور المقفلة');
    }
    accepted.push(item);
  }
  plan.writes.leaves = accepted.map(({ row: _row, ...rest }) => rest);
  plan.summary = {
    rows: plan.rows.length,
    ok: plan.rows.filter((row) => row.status === 'ok').length,
    duplicate: plan.rows.filter((row) => row.status === 'duplicate').length,
    skip: plan.rows.filter((row) => row.status === 'skip').length,
    error: plan.rows.filter((row) => row.status === 'error').length,
    employees: new Set(accepted.map((item) => item.employeeId)).size,
    days: Number(accepted.filter((item) => unitOf(item.typeId) !== 'hours').reduce((sum, item) => sum + item.quantity, 0).toFixed(2)),
    hours: Number(accepted.filter((item) => unitOf(item.typeId) === 'hours').reduce((sum, item) => sum + item.quantity, 0).toFixed(2)),
    pinsToSave: matcher.assign.size,
    from: range ?? null,
    to: rangeEnd ?? null,
  };
  return plan;
}

/** Saves fingerprint numbers found by name and links punches already stored under them. */
export async function savePins(assign: Map<string, string>, transaction: Transaction): Promise<Array<{ employeeId: string; pin: string }>> {
  const saved: Array<{ employeeId: string; pin: string }> = [];
  for (const [employeeId, pin] of assign) {
    const taken = await select('SELECT 1 FROM employees WHERE attendance_pin = :pin AND id <> :employeeId', { pin, employeeId }, transaction);
    if (taken.length) continue;
    const [updated] = await execute<{ id: string }>(
      'UPDATE employees SET attendance_pin = :pin, updated_at = now() WHERE id = :employeeId AND attendance_pin IS NULL RETURNING id',
      { pin, employeeId }, transaction,
    );
    if (!updated) continue;
    await execute('UPDATE attendance_punches SET employee_id = :employeeId WHERE device_pin = :pin AND employee_id IS NULL', { pin, employeeId }, transaction);
    saved.push({ employeeId, pin });
  }
  return saved;
}

/** Writes the leave rows of a plan as approved leave taken from the balance. */
export async function writeLeaves(
  plan: FilePlan, importId: string, user: { id: string; role: string }, transaction: Transaction,
): Promise<string[]> {
  const ids: string[] = [];
  for (const leave of plan.writes.leaves) {
    const id = randomUUID();
    await execute(
      `INSERT INTO leave_requests (id, employee_id, leave_type_id, starts_on, ends_on, start_time, end_time, quantity, reason,
         status, approval_roles, approval_step_index, submitted_by, decided_at, created_at, updated_at, source, import_id)
       VALUES (:id, :employeeId, :typeId, :startsOn, :endsOn, :startTime, :endTime, :quantity, :reason,
         'approved', '[]'::jsonb, 0, :userId, now(), now(), now(), 'import', :importId)`,
      { id, ...leave, quantity: leave.quantity.toFixed(2), userId: user.id, importId },
      transaction,
    );
    await execute(
      `INSERT INTO leave_approvals (id, request_id, step_index, role, user_id, action, note, created_at)
       VALUES (:approvalId, :id, -1, :role, :userId, 'approved', 'استيراد من ملف إجازات البصمة', now())`,
      { approvalId: randomUUID(), id, role: user.role, userId: user.id },
      transaction,
    );
    if (leave.deducts) {
      await execute(
        `INSERT INTO leave_ledger_entries (id, employee_id, leave_type_id, quantity, entry_type, request_id, reason, created_by, created_at)
         VALUES (:ledgerId, :employeeId, :typeId, :quantity, 'taken', :id, :reason, :userId, now())`,
        {
          ledgerId: randomUUID(), employeeId: leave.employeeId, typeId: leave.typeId, quantity: (-leave.quantity).toFixed(2), id,
          reason: `إجازة من ملف البصمة: ${leave.startsOn} إلى ${leave.endsOn}`, userId: user.id,
        },
        transaction,
      );
    }
    ids.push(id);
  }
  return ids;
}

/** Writes the tasks and the app punches of a plan. Returns how many of each were new. */
export async function writeTasks(plan: FilePlan, importId: string, userId: string, transaction: Transaction): Promise<{ tasks: number; punches: number }> {
  let tasks = 0;
  for (const task of plan.writes.tasks) {
    const inserted = await execute<{ id: string }>(
      `INSERT INTO attendance_tasks (id, employee_id, device_pin, work_date, start_time, end_time, title, location, note, source, import_id, created_by)
       VALUES (:id, :employeeId, :pin, :date, :startTime, :endTime, :title, :location, :note, 'import', :importId, :userId)
       ON CONFLICT (employee_id, work_date, COALESCE(start_time, '00:00'::time), COALESCE(end_time, '00:00'::time)) WHERE voided_at IS NULL
       DO NOTHING RETURNING id`,
      { id: randomUUID(), ...task, importId, userId },
      transaction,
    );
    tasks += inserted.length;
  }
  let punches = 0;
  for (let index = 0; index < plan.writes.punches.length; index += 1000) {
    const batch = plan.writes.punches.slice(index, index + 1000).map((item) => ({ id: randomUUID(), ...item }));
    const inserted = await execute<{ id: string }>(
      `INSERT INTO attendance_punches (id, employee_id, device_pin, punched_at, source, import_id, note, created_by)
       SELECT x.id, x."employeeId", x.pin, x.at, 'app', :importId, x.note, :userId
       FROM jsonb_to_recordset(:rows::jsonb) AS x(id uuid, "employeeId" uuid, pin varchar, at timestamp, note varchar)
       ON CONFLICT (device_pin, punched_at) DO NOTHING RETURNING id`,
      { rows: JSON.stringify(batch), importId, userId },
      transaction,
    );
    punches += inserted.length;
  }
  return { tasks, punches };
}
