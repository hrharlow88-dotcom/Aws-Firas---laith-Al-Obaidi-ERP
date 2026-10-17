import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { SystemSetting } from '../models';
import { COMP_LEAVE_TYPE_ID, normalizeSystemSettings } from '../config/systemSettings';
import { execute, select, selectOne, transaction } from '../db/query';
import { employeeInScope, employeeScopeSql } from '../services/access';
import { notifyEmployees } from '../services/notify';
import { getSettings, invalidateSettingsCache, SETTINGS_ID } from '../services/settings';
import { recordAudit } from '../utils/audit';
import { badRequest, body, conflict, optionalNumber, optionalText, requiredText } from '../utils/http';
import { isDateOnly, isUuid } from '../utils/validation';

/** Fixed-date national holidays proposed every year (the owner confirms them). */
const FIXED: Array<[string, string, string]> = [
  ['01-01', 'رأس السنة الميلادية', "New Year's Day"],
  ['01-06', 'عيد الجيش العراقي', 'Army Day'],
  ['03-21', 'عيد نوروز', 'Nowruz'],
  ['05-01', 'عيد العمال', 'Labour Day'],
  ['10-03', 'اليوم الوطني', 'National Day'],
  ['12-10', 'يوم النصر', 'Victory Day'],
  ['12-25', 'عيد الميلاد المجيد', 'Christmas Day'],
];
/** Hijri holidays: [month, day, days, Arabic, English]; dates follow the Umm al-Qura calendar and move with the moon sighting. */
const HIJRI: Array<[number, number, number, string, string]> = [
  [1, 1, 1, 'رأس السنة الهجرية', 'Islamic New Year'],
  [1, 10, 1, 'عاشوراء', 'Ashura'],
  [3, 12, 1, 'المولد النبوي الشريف', "Prophet's Birthday"],
  [10, 1, 3, 'عيد الفطر', 'Eid al-Fitr'],
  [12, 10, 4, 'عيد الأضحى', 'Eid al-Adha'],
  [12, 18, 1, 'عيد الغدير', 'Eid al-Ghadir'],
];

const hijriFormat = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
function hijriOf(date: Date): { month: number; day: number } {
  const parts = hijriFormat.formatToParts(date);
  return { month: Number(parts.find((part) => part.type === 'month')?.value), day: Number(parts.find((part) => part.type === 'day')?.value) };
}

