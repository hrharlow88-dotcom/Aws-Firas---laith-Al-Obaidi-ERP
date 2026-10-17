import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { execute, insertRow, select, selectOne, setClause, transaction } from '../db/query';
import { branchScope, employeeInScope, employeeScopeSql } from '../services/access';
import {
  computeAttendance, EFFECTIVE_DAY_COLUMNS, ingestPunches, localToday, recomputeAfterIngest,
} from '../services/attendance';
import { addDays } from '../services/attendanceRules';
import { DateOrder, isXlsx, parseExcelPunches, parseTextPunches } from '../services/punchParser';
import { getSettings } from '../services/settings';
import { uploadedName } from '../services/storage';
import { recordAudit } from '../utils/audit';
import {
  assertOnlyKeys, badRequest, body, conflict, notFound, optionalNumber, optionalText, queryText, requiredText,
} from '../utils/http';
import { isDateOnly, isUuid } from '../utils/validation';

const SHIFT_COLUMNS = {
  code: 'code', name: 'name', startTime: 'start_time', endTime: 'end_time', breakMinutes: 'break_minutes',
  graceMinutes: 'grace_minutes', earlyLeaveGraceMinutes: 'early_leave_grace_minutes', workingDays: 'working_days',
  isDefault: 'is_default', isActive: 'is_active',
};

function time(input: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw badRequest('أدخل الوقت بصيغة ساعة:دقيقة (24 ساعة).', { field: key });
  }
  return value;
}

function dateRange(req: Request, maxDays = 93): { from: string; to: string } {
  const from = queryText(req, 'from') || String(body(req).from ?? '');
  const to = queryText(req, 'to') || String(body(req).to ?? '');
  if (!isDateOnly(from) || !isDateOnly(to) || to < from) throw badRequest('حدد فترة صحيحة (من - إلى).');
  if (addDays(from, maxDays) < to) throw badRequest(`الفترة يجب ألا تتجاوز ${maxDays} يوماً.`);
  return { from, to };
}

function boolField(input: Record<string, unknown>, key: string): boolean | undefined {
  if (input[key] === undefined) return undefined;
  if (typeof input[key] !== 'boolean') throw badRequest('قيمة غير صالحة.', { field: key });
  return input[key] as boolean;
}

async function assertDaysUnlocked(employeeId: string, from: string, to: string): Promise<void> {
  const locked = await selectOne<{ workDate: string }>(
    `SELECT to_char(work_date, 'YYYY-MM-DD') AS "workDate" FROM attendance_days
     WHERE employee_id = :employeeId AND work_date BETWEEN :from AND :to AND payroll_run_id IS NOT NULL LIMIT 1`,
    { employeeId, from, to },
  );
  if (locked) throw conflict(`يوم ${locked.workDate} مقفل ضمن مسير رواتب معتمد ولا يمكن تعديله.`);
}

export class AttendanceController {
  // --- Shifts -------------------------------------------------------------

