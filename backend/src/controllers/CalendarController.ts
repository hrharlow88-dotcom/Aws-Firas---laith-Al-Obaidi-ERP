import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { SystemSetting } from '../models';
import { normalizeSystemSettings } from '../config/systemSettings';
import { execute, select, selectOne, transaction } from '../db/query';
import { employeeScopeSql, branchScope } from '../services/access';
import { can, getSettings, invalidateSettingsCache, SETTINGS_ID } from '../services/settings';
import { moveToBin, snapshot } from '../services/recycleBin';
import { notifyPermission } from '../services/notify';
import { recordAudit } from '../utils/audit';
import { assertOnlyKeys, badRequest, body, forbidden, notFound, optionalText, requiredText } from '../utils/http';
import { isDateOnly, isUuid } from '../utils/validation';

const CATEGORIES = ['meeting', 'training', 'event', 'deadline', 'holiday', 'visit', 'other'];
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export interface CalendarItem {
  id: string;
  source: 'event' | 'holiday' | 'leave' | 'payroll' | 'interview' | 'expiry' | 'contract' | 'birthday';
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  category?: string;
  color?: string | null;
  editable?: boolean;
  link?: string | null;
  detail?: string | null;
}

/**
 * One calendar over everything with a date: company events (editable),
 * official holidays, leave, payroll months, interviews, document and contract
 * expiries and birthdays. Each source follows the viewer's permissions and
 * data scope.
 */
