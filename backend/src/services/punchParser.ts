import ExcelJS from 'exceljs';
import { loadWorkbook } from './xlsx';
import { RawPunch } from './attendance';

export type DateOrder = 'dmy' | 'mdy';

const PIN_HEADERS = [
  'pin', 'ac-no', 'ac-no.', 'ac no', 'acno', 'enroll no', 'enrollno', 'enroll number', 'user id', 'userid', 'user no',
  'emp no', 'emp no.', 'employee no', 'employee id', 'badge', 'id', 'no.', 'رقم البصمة', 'رقم الموظف', 'الرقم', 'رقم',
];
const DATETIME_HEADERS = [
  'datetime', 'date time', 'date/time', 'checktime', 'check time', 'time stamp', 'timestamp', 'punch time',
  'التاريخ والوقت', 'وقت البصمة',
];
const DATE_HEADERS = ['date', 'التاريخ'];
const TIME_HEADERS = ['time', 'الوقت'];

function normalize(header: string): string {
  return header.replace(/﻿/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parses the date/time forms seen in fingerprint exports:
 * 2026-10-01 08:01:22, 2026/10/01 8:01, 01/10/2026 08:01 (dmy or mdy),
 * optional seconds and AM/PM (including Arabic ص/م).
 */
export function parseDateTime(text: string, order: DateOrder): string | null {
  const value = text.trim().replace(/\s+/g, ' ');
  const match = value.match(
    /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(am|pm|ص|م)?$/i,
  );
  if (!match) return null;
  const [, a, b, c, h, mi, s, meridiem] = match;
  let year: number;
  let month: number;
  let day: number;
  if (a.length === 4) {
    [year, month, day] = [Number(a), Number(b), Number(c)];
  } else if (c.length === 4) {
    year = Number(c);
    [day, month] = order === 'dmy' ? [Number(a), Number(b)] : [Number(b), Number(a)];
  } else {
    return null;
  }
  let hours = Number(h);
  const minutes = Number(mi);
  const seconds = Number(s ?? 0);
  if (meridiem) {
    const pm = /^(pm|م)$/i.test(meridiem);
    if (hours < 1 || hours > 12) return null;
    if (pm && hours < 12) hours += 12;
    if (!pm && hours === 12) hours = 0;
  }
  if (!validDate(year, month, day) || hours > 23 || minutes > 59 || seconds > 59) return null;
  return `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function cleanPin(value: unknown): string | null {
  const pin = String(value ?? '').trim().replace(/^0+(?=\d)/, '');
  return /^[A-Za-z0-9_-]{1,40}$/.test(pin) ? pin : null;
}

/** Minimal CSV/TSV reader that honours quoted fields. */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function detectDelimiter(line: string): string {
  const counts = ['\t', ',', ';'].map((delimiter) => [delimiter, line.split(delimiter).length] as const);
  return counts.sort((left, right) => right[1] - left[1])[0][0];
}

export interface ParsedPunches {
  punches: RawPunch[];
  invalid: number;
  format: string;
}

function fromRows(rows: string[][], order: DateOrder, format: string): ParsedPunches {
  const punches: RawPunch[] = [];
  let invalid = 0;
  if (!rows.length) return { punches, invalid, format };

  const header = rows[0].map(normalize);
  const pinColumn = header.findIndex((cell) => PIN_HEADERS.includes(cell));
  const dateTimeColumn = header.findIndex((cell) => DATETIME_HEADERS.includes(cell));
  const dateColumn = header.findIndex((cell) => DATE_HEADERS.includes(cell));
  const timeColumn = header.findIndex((cell) => TIME_HEADERS.includes(cell));
  const hasHeader = pinColumn >= 0 && (dateTimeColumn >= 0 || dateColumn >= 0 || timeColumn >= 0);

  // A "Time" column in ZKTeco exports usually holds the full date and time.
  const resolvedDateTime = dateTimeColumn >= 0 ? dateTimeColumn : (dateColumn < 0 ? timeColumn : -1);

  for (const row of hasHeader ? rows.slice(1) : rows) {
    if (row.every((cell) => !cell)) continue;
    let pin: string | null;
    let at: string | null;
    if (hasHeader) {
      pin = cleanPin(row[pinColumn]);
      const text = resolvedDateTime >= 0
        ? row[resolvedDateTime] ?? ''
        : `${row[dateColumn] ?? ''} ${row[timeColumn] ?? ''}`;
      at = parseDateTime(text, order);
    } else {
      // Headerless ZKTeco attlog: PIN, date-time, state, verify, ...
      pin = cleanPin(row[0]);
      at = parseDateTime(row[1] ?? '', order);
    }
    if (pin && at) punches.push({ pin, at });
    else invalid += 1;
  }
  return { punches, invalid, format };
}

export function parseTextPunches(text: string, order: DateOrder): ParsedPunches {
  const lines = text.replace(/\r/g, '').split('\n').filter((line) => line.trim());
  if (!lines.length) return { punches: [], invalid: 0, format: 'empty' };
  const delimiter = detectDelimiter(lines[0]);
  return fromRows(lines.map((line) => splitLine(line, delimiter)), order, delimiter === '\t' ? 'zk-attlog' : 'csv');
}

function cellText(value: ExcelJS.CellValue): string {
  if (value instanceof Date) {
    // Excel stores wall-clock times; exceljs exposes them as UTC dates.
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  if (value && typeof value === 'object') {
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('text' in value) return String(value.text);
    if ('richText' in value) return value.richText.map((part) => part.text).join('');
  }
  return value === null || value === undefined ? '' : String(value);
}

export async function parseExcelPunches(buffer: Buffer, order: DateOrder): Promise<ParsedPunches> {
  const workbook = await loadWorkbook(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { punches: [], invalid: 0, format: 'xlsx' };
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as ExcelJS.CellValue[];
    rows.push(values.slice(1).map(cellText).map((cell) => cell.trim()));
  });
  return fromRows(rows, order, 'xlsx');
}

export function isXlsx(buffer: Buffer): boolean {
  return buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
}