  static async listShifts(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT s.id, s.code, s.name, to_char(s.start_time, 'HH24:MI') AS "startTime", to_char(s.end_time, 'HH24:MI') AS "endTime",
              s.break_minutes AS "breakMinutes", s.grace_minutes AS "graceMinutes",
              s.early_leave_grace_minutes AS "earlyLeaveGraceMinutes", s.working_days::int[] AS "workingDays",
              s.is_default AS "isDefault", s.is_active AS "isActive",
              (SELECT count(*)::int FROM employees e WHERE e.shift_id = s.id AND e.employment_status <> 'inactive') AS "employeeCount"
       FROM shifts s ORDER BY s.is_active DESC, s.name`,
    );
    res.json({ data: rows });
  }

  static async saveShift(req: Request, res: Response): Promise<void> {
    const id = req.params.id;
    const creating = !id;
    const input = body(req);
    assertOnlyKeys(input, Object.keys(SHIFT_COLUMNS));
    const workingDays = input.workingDays;
    if (workingDays !== undefined && (!Array.isArray(workingDays) || !workingDays.length ||
      !workingDays.every((day) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6) ||
      new Set(workingDays).size !== workingDays.length)) {
      throw badRequest('اختر أيام دوام صحيحة.');
    }
    const code = creating ? requiredText(input, 'code', 24, 'رمز الدوام') : optionalText(input, 'code', 24) ?? undefined;
    if (code && !/^[A-Za-z0-9._-]+$/.test(code)) throw badRequest('الرمز يقبل الحروف الإنجليزية والأرقام فقط.');
    const values = {
      code: code?.toUpperCase(),
      name: creating ? requiredText(input, 'name', 120, 'اسم الدوام') : optionalText(input, 'name', 120) ?? undefined,
      startTime: time(input, 'startTime', creating),
      endTime: time(input, 'endTime', creating),
      breakMinutes: optionalNumber(input, 'breakMinutes', { min: 0, max: 480, integer: true }) ?? undefined,
      graceMinutes: optionalNumber(input, 'graceMinutes', { min: 0, max: 240, integer: true }) ?? undefined,
      earlyLeaveGraceMinutes: optionalNumber(input, 'earlyLeaveGraceMinutes', { min: 0, max: 240, integer: true }) ?? undefined,
      workingDays: workingDays as number[] | undefined,
      isDefault: boolField(input, 'isDefault'),
      isActive: boolField(input, 'isActive'),
    };
    if (creating && !values.workingDays) throw badRequest('اختر أيام الدوام.');
    if (values.startTime && values.endTime && values.startTime === values.endTime) {
      throw badRequest('وقت بداية الدوام ونهايته متطابقان.');
    }
    const shiftId = id || randomUUID();
    await transaction(async (tx) => {
      if (values.isDefault) await execute('UPDATE shifts SET is_default = false WHERE is_default AND id <> :id', { id: shiftId }, tx);
      if (creating) {
        await insertRow('shifts', { id: shiftId, ...values }, { id: 'id', ...SHIFT_COLUMNS }, tx);
      } else {
        if (!isUuid(id) || !(await selectOne('SELECT 1 FROM shifts WHERE id = :id', { id }, tx))) throw notFound('الدوام غير موجود.');
        if (values.isActive === false) {
          const used = await selectOne<{ count: number }>(
            `SELECT count(*)::int AS count FROM employees WHERE shift_id = :id AND employment_status <> 'inactive'`, { id }, tx,
          );
          if (used && used.count) throw conflict('انقل موظفي هذا الدوام إلى دوام آخر قبل تعطيله.');
        }
        const { sql, params } = setClause(values, SHIFT_COLUMNS);
        if (!sql) throw badRequest('أرسل حقلاً واحداً على الأقل لتحديثه.');
        await execute(`UPDATE shifts SET ${sql}, updated_at = now() WHERE id = :id`, { ...params, id }, tx);
      }
      await recordAudit(req, tx, creating ? 'shift.created' : 'shift.updated', 'shift', shiftId, values as Record<string, unknown>);
    });
    res.status(creating ? 201 : 200).json({ data: { id: shiftId } });
  }

  /** Assigns one shift to many employees at once. */
  static async assignShift(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['shiftId', 'employeeIds']);
    const shiftId = input.shiftId === null ? null : input.shiftId;
    if (shiftId !== null && (!isUuid(shiftId) || !(await selectOne('SELECT 1 FROM shifts WHERE id = :id AND is_active', { id: shiftId })))) {
      throw badRequest('اختر دواماً نشطاً.');
    }
    const ids = input.employeeIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every(isUuid)) throw badRequest('اختر الموظفين.');
    const scope = employeeScopeSql(req, 'employees');
    const count = await transaction(async (tx) => {
      const updated = await execute<{ id: string }>(
        `UPDATE employees SET shift_id = :shiftId, updated_at = now() WHERE id IN (:ids)${scope.sql} RETURNING id`,
        { shiftId, ids, ...scope.params },
        tx,
      );
      await recordAudit(req, tx, 'shift.assigned', 'shift', shiftId as string | null, { employees: updated.length });
      return updated.length;
    });
    res.json({ data: { updated: count } });
  }

  // --- Devices ------------------------------------------------------------

  static async listDevices(req: Request, res: Response): Promise<void> {
    const branch = branchScope(req);
    const rows = await select(
      `SELECT d.id, d.name, d.serial_no AS "serialNo", d.branch_id AS "branchId", b.name AS "branchName",
              d.ip_allowlist AS "ipAllowlist", d.is_active AS "isActive", d.last_seen_at AS "lastSeenAt",
              to_char(d.last_punch_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS "lastPunchAt"
       FROM attendance_devices d LEFT JOIN branches b ON b.id = d.branch_id
       ${branch ? 'WHERE d.branch_id = :branch' : ''} ORDER BY d.name`,
      { branch },
    );
    res.json({ data: rows });
  }

  static async saveDevice(req: Request, res: Response): Promise<void> {
    const id = req.params.id;
    const creating = !id;
    const input = body(req);
    assertOnlyKeys(input, ['name', 'serialNo', 'branchId', 'ipAllowlist', 'isActive']);
    const serialNo = creating ? requiredText(input, 'serialNo', 60, 'الرقم التسلسلي') : optionalText(input, 'serialNo', 60) ?? undefined;
    if (serialNo && !/^[A-Za-z0-9_-]+$/.test(serialNo)) throw badRequest('الرقم التسلسلي يقبل الحروف الإنجليزية والأرقام فقط.');
    const ipAllowlist = optionalText(input, 'ipAllowlist', 400);
    if (ipAllowlist && !ipAllowlist.split(',').every((item) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(item.trim()))) {
      throw badRequest('قائمة عناوين IP غير صالحة. افصل العناوين بفاصلة.');
    }
    const branchId = input.branchId === undefined ? undefined : (input.branchId || null) as string | null;
    if (branchId && (!isUuid(branchId) || !(await selectOne('SELECT 1 FROM branches WHERE id = :id', { id: branchId })))) {
      throw badRequest('الفرع غير موجود.');
    }
    const values = {
      name: creating ? requiredText(input, 'name', 120, 'اسم الجهاز') : optionalText(input, 'name', 120) ?? undefined,
      serialNo, branchId, ipAllowlist, isActive: boolField(input, 'isActive'),
    };
    const columns = { name: 'name', serialNo: 'serial_no', branchId: 'branch_id', ipAllowlist: 'ip_allowlist', isActive: 'is_active' };
    const deviceId = id || randomUUID();
    await transaction(async (tx) => {
      if (creating) {
        await insertRow('attendance_devices', { id: deviceId, ...values }, { id: 'id', ...columns }, tx);
      } else {
        if (!isUuid(id)) throw notFound('الجهاز غير موجود.');
        const { sql, params } = setClause(values, columns);
        if (!sql) throw badRequest('أرسل حقلاً واحداً على الأقل لتحديثه.');
        await execute(`UPDATE attendance_devices SET ${sql}, updated_at = now() WHERE id = :id`, { ...params, id }, tx);
      }
      await recordAudit(req, tx, creating ? 'attendance_device.created' : 'attendance_device.updated', 'attendance_device', deviceId, values);
    });
    res.status(creating ? 201 : 200).json({ data: { id: deviceId } });
  }

  // --- Punches ------------------------------------------------------------

  static async importFile(req: Request, res: Response): Promise<void> {
    const file = req.file;
    if (!file) throw badRequest('اختر ملف البصمات.');
    const order: DateOrder = body(req).dateOrder === 'mdy' ? 'mdy' : 'dmy';
    const parsed = isXlsx(file.buffer)
      ? await parseExcelPunches(file.buffer, order)
      : parseTextPunches(file.buffer.toString('utf8'), order);
    if (!parsed.punches.length) {
      throw badRequest('لم يُعثر على بصمات صالحة في الملف. تأكد من وجود عمود رقم البصمة وعمود التاريخ والوقت.', {
        invalid: parsed.invalid,
      });
    }
    const result = await ingestPunches(parsed.punches, {
      source: 'file', fileName: uploadedName(file, 'punches'), userId: req.user!.id, invalid: parsed.invalid,
    });
    await recordAudit(req, null, 'attendance.imported', 'attendance_import', result.importId, {
      file: uploadedName(file, 'punches'), imported: result.imported, duplicate: result.duplicate, unmatched: result.unmatched,
    });
    await recomputeAfterIngest(result);
    res.status(201).json({ data: { ...result, format: parsed.format } });
  }

  static async listImports(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT i.id, i.source, i.file_name AS "fileName", d.name AS "deviceName", i.rows_total AS "rowsTotal",
              i.rows_imported AS "rowsImported", i.rows_duplicate AS "rowsDuplicate", i.rows_unmatched AS "rowsUnmatched",
              i.rows_invalid AS "rowsInvalid", i.kind, i.summary, i.created_at AS "createdAt", u.name AS "createdByName"
       FROM attendance_imports i
       LEFT JOIN users u ON u.id = i.created_by
       LEFT JOIN attendance_devices d ON d.id = i.device_id
       WHERE i.source = 'file' OR i.rows_imported > 0
       ORDER BY i.created_at DESC LIMIT 50`,
    );
    res.json({ data: rows });
  }

