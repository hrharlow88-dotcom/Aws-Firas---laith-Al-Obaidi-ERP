import ExcelJS from 'exceljs';
import { loadWorkbook } from './xlsx';

/**
 * Reads the first sheet of an uploaded table (Excel .xlsx, CSV/TSV text, or
 * an HTML table saved as .xls by some fingerprint programs) into plain text
 * cells, so every importer works on the same shape. Dates become
 * YYYY-MM-DD, times HH:MM:SS and date-times "YYYY-MM-DD HH:MM:SS".
 */

export interface SheetTable {
  /** Every non-empty row, cells as trimmed text, with its row number in the file. */
  rows: Array<{ number: number; cells: string[] }>;
  format: 'xlsx' | 'csv' | 'html';
}

export class SheetFormatError extends Error {}

const pad = (value: number) => String(value).padStart(2, '0');

/** Excel keeps wall-clock values; ExcelJS hands them over as UTC dates. */
function dateText(value: Date): string {
  if (Number.isNaN(value.getTime())) return '';
  const y = value.getUTCFullYear();
  const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
  // A time-only cell sits on Excel's day zero (30 Dec 1899).
  if (y < 1900) return time;
  const date = `${y}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  return time === '00:00:00' ? date : `${date} ${time}`;
}

export function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return dateText(value);
  if (typeof value === 'object') {
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('richText' in value) return value.richText.map((part) => part.text).join('');
    if ('text' in value) return String(value.text);
    if ('error' in value) return '';
    return '';
  }
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  return String(value).replace(/ /g, ' ').trim();
}

function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; } else quoted = !quoted;
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

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(parseInt(code, 16)));
}

function readHtml(text: string): SheetTable {
  const rows: SheetTable['rows'] = [];
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  let number = 0;
  while ((match = rowPattern.exec(text))) {
    number += 1;
    const cells = [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cell) => decodeEntities(cell[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim());
    if (cells.some(Boolean)) rows.push({ number, cells });
  }
  return { rows, format: 'html' };
}

export async function readSheet(buffer: Buffer): Promise<SheetTable> {
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    let workbook: ExcelJS.Workbook;
    try {
      workbook = await loadWorkbook(buffer);
    } catch {
      throw new SheetFormatError('تعذرت قراءة ملف Excel. احفظه من جديد بصيغة .xlsx أو CSV ثم ارفعه.');
    }
    const sheet = workbook.worksheets.find((item) => item.rowCount > 0) ?? workbook.worksheets[0];
    const rows: SheetTable['rows'] = [];
    sheet?.eachRow({ includeEmpty: false }, (row, number) => {
      const values = row.values as ExcelJS.CellValue[];
      const cells = values.slice(1).map(cellText).map((cell) => cell.trim());
      // Merged cells repeat nothing in ExcelJS; empty slots stay empty strings.
      for (let index = 0; index < cells.length; index += 1) if (cells[index] === undefined) cells[index] = '';
      if (cells.some(Boolean)) rows.push({ number, cells });
    });
    return { rows, format: 'xlsx' };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw new SheetFormatError('الملف بصيغة Excel القديمة (.xls). افتحه في Excel واحفظه باسم .xlsx أو CSV ثم ارفعه.');
  }
  let text = buffer.toString('utf8');
  if (text.includes('\u0000')) text = buffer.toString('utf16le');
  text = text.replace(/^﻿/, '');
  if (/<table[\s>]/i.test(text)) return readHtml(text);
  const lines = text.replace(/\r/g, '').split('\n').filter((line) => line.trim());
  if (!lines.length) return { rows: [], format: 'csv' };
  const sample = lines.slice(0, 5).join('\n');
  const delimiter = ['\t', ',', ';'].map((item) => [item, sample.split(item).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  return {
    rows: lines.map((line, index) => ({ number: index + 1, cells: splitLine(line, delimiter) })).filter((row) => row.cells.some(Boolean)),
    format: 'csv',
  };
}

/** Lower-cased, single-spaced, without punctuation that varies between exports. */
export function normalizeHeader(value: string): string {
  return value.replace(/﻿/g, '').replace(/[.:_\-–/\\()[\]]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
}

/**
 * Finds the header row (exports often start with a title or a period line)
 * and which column holds each field. `fields` maps a field to the header
 * names it may carry; the row matching the most fields wins.
 */
export function detectColumns<F extends string>(
  table: SheetTable, fields: Record<F, string[]>, required: F[] = [],
): { headerIndex: number; header: string[]; columns: Record<F, number> } | null {
  const wanted = Object.fromEntries(Object.entries(fields).map(([field, names]) =>
    [field, (names as string[]).map(normalizeHeader)])) as Record<F, string[]>;
  let best: { headerIndex: number; header: string[]; columns: Record<F, number>; score: number } | null = null;
  for (let index = 0; index < Math.min(table.rows.length, 15); index += 1) {
    const header = table.rows[index].cells.map((cell) => normalizeHeader(cell));
    const columns = {} as Record<F, number>;
    const used = new Set<number>();
    let score = 0;
    for (const field of Object.keys(wanted) as F[]) {
      // Exact names first, so "date" is not taken by "date time".
      let column = header.findIndex((cell, at) => !used.has(at) && wanted[field].includes(cell));
      if (column < 0) column = -1;
      columns[field] = column;
      if (column >= 0) { used.add(column); score += 1; }
    }
    if (required.some((field) => columns[field] < 0)) continue;
    if (score >= 2 && (!best || score > best.score)) best = { headerIndex: index, header: table.rows[index].cells, columns, score };
  }
  return best ? { headerIndex: best.headerIndex, header: best.header, columns: best.columns } : null;
}

/**
 * Dates as exports write them: 2026-10-05, 2026/10/05, 05/10/2026 (day first
 * unless told otherwise), 5-10-2026, optionally followed by a time.
 */
export type DateOrder = 'dmy' | 'mdy';

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1950 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

export function parseDate(text: string, order: DateOrder = 'dmy'): string | null {
  const value = text.trim().replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
  // A date cell Excel did not format as a date arrives as its serial number.
  if (/^\d{5}(\.\d+)?$/.test(value)) {
    const serial = Math.floor(Number(value));
    if (serial > 20000 && serial < 80000) return new Date(EXCEL_EPOCH + serial * 86400000).toISOString().slice(0, 10);
  }
  const match = value.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})(?:[ T].*)?$/);
  if (!match) return null;
  const [, a, b, c] = match;
  let year: number; let month: number; let day: number;
  if (a.length === 4) [year, month, day] = [Number(a), Number(b), Number(c)];
  else if (c.length === 4) {
    year = Number(c);
    [day, month] = order === 'dmy' ? [Number(a), Number(b)] : [Number(b), Number(a)];
  } else return null;
  return validDate(year, month, day) ? `${year}-${pad(month)}-${pad(day)}` : null;
}

/** 8:05, 08:05:30, 8:05 PM, ٨:٠٥ م; or the time part of a date-time. Returns HH:MM:SS. */
export function parseTime(text: string): string | null {
  const value = text.trim().replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
  // A time cell Excel did not format as a time arrives as a fraction of a day.
  if (/^0?\.\d+$/.test(value)) {
    const seconds = Math.round(Number(value) * 86400);
    if (seconds >= 0 && seconds < 86400) return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
  }
  const match = value.match(/(?:^|[ T])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(am|pm|ص|م)?$/i)
    ?? value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|ص|م)?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  const meridiem = match[4];
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    const pm = /^(pm|م)$/i.test(meridiem);
    if (pm && hours < 12) hours += 12;
    if (!pm && hours === 12) hours = 0;
  }
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** Names compared loosely: hamza forms, taa marbuta, spacing and case do not count. */
export function nameKey(value: string): string {
  return value.replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when two spellings of a person's name plausibly name the same person. */
export function sameName(a: string, b: string): boolean {
  const left = nameKey(a);
  const right = nameKey(b);
  if (!left || !right) return true;
  if (left === right || left.startsWith(right) || right.startsWith(left)) return true;
  const words = (text: string) => text.split(' ').filter((word) => word.length > 1);
  const leftWords = words(left);
  const rightWords = new Set(words(right));
  const shared = leftWords.filter((word) => rightWords.has(word)).length;
  return shared >= Math.min(2, leftWords.length, rightWords.size);
}
