import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseDateTime, parseExcelPunches, parseTextPunches } from '../src/services/punchParser';

describe('punch file parsing', () => {
  it('reads date forms used by fingerprint exports', () => {
    expect(parseDateTime('2026-10-01 08:01:22', 'dmy')).toBe('2026-10-01T08:01:22');
    expect(parseDateTime('01/10/2026 8:05', 'dmy')).toBe('2026-10-01T08:05:00');
    expect(parseDateTime('10/1/2026 8:05 PM', 'mdy')).toBe('2026-10-01T20:05:00');
    expect(parseDateTime('01/10/2026 12:15 ص', 'dmy')).toBe('2026-10-01T00:15:00');
    expect(parseDateTime('31/02/2026 08:00', 'dmy')).toBeNull();
    expect(parseDateTime('13/13/2026 08:00', 'dmy')).toBeNull();
    expect(parseDateTime('garbage', 'dmy')).toBeNull();
  });

  it('reads a headerless ZKTeco attlog and drops leading zeros from PINs', () => {
    const text = '    0012\t2026-10-01 07:58:10\t0\t1\t0\t0\n    12\t2026-10-01 16:03:44\t1\t1\t0\t0\nbad line\n';
    const parsed = parseTextPunches(text, 'dmy');
    expect(parsed.punches).toEqual([
      { pin: '12', at: '2026-10-01T07:58:10' },
      { pin: '12', at: '2026-10-01T16:03:44' },
    ]);
    expect(parsed.invalid).toBe(1);
  });

  it('reads a CSV export with an Arabic header and separate date and time', () => {
    const text = '﻿رقم البصمة,الاسم,التاريخ,الوقت\n7,"علي, حسن",02/10/2026,08:00\n7,"علي, حسن",02/10/2026,16:00\n';
    const parsed = parseTextPunches(text, 'dmy');
    expect(parsed.punches).toEqual([
      { pin: '7', at: '2026-10-02T08:00:00' },
      { pin: '7', at: '2026-10-02T16:00:00' },
    ]);
  });

  it('reads the ZKTeco "AC-No. / Time" export where Time holds date and time', () => {
    const text = 'AC-No.,Name,Time,State\n5,Ahmed,1/10/2026 8:00 AM,C/In\n';
    expect(parseTextPunches(text, 'dmy').punches).toEqual([{ pin: '5', at: '2026-10-01T08:00:00' }]);
  });

  it('reads an Excel sheet with real date cells', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Att');
    sheet.addRow(['Enroll No', 'DateTime']);
    sheet.addRow([9, new Date(Date.UTC(2026, 9, 3, 7, 59, 0))]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const parsed = await parseExcelPunches(buffer, 'dmy');
    expect(parsed.punches).toEqual([{ pin: '9', at: '2026-10-03T07:59:00' }]);
  });
});