  static async listPunches(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.query.employeeId);
    const { from, to } = dateRange(req);
    const rows = await select(
      `SELECT p.id, to_char(p.punched_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS "punchedAt", p.source, p.note,
              d.name AS "deviceName", u.name AS "createdByName", p.voided_at AS "voidedAt", p.void_reason AS "voidReason"
       FROM attendance_punches p
       LEFT JOIN attendance_devices d ON d.id = p.device_id
       LEFT JOIN users u ON u.id = p.created_by
       WHERE p.employee_id = :employeeId AND p.punched_at >= :from AND p.punched_at < (:to::date + 1)
       ORDER BY p.punched_at`,
      { employeeId: employee.id, from, to },
    );
    res.json({ data: rows });
  }

  /** Manual punch for a forgotten fingerprint; always needs a reason. */
  static async addPunch(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['employeeId', 'punchedAt', 'note']);
    const employee = await employeeInScope(req, input.employeeId);
    const punchedAt = typeof input.punchedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(input.punchedAt)
      ? (input.punchedAt.length === 16 ? `${input.punchedAt}:00` : input.punchedAt)
      : null;
    if (!punchedAt || !isDateOnly(punchedAt.slice(0, 10))) throw badRequest('أدخل وقت البصمة بصيغة صحيحة.');
    const note = requiredText(input, 'note', 500, 'سبب الإضافة');
    const date = punchedAt.slice(0, 10);
    await assertDaysUnlocked(employee.id, addDays(date, -1), date);
    const pin = employee.attendancePin || employee.employeeNo;
    const id = randomUUID();
    await transaction(async (tx) => {
      const inserted = await execute<{ id: string }>(
        `INSERT INTO attendance_punches (id, employee_id, device_pin, punched_at, source, note, created_by)
         VALUES (:id, :employeeId, :pin, :punchedAt, 'manual', :note, :userId)
         ON CONFLICT (device_pin, punched_at) DO NOTHING RETURNING id`,
        { id, employeeId: employee.id, pin, punchedAt, note, userId: req.user!.id },
        tx,
      );
      if (!inserted.length) throw conflict('توجد بصمة مسجلة في الوقت نفسه.');
      await recordAudit(req, tx, 'attendance.punch_added', 'employee', employee.id, { punchId: id, punchedAt, note });
    });
    await computeAttendance({ from: addDays(date, -1), to: date, employeeIds: [employee.id] });
    res.status(201).json({ data: { id } });
  }

  static async voidPunch(req: Request, res: Response): Promise<void> {
    const punch = await selectOne<{ id: string; employeeId: string | null; date: string; voidedAt: string | null }>(
      `SELECT id, employee_id AS "employeeId", to_char(punched_at, 'YYYY-MM-DD') AS date, voided_at AS "voidedAt"
       FROM attendance_punches WHERE id = :id`,
      { id: req.params.id },
    );
    if (!punch || !punch.employeeId) throw notFound('البصمة غير موجودة.');
    await employeeInScope(req, punch.employeeId);
    if (punch.voidedAt) throw conflict('البصمة ملغاة مسبقاً.');
    const reason = requiredText(body(req), 'reason', 500, 'سبب الإلغاء');
    await assertDaysUnlocked(punch.employeeId, addDays(punch.date, -1), punch.date);
    await transaction(async (tx) => {
      await execute('UPDATE attendance_punches SET voided_at = now(), voided_by = :userId, void_reason = :reason WHERE id = :id',
        { id: punch.id, userId: req.user!.id, reason }, tx);
      await recordAudit(req, tx, 'attendance.punch_voided', 'employee', punch.employeeId, { punchId: punch.id, reason });
    });
    await computeAttendance({ from: addDays(punch.date, -1), to: punch.date, employeeIds: [punch.employeeId] });
    res.json({ data: { id: punch.id } });
  }

  /** Device PINs that did not match any employee. */
  static async unmatched(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT device_pin AS pin, count(*)::int AS punches,
              to_char(min(punched_at), 'YYYY-MM-DD') AS "firstSeen", to_char(max(punched_at), 'YYYY-MM-DD') AS "lastSeen"
       FROM attendance_punches WHERE employee_id IS NULL AND voided_at IS NULL
       GROUP BY device_pin ORDER BY count(*) DESC LIMIT 500`,
    );
    res.json({ data: rows });
  }

  /** Links an unmatched device PIN to an employee and attaches its punches. */
  static async assignPin(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['pin', 'employeeId']);
    const pin = requiredText(input, 'pin', 40, 'رقم البصمة');
    const employee = await employeeInScope(req, input.employeeId);
    const owner = await selectOne<{ id: string }>('SELECT id FROM employees WHERE attendance_pin = :pin', { pin });
    if (owner && owner.id !== employee.id) throw conflict('رقم البصمة مسند لموظف آخر.');
    const range = await transaction(async (tx) => {
      await execute('UPDATE employees SET attendance_pin = :pin, updated_at = now() WHERE id = :id', { pin, id: employee.id }, tx);
      const [dates] = await execute<{ from: string | null; to: string | null }>(
        `WITH linked AS (
           UPDATE attendance_punches SET employee_id = :id WHERE device_pin = :pin AND employee_id IS NULL RETURNING punched_at
         ) SELECT to_char(min(punched_at), 'YYYY-MM-DD') AS "from", to_char(max(punched_at), 'YYYY-MM-DD') AS "to" FROM linked`,
        { pin, id: employee.id },
        tx,
      );
      await recordAudit(req, tx, 'attendance.pin_assigned', 'employee', employee.id, { pin });
      return dates;
    });
    if (range?.from && range.to) {
      await computeAttendance({ from: addDays(range.from, -1), to: range.to, employeeIds: [employee.id] });
    }
    res.json({ data: { employeeId: employee.id, pin } });
  }

  // --- Days ---------------------------------------------------------------

  static async compute(req: Request, res: Response): Promise<void> {
    const { from, to } = dateRange(req);
    const input = body(req);
    const employeeId = input.employeeId ? (await employeeInScope(req, input.employeeId)).id : undefined;
    const requestedBranch = typeof input.branchId === 'string' && isUuid(input.branchId) ? input.branchId : null;
    const branchId = branchScope(req) ?? requestedBranch;
    const result = await computeAttendance({ from, to, employeeIds: employeeId ? [employeeId] : undefined, branchId });
    await recordAudit(req, null, 'attendance.computed', 'attendance', null, { from, to, ...result });
    res.json({ data: result });
  }

  static async listDays(req: Request, res: Response): Promise<void> {
    const { from, to } = dateRange(req);
    const scope = employeeScopeSql(req);
    const filters: string[] = [];
    const params: Record<string, unknown> = { from, to, ...scope.params };
    const employeeId = queryText(req, 'employeeId');
    if (employeeId) {
      if (!isUuid(employeeId)) throw badRequest('معرّف الموظف غير صالح.');
      filters.push('d.employee_id = :employeeId');
      params.employeeId = employeeId;
    }
    const branchId = queryText(req, 'branchId');
    if (branchId && isUuid(branchId)) {
      filters.push('e.branch_id = :branchId');
      params.branchId = branchId;
    }
    const status = queryText(req, 'status');
    if (status) {
      filters.push('COALESCE(d.override_status, d.status) = :status');
      params.status = status;
    }
    const rows = await select(
      `SELECT d.employee_id AS "employeeId", e.full_name AS "employeeName", e.employee_no AS "employeeNo",
              to_char(d.work_date, 'YYYY-MM-DD') AS "workDate", s.name AS "shiftName",
              to_char(d.first_in, 'HH24:MI') AS "firstIn", to_char(d.last_out, 'HH24:MI') AS "lastOut",
              d.punch_count AS "punchCount", d.worked_minutes AS "workedMinutes", d.excused_minutes AS "excusedMinutes",
              ${EFFECTIVE_DAY_COLUMNS},
              d.status AS "computedStatus", d.leave_type_name AS "leaveTypeName", d.task_title AS "taskTitle",
              d.override_reason AS "overrideReason", d.override_status IS NOT NULL OR d.override_late_minutes IS NOT NULL
                OR d.override_overtime_minutes IS NOT NULL AS "overridden",
              d.payroll_run_id IS NOT NULL AS "locked"
       FROM attendance_days d
       JOIN employees e ON e.id = d.employee_id
       LEFT JOIN shifts s ON s.id = d.shift_id
       WHERE d.work_date BETWEEN :from AND :to${scope.sql}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}
       ORDER BY d.work_date DESC, e.full_name
       LIMIT 5000`,
      params,
    );
    res.json({ data: rows });
  }

  /** Per-employee totals for a period — the attendance basis of payroll. */
  static async summary(req: Request, res: Response): Promise<void> {
    const { from, to } = dateRange(req);
    const scope = employeeScopeSql(req);
    const branchId = queryText(req, 'branchId');
    const rows = await select(
      `SELECT e.id AS "employeeId", e.full_name AS "employeeName", e.employee_no AS "employeeNo", b.name AS "branchName",
              count(*) FILTER (WHERE x.status = 'present')::int AS "present",
              count(*) FILTER (WHERE x.status = 'absent')::int AS "absent",
              count(*) FILTER (WHERE x.status = 'leave')::int AS "leave",
              count(*) FILTER (WHERE x.status = 'unpaid_leave')::int AS "unpaidLeave",
              count(*) FILTER (WHERE x.status = 'incomplete')::int AS "incomplete",
              COALESCE(sum(x."lateMinutes"), 0)::int AS "lateMinutes",
              COALESCE(sum(x."earlyLeaveMinutes"), 0)::int AS "earlyLeaveMinutes",
              COALESCE(sum(x."overtimeMinutes"), 0)::int AS "overtimeMinutes"
       FROM employees e
       JOIN branches b ON b.id = e.branch_id
       JOIN LATERAL (
         SELECT ${EFFECTIVE_DAY_COLUMNS} FROM attendance_days d
         WHERE d.employee_id = e.id AND d.work_date BETWEEN :from AND :to
       ) x ON true
       WHERE true${scope.sql}${branchId && isUuid(branchId) ? ' AND e.branch_id = :branchId' : ''}
       GROUP BY e.id, b.name
       ORDER BY e.full_name`,
      { from, to, branchId, ...scope.params },
    );
    res.json({ data: rows });
  }

  /** Corrects a day by hand; the computed values stay visible beside the override. */
  static async overrideDay(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.employeeId);
    const date = req.params.date;
    if (!isDateOnly(date)) throw badRequest('التاريخ غير صالح.');
    const input = body(req);
    assertOnlyKeys(input, ['status', 'lateMinutes', 'overtimeMinutes', 'reason', 'clear']);
    const day = await selectOne<{ locked: boolean }>(
      'SELECT payroll_run_id IS NOT NULL AS locked FROM attendance_days WHERE employee_id = :id AND work_date = :date',
      { id: employee.id, date },
    );
    if (!day) throw notFound('لا يوجد سجل حضور لهذا اليوم. احسب الحضور أولاً.');
    if (day.locked) throw conflict('اليوم مقفل ضمن مسير رواتب معتمد.');
    if (input.clear === true) {
      await transaction(async (tx) => {
        await execute(
          `UPDATE attendance_days SET override_status = NULL, override_late_minutes = NULL, override_overtime_minutes = NULL,
             override_reason = NULL, overridden_by = NULL, overridden_at = NULL WHERE employee_id = :id AND work_date = :date`,
          { id: employee.id, date }, tx,
        );
        await recordAudit(req, tx, 'attendance.override_cleared', 'employee', employee.id, { date });
      });
      res.json({ data: { cleared: true } });
      return;
    }
    const status = input.status === undefined || input.status === null ? null : String(input.status);
    if (status && !['present', 'absent', 'leave', 'unpaid_leave', 'holiday', 'weekend'].includes(status)) {
      throw badRequest('الحالة غير صالحة.');
    }
    const lateMinutes = optionalNumber(input, 'lateMinutes', { min: 0, max: 1440, integer: true }) ?? null;
    const overtimeMinutes = optionalNumber(input, 'overtimeMinutes', { min: 0, max: 1440, integer: true }) ?? null;
    if (status === null && lateMinutes === null && overtimeMinutes === null) throw badRequest('حدد التعديل المطلوب.');
    const reason = requiredText(input, 'reason', 500, 'سبب التعديل');
    await transaction(async (tx) => {
      await execute(
        `UPDATE attendance_days SET override_status = :status, override_late_minutes = :lateMinutes,
           override_overtime_minutes = :overtimeMinutes, override_reason = :reason, overridden_by = :userId, overridden_at = now()
         WHERE employee_id = :id AND work_date = :date`,
        { id: employee.id, date, status, lateMinutes, overtimeMinutes, reason, userId: req.user!.id }, tx,
      );
      await recordAudit(req, tx, 'attendance.day_overridden', 'employee', employee.id, { date, status, lateMinutes, overtimeMinutes, reason });
    });
    res.json({ data: { employeeId: employee.id, date } });
  }

  /** Live board for today. */
  static async today(req: Request, res: Response): Promise<void> {
    const settings = await getSettings();
    const today = localToday(settings.company.timeZone);
    const scope = employeeScopeSql(req);
    await computeAttendance({ from: today, to: today, branchId: branchScope(req) });
    const rows = await select<{ status: string; lateMinutes: number; firstIn: string | null }>(
      `SELECT e.id AS "employeeId", e.full_name AS "employeeName", e.employee_no AS "employeeNo", b.name AS "branchName",
              to_char(d.first_in, 'HH24:MI') AS "firstIn", to_char(d.last_out, 'HH24:MI') AS "lastOut",
              ${EFFECTIVE_DAY_COLUMNS}, d.leave_type_name AS "leaveTypeName", d.task_title AS "taskTitle"
       FROM attendance_days d JOIN employees e ON e.id = d.employee_id JOIN branches b ON b.id = e.branch_id
       WHERE d.work_date = :today${scope.sql}
       ORDER BY e.full_name`,
      { today, ...scope.params },
    );
    const count = (predicate: (row: (typeof rows)[number]) => boolean) => rows.filter(predicate).length;
    res.json({
      data: {
        date: today,
        totals: {
          tracked: rows.length,
          inside: count((row) => row.status === 'present' || (row.status === 'incomplete' && Boolean(row.firstIn))),
          late: count((row) => row.lateMinutes > 0),
          onLeave: count((row) => row.status === 'leave' || row.status === 'unpaid_leave'),
          notArrived: count((row) => row.status === 'incomplete' && !row.firstIn),
        },
        rows,
      },
    });
  }
}

export default AttendanceController;