export class CalendarController {
  static async range(req: Request, res: Response): Promise<void> {
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!isDateOnly(from) || !isDateOnly(to) || to < from) throw badRequest('حدد بداية ونهاية الفترة.');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 62) throw badRequest('أقصى فترة شهران.');
    const settings = await getSettings();
    const scope = employeeScopeSql(req);
    const userBranch = branchScope(req) ?? req.user!.branchId ?? null;
    const items: CalendarItem[] = [];
    const manage = await can(req, 'calendar.manage');

    const events = await select<{ id: string; title: string; description: string | null; category: string; start: string; end: string;
      allDay: boolean; color: string | null; location: string | null; createdBy: string; visibility: string }>(
      `SELECT id, title, description, category, to_char(starts_at, 'YYYY-MM-DD"T"HH24:MI') AS start, to_char(ends_at, 'YYYY-MM-DD"T"HH24:MI') AS "end",
              all_day AS "allDay", color, location, created_by AS "createdBy", visibility
       FROM calendar_events
       WHERE cancelled_at IS NULL AND starts_at < (:to::date + 1) AND ends_at >= :from::date
         AND (visibility = 'company' OR created_by = :userId
              OR (visibility = 'branch' AND (:branch::uuid IS NULL OR branch_id IS NULL OR branch_id = :branch::uuid)))`,
      { from, to, userId: req.user!.id, branch: userBranch },
    );
    for (const event of events) {
      items.push({
        id: event.id, source: 'event', title: event.title, start: event.start, end: event.end, allDay: event.allDay,
        category: event.category, color: event.color, editable: manage || event.createdBy === req.user!.id,
        detail: [event.location, event.description].filter(Boolean).join(' — ') || null,
      });
    }
    for (const date of settings.leaveRules.officialHolidays) {
      if (date >= from && date <= to) {
        items.push({ id: `holiday-${date}`, source: 'holiday', title: 'عطلة رسمية · Public holiday', start: date, end: date, allDay: true, editable: manage });
      }
    }
    if (await can(req, 'leaves.view')) {
      const leaves = await select<{ id: string; name: string; type: string | null; startsOn: string; endsOn: string; status: string }>(
        `SELECT l.id, e.full_name AS name, l.leave_type_id::text AS type, to_char(l.starts_on, 'YYYY-MM-DD') AS "startsOn",
                to_char(l.ends_on, 'YYYY-MM-DD') AS "endsOn", l.status::text AS status
         FROM leave_requests l JOIN employees e ON e.id = l.employee_id
         WHERE l.status IN ('approved','pending') AND l.starts_on <= :to AND l.ends_on >= :from${scope.sql}
         ORDER BY l.starts_on LIMIT 600`,
        { from, to, ...scope.params },
      );
      const typeName = new Map(settings.leaveTypes.map((type) => [type.id, type.name]));
      for (const leave of leaves) {
        items.push({
          id: `leave-${leave.id}`, source: 'leave', title: `${leave.name} — ${typeName.get(leave.type ?? '') ?? 'إجازة'}${leave.status === 'pending' ? ' (بانتظار الموافقة)' : ''}`,
          start: leave.startsOn, end: leave.endsOn, allDay: true, link: '/leaves',
        });
      }
    }
    if (await can(req, 'payroll.view')) {
      const runs = await select<{ id: string; period: string; endsOn: string; status: string; branch: string | null }>(
        `SELECT r.id, r.period, to_char(r.ends_on, 'YYYY-MM-DD') AS "endsOn", r.status, b.name AS branch
         FROM payroll_runs r LEFT JOIN branches b ON b.id = r.branch_id
         WHERE r.status <> 'cancelled' AND r.ends_on BETWEEN :from AND :to`,
        { from, to },
      );
      for (const run of runs) {
        items.push({ id: `payroll-${run.id}`, source: 'payroll', title: `مسير ${run.period}${run.branch ? ` — ${run.branch}` : ''} (${({ draft: 'مسودة', calculated: 'محتسب', approved: 'معتمد', posted: 'مُرحّل' } as Record<string, string>)[run.status] ?? run.status})`, start: run.endsOn, end: run.endsOn, allDay: true, link: `/payroll/${run.id}` });
      }
    }
    if (await can(req, 'recruitment.view')) {
      const interviews = await select<{ id: string; name: string; at: string; position: string }>(
        `SELECT a.id, a.full_name AS name, to_char(a.interview_at AT TIME ZONE 'Asia/Baghdad', 'YYYY-MM-DD"T"HH24:MI') AS at, p.title AS position
         FROM applicants a JOIN job_positions p ON p.id = a.position_id
         WHERE a.interview_at IS NOT NULL AND a.interview_at >= (:from::date)::timestamp AT TIME ZONE 'Asia/Baghdad'
           AND a.interview_at < ((:to::date + 1)::timestamp AT TIME ZONE 'Asia/Baghdad')`,
        { from, to },
      ).catch(() => []);
      for (const item of interviews) {
        items.push({ id: `interview-${item.id}`, source: 'interview', title: `مقابلة: ${item.name} — ${item.position}`, start: item.at, end: item.at, allDay: false, link: `/recruitment` });
      }
    }
    if (await can(req, 'employees.view_profile')) {
      const expiries = await select<{ id: string; employeeId: string; name: string; title: string; date: string }>(
        `SELECT d.id, e.id AS "employeeId", e.full_name AS name, d.title, to_char(d.expiry_date, 'YYYY-MM-DD') AS date
         FROM employee_documents d JOIN employees e ON e.id = d.employee_id
         WHERE d.deleted_at IS NULL AND d.expiry_date BETWEEN :from AND :to${scope.sql}`,
        { from, to, ...scope.params },
      );
      for (const item of expiries) {
        items.push({ id: `expiry-${item.id}`, source: 'expiry', title: `انتهاء ${item.title}: ${item.name}`, start: item.date, end: item.date, allDay: true, link: `/employees/${item.employeeId}` });
      }
      const contracts = await select<{ id: string; employeeId: string; name: string; date: string; probation: boolean }>(
        `SELECT c.id, e.id AS "employeeId", e.full_name AS name,
                to_char(CASE WHEN c.probation_ends_on BETWEEN :from AND :to THEN c.probation_ends_on ELSE c.ends_on END, 'YYYY-MM-DD') AS date,
                c.probation_ends_on BETWEEN :from AND :to AS probation
         FROM employee_contracts c JOIN employees e ON e.id = c.employee_id
         WHERE c.status = 'active' AND (c.ends_on BETWEEN :from AND :to OR c.probation_ends_on BETWEEN :from AND :to)${scope.sql}`,
        { from, to, ...scope.params },
      );
      for (const item of contracts) {
        items.push({ id: `contract-${item.id}`, source: 'contract', title: `${item.probation ? 'نهاية فترة التجربة' : 'انتهاء العقد'}: ${item.name}`, start: item.date, end: item.date, allDay: true, link: `/employees/${item.employeeId}` });
      }
      const birthdays = await select<{ employeeId: string; name: string; date: string }>(
        `SELECT e.id AS "employeeId", e.full_name AS name, to_char(make_date(y.year, extract(month FROM p.birth_date)::int,
                  LEAST(extract(day FROM p.birth_date)::int, 28 + CASE WHEN extract(month FROM p.birth_date) = 2 THEN 0 ELSE 3 END)), 'YYYY-MM-DD') AS date
         FROM employee_profiles p JOIN employees e ON e.id = p.employee_id
         CROSS JOIN (SELECT DISTINCT extract(year FROM d)::int AS year FROM generate_series(:from::date, :to::date, interval '1 day') d) y
         WHERE p.birth_date IS NOT NULL AND e.employment_status <> 'inactive'${scope.sql}`,
        { from, to, ...scope.params },
      );
      for (const item of birthdays) {
        if (item.date >= from && item.date <= to) {
          items.push({ id: `birthday-${item.employeeId}-${item.date}`, source: 'birthday', title: `عيد ميلاد ${item.name}`, start: item.date, end: item.date, allDay: true });
        }
      }
    }
    res.json({ data: { items, canManage: manage } });
  }

  static async save(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['title', 'description', 'category', 'start', 'end', 'allDay', 'visibility', 'branchId', 'location', 'color']);
    const title = requiredText(input, 'title', 200, 'العنوان');
    const category = String(input.category || 'event');
    if (!CATEGORIES.includes(category)) throw badRequest('نوع الموعد غير معروف.');
    const start = String(input.start || '');
    const end = String(input.end || input.start || '');
    const allDay = input.allDay === true;
    const valid = (value: string) => LOCAL.test(value) || isDateOnly(value);
    if (!valid(start) || !valid(end)) throw badRequest('حدد وقت البداية والنهاية.');
    const startsAt = start.length === 10 ? `${start}T00:00` : start;
    const endsAt = end.length === 10 ? `${end}T${allDay ? '23:59' : '00:00'}` : end;
    if (endsAt < startsAt) throw badRequest('النهاية قبل البداية.');
    const manage = await can(req, 'calendar.manage');
    const visibility = manage && ['company', 'branch', 'private'].includes(String(input.visibility)) ? String(input.visibility) : 'private';
    const branchId = visibility === 'branch' && isUuid(input.branchId) ? String(input.branchId) : null;
    const color = typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : null;
    const values = {
      title, description: optionalText(input, 'description', 2000) ?? null, category, startsAt, endsAt, allDay, visibility, branchId,
      location: optionalText(input, 'location', 200) ?? null, color,
    };
    const id = req.params.id ?? randomUUID();
    await transaction(async (tx) => {
      if (req.params.id) {
        const current = await selectOne<{ createdBy: string }>('SELECT created_by AS "createdBy" FROM calendar_events WHERE id = :id AND cancelled_at IS NULL', { id }, tx);
        if (!current) throw notFound('الموعد غير موجود.');
        if (!manage && current.createdBy !== req.user!.id) throw forbidden();
        await execute(
          `UPDATE calendar_events SET title = :title, description = :description, category = :category, starts_at = :startsAt, ends_at = :endsAt,
             all_day = :allDay, visibility = :visibility, branch_id = :branchId, location = :location, color = :color, updated_at = now()
           WHERE id = :id`,
          { id, ...values }, tx,
        );
        await recordAudit(req, tx, 'calendar.updated', 'calendar_event', id, { title, startsAt });
      } else {
        await execute(
          `INSERT INTO calendar_events (id, title, description, category, starts_at, ends_at, all_day, visibility, branch_id, location, color, created_by)
           VALUES (:id, :title, :description, :category, :startsAt, :endsAt, :allDay, :visibility, :branchId, :location, :color, :userId)`,
          { id, ...values, userId: req.user!.id }, tx,
        );
        await recordAudit(req, tx, 'calendar.created', 'calendar_event', id, { title, startsAt, visibility });
        if (visibility === 'company') {
          await notifyPermission('self.service', {
            kind: 'calendar', title: `موعد جديد في تقويم الشركة: ${title}`, body: startsAt.replace('T', ' '), link: '/calendar',
          }, tx, req.user!.id);
        }
      }
    });
    res.status(req.params.id ? 200 : 201).json({ data: { id } });
  }

  static async cancel(req: Request, res: Response): Promise<void> {
    const manage = await can(req, 'calendar.manage');
    await transaction(async (tx) => {
      const copy = await snapshot('calendar_events', req.params.id, tx);
      if (!copy || copy.cancelled_at) throw notFound('الموعد غير موجود.');
      if (!manage && copy.created_by !== req.user!.id) throw forbidden();
      await execute('UPDATE calendar_events SET cancelled_at = now() WHERE id = :id', { id: req.params.id }, tx);
      await moveToBin(req, tx, { entityType: 'calendar_event', entityId: req.params.id, module: 'calendar', title: `موعد: ${String(copy.title)}`, payload: copy });
      await recordAudit(req, tx, 'calendar.cancelled', 'calendar_event', req.params.id);
    });
    res.json({ data: { ok: true } });
  }

  /** Marks or clears an official holiday (used by leave and attendance rules). */
  static async holiday(req: Request, res: Response): Promise<void> {
    const date = req.params.date;
    if (!isDateOnly(date)) throw badRequest('التاريخ غير صالح.');
    const on = req.body?.holiday === true;
    await transaction(async (tx) => {
      const settings = normalizeSystemSettings((await SystemSetting.findByPk(SETTINGS_ID, { transaction: tx }))?.value);
      const list = new Set(settings.leaveRules.officialHolidays);
      if (on) list.add(date); else list.delete(date);
      settings.leaveRules.officialHolidays = [...list].sort();
      await SystemSetting.upsert({ id: SETTINGS_ID, value: settings, updatedBy: req.user!.id }, { transaction: tx });
      await recordAudit(req, tx, on ? 'calendar.holiday_added' : 'calendar.holiday_removed', 'system_settings', SETTINGS_ID, { date });
    });
    invalidateSettingsCache();
    res.json({ data: { ok: true } });
  }
}

export default CalendarController;