/** The proposed holidays of a Gregorian year: fixed dates plus approximate Hijri dates. */
export function proposeHolidays(year: number): Array<{ date: string; nameAr: string; nameEn: string; source: 'fixed' | 'hijri' }> {
  const out: Array<{ date: string; nameAr: string; nameEn: string; source: 'fixed' | 'hijri' }> = [];
  for (const [monthDay, nameAr, nameEn] of FIXED) out.push({ date: `${year}-${monthDay}`, nameAr, nameEn, source: 'fixed' });
  for (let day = new Date(Date.UTC(year, 0, 1)); day.getUTCFullYear() === year; day = new Date(day.getTime() + 86400000)) {
    const hijri = hijriOf(day);
    for (const [month, start, length, nameAr, nameEn] of HIJRI) {
      if (hijri.month === month && hijri.day >= start && hijri.day < start + length) {
        const index = hijri.day - start + 1;
        out.push({
          date: day.toISOString().slice(0, 10), source: 'hijri',
          nameAr: length > 1 ? `${nameAr} (اليوم ${index})` : nameAr, nameEn: length > 1 ? `${nameEn} (day ${index})` : nameEn,
        });
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((item) => (seen.has(item.date) ? false : (seen.add(item.date), true))).sort((a, b) => a.date.localeCompare(b.date));
}

/** Confirmed holidays also live in the settings list that leave and attendance use. */
async function syncSettingsHoliday(req: Request, date: string, on: boolean, tx: Parameters<typeof execute>[2]): Promise<void> {
  const settings = normalizeSystemSettings((await SystemSetting.findByPk(SETTINGS_ID, { transaction: tx ?? undefined }))?.value);
  const list = new Set(settings.leaveRules.officialHolidays);
  if (on) list.add(date); else list.delete(date);
  settings.leaveRules.officialHolidays = [...list].sort();
  await SystemSetting.upsert({ id: SETTINGS_ID, value: settings, updatedBy: req.user!.id }, { transaction: tx ?? undefined });
}

/**
 * The official holiday calendar (proposed by the system each year, confirmed
 * by the owner as the government announces it) and compensatory leave for
 * those who worked on a holiday, kept apart from annual leave.
 */
export class HolidayController {
  static async list(req: Request, res: Response): Promise<void> {
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const rows = await select(
      `SELECT to_char(h.holiday_date, 'YYYY-MM-DD') AS date, h.name_ar AS "nameAr", h.name_en AS "nameEn", h.source, h.confirmed,
              h.confirmed_at AS "confirmedAt", u.name AS "confirmedByName"
       FROM holiday_calendar h LEFT JOIN users u ON u.id = h.confirmed_by
       WHERE date_part('year', h.holiday_date) = :year ORDER BY h.holiday_date`,
      { year },
    );
    const settings = await getSettings();
    const known = new Set(rows.map((row) => (row as { date: string }).date));
    const legacy = settings.leaveRules.officialHolidays.filter((date) => date.startsWith(`${year}-`) && !known.has(date))
      .map((date) => ({ date, nameAr: 'عطلة رسمية', nameEn: 'Official holiday', source: 'manual', confirmed: true }));
    res.json({ data: { year, holidays: [...rows, ...legacy].sort((a, b) => String((a as { date: string }).date).localeCompare(String((b as { date: string }).date))), compDays: settings.leaveRules.compLeaveDaysPerHoliday ?? 1 } });
  }

  /** Fills the year with proposals; nothing counts as a holiday until it is confirmed. */
  static async propose(req: Request, res: Response): Promise<void> {
    const year = Number(body(req).year);
    if (!Number.isInteger(year) || year < 2020 || year > 2100) throw badRequest('السنة غير صالحة.');
    const proposals = proposeHolidays(year);
    let added = 0;
    for (const item of proposals) {
      const rows = await execute(
        `INSERT INTO holiday_calendar (holiday_date, name_ar, name_en, source) VALUES (:date, :nameAr, :nameEn, :source)
         ON CONFLICT (holiday_date) DO NOTHING RETURNING holiday_date`,
        item,
      );
      added += rows.length;
    }
    await recordAudit(req, null, 'holidays.proposed', 'holiday_calendar', null, { year, added });
    res.json({ data: { year, added, proposals: proposals.length } });
  }

  static async save(req: Request, res: Response): Promise<void> {
    const input = body(req);
    const date = String(input.date || '');
    if (!isDateOnly(date)) throw badRequest('التاريخ غير صالح.');
    const nameAr = requiredText(input, 'nameAr', 120, 'اسم العطلة');
    const nameEn = optionalText(input, 'nameEn', 120) ?? null;
    const confirm = input.confirmed === true;
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO holiday_calendar (holiday_date, name_ar, name_en, source, confirmed, confirmed_by, confirmed_at)
         VALUES (:date, :nameAr, :nameEn, 'manual', :confirm, :by, CASE WHEN :confirm THEN now() END)
         ON CONFLICT (holiday_date) DO UPDATE SET name_ar = EXCLUDED.name_ar, name_en = EXCLUDED.name_en,
           confirmed = EXCLUDED.confirmed, confirmed_by = EXCLUDED.confirmed_by, confirmed_at = EXCLUDED.confirmed_at`,
        { date, nameAr, nameEn, confirm, by: confirm ? req.user!.id : null }, tx,
      );
      await syncSettingsHoliday(req, date, confirm, tx);
      await recordAudit(req, tx, 'holidays.saved', 'holiday_calendar', null, { date, nameAr, confirm });
    });
    invalidateSettingsCache();
    res.json({ data: { date } });
  }

  static async confirm(req: Request, res: Response): Promise<void> {
    const date = req.params.date;
    if (!isDateOnly(date)) throw badRequest('التاريخ غير صالح.');
    const on = body(req).confirmed !== false;
    await transaction(async (tx) => {
      const rows = await execute(
        `UPDATE holiday_calendar SET confirmed = :on, confirmed_by = CASE WHEN :on THEN :userId::uuid END, confirmed_at = CASE WHEN :on THEN now() END
         WHERE holiday_date = :date RETURNING holiday_date`,
        { date, on, userId: req.user!.id }, tx,
      );
      if (!rows.length) throw badRequest('العطلة غير موجودة.');
      await syncSettingsHoliday(req, date, on, tx);
      await recordAudit(req, tx, on ? 'holidays.confirmed' : 'holidays.unconfirmed', 'holiday_calendar', null, { date });
    });
    invalidateSettingsCache();
    res.json({ data: { date, confirmed: on } });
  }

  static async remove(req: Request, res: Response): Promise<void> {
    const date = req.params.date;
    if (!isDateOnly(date)) throw badRequest('التاريخ غير صالح.');
    await transaction(async (tx) => {
      await execute('DELETE FROM holiday_calendar WHERE holiday_date = :date', { date }, tx);
      await syncSettingsHoliday(req, date, false, tx);
      await recordAudit(req, tx, 'holidays.removed', 'holiday_calendar', null, { date });
    });
    invalidateSettingsCache();
    res.json({ data: { ok: true } });
  }

  /** Who punched in on an official holiday in a month and has no compensatory credit for it yet. */
  static async compSuggestions(req: Request, res: Response): Promise<void> {
    const period = typeof req.query.period === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.period) ? req.query.period : null;
    if (!period) throw badRequest('حدد الشهر.');
    const settings = await getSettings();
    const holidays = settings.leaveRules.officialHolidays.filter((date) => date.startsWith(period));
    if (!holidays.length) { res.json({ data: { holidays, rows: [] } }); return; }
    const scope = employeeScopeSql(req);
    const rows = await select(
      `SELECT DISTINCT e.id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "employeeName",
              to_char(p.punched_at AT TIME ZONE 'Asia/Baghdad', 'YYYY-MM-DD') AS "workDate"
       FROM attendance_punches p JOIN employees e ON e.id = p.employee_id
       WHERE to_char(p.punched_at AT TIME ZONE 'Asia/Baghdad', 'YYYY-MM-DD') IN (:holidays)${scope.sql}
         AND NOT EXISTS (SELECT 1 FROM comp_leave_credits c WHERE c.employee_id = e.id
                         AND to_char(c.work_date, 'YYYY-MM-DD') = to_char(p.punched_at AT TIME ZONE 'Asia/Baghdad', 'YYYY-MM-DD'))
       ORDER BY 4, 2`,
      { holidays, ...scope.params },
    );
    res.json({ data: { holidays, rows, compDays: settings.leaveRules.compLeaveDaysPerHoliday ?? 1 } });
  }

  static async compCredits(req: Request, res: Response): Promise<void> {
    const scope = employeeScopeSql(req);
    const employeeId = typeof req.query.employeeId === 'string' && isUuid(req.query.employeeId) ? req.query.employeeId : null;
    const rows = await select(
      `SELECT c.id, c.employee_id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "employeeName",
              to_char(c.work_date, 'YYYY-MM-DD') AS "workDate", c.days::float AS days, c.reason, c.created_at AS "createdAt", u.name AS "createdByName"
       FROM comp_leave_credits c JOIN employees e ON e.id = c.employee_id JOIN users u ON u.id = c.created_by
       WHERE true${scope.sql} ${employeeId ? 'AND c.employee_id = :employeeId' : ''}
       ORDER BY c.work_date DESC LIMIT 500`,
      { ...scope.params, employeeId },
    );
    res.json({ data: rows });
  }

  /** Credits compensatory leave to the separate balance for work on an official holiday. */
  static async grantComp(req: Request, res: Response): Promise<void> {
    const input = body(req);
    const items = Array.isArray(input.items) ? input.items : [input];
    if (!items.length || items.length > 500) throw badRequest('لا توجد سجلات.');
    const settings = await getSettings();
    const holidays = new Set(settings.leaveRules.officialHolidays);
    const defaultDays = settings.leaveRules.compLeaveDaysPerHoliday ?? 1;
    const granted: string[] = [];
    await transaction(async (tx) => {
      for (const raw of items as Array<Record<string, unknown>>) {
        const employee = await employeeInScope(req, raw.employeeId);
        const workDate = String(raw.workDate || '');
        if (!isDateOnly(workDate)) throw badRequest('تاريخ العمل غير صالح.');
        if (!holidays.has(workDate)) throw badRequest(`${workDate} ليس عطلة رسمية مؤكدة.`);
        const days = optionalNumber(raw, 'days', { min: 0.5, max: 5 }) ?? defaultDays;
        if (await selectOne('SELECT 1 FROM comp_leave_credits WHERE employee_id = :id AND work_date = :workDate', { id: employee.id, workDate }, tx)) {
          throw conflict(`${employee.fullName ?? 'الموظف'}: مُنح تعويض عن ${workDate} سابقاً.`);
        }
        const ledgerId = randomUUID();
        const reason = (typeof raw.reason === 'string' && raw.reason.trim().slice(0, 300)) || `عمل في عطلة رسمية ${workDate}`;
        await execute(
          `INSERT INTO leave_ledger_entries (id, employee_id, leave_type_id, quantity, entry_type, reason, created_by, created_at)
           VALUES (:id, :employeeId, :typeId, :days, 'adjustment', :reason, :userId, now())`,
          { id: ledgerId, employeeId: employee.id, typeId: COMP_LEAVE_TYPE_ID, days, reason, userId: req.user!.id }, tx,
        );
        await execute(
          `INSERT INTO comp_leave_credits (id, employee_id, work_date, days, reason, ledger_entry_id, created_by)
           VALUES (:id, :employeeId, :workDate, :days, :reason, :ledgerId, :userId)`,
          { id: randomUUID(), employeeId: employee.id, workDate, days, reason, ledgerId, userId: req.user!.id }, tx,
        );
        await notifyEmployees([employee.id], { kind: 'leave', title: `أُضيف ${days} يوم إجازة تعويضية`, body: `عن العمل يوم ${workDate} (خارج رصيد الإجازة السنوية).`, link: '/my' }, tx);
        granted.push(employee.id);
      }
      await recordAudit(req, tx, 'leave.comp_granted', 'employee', null, { count: granted.length });
    });
    res.status(201).json({ data: { granted: granted.length } });
  }
}

export default HolidayController;
