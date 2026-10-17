import { randomUUID } from 'node:crypto';
import { Transaction } from 'sequelize';
import { execute, select } from '../db/query';
import { getSettings } from './settings';
import {
  addDays, computeDay, DayLeave, DayResult, DayTask, eachDate, punchWindow, ShiftRule, toMinutes,
} from './attendanceRules';

export function localToday(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date());
  }
}

interface EmployeeRow {
  id: string;
  hireDate: string;
  terminationDate: string | null;
  shiftId: string;
}

interface ShiftRow extends ShiftRule {
  code: string;
}

export async function loadShifts(transaction?: Transaction): Promise<Map<string, ShiftRow>> {
  const rows = await select<ShiftRow>(
    `SELECT id, code, to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime",
            break_minutes AS "breakMinutes", grace_minutes AS "graceMinutes",
            early_leave_grace_minutes AS "earlyLeaveGraceMinutes", working_days::int[] AS "workingDays"
     FROM shifts`,
    {},
    transaction,
  );
  return new Map(rows.map((row) => [row.id, row]));
}

export interface ComputeScope {
  from: string;
  to: string;
  employeeIds?: string[];
  branchId?: string | null;
}

/**
 * Recomputes attendance days for employees that have a shift. Days already
 * locked by an approved payroll run are left untouched, as are manual
 * overrides (they are stored in separate columns and applied on read).
 * Employees without a shift are not attendance-tracked.
 */
export async function computeAttendance(scope: ComputeScope, transaction?: Transaction): Promise<{ employees: number; days: number }> {
  const settings = await getSettings();
  const today = localToday(settings.company.timeZone);
  const to = scope.to > today ? today : scope.to;
  if (scope.from > to) return { employees: 0, days: 0 };

  const filters: string[] = [];
  const params: Record<string, unknown> = { from: scope.from, to };
  if (scope.employeeIds?.length) {
    filters.push('e.id IN (:employeeIds)');
    params.employeeIds = scope.employeeIds;
  }
  if (scope.branchId) {
    filters.push('e.branch_id = :branchId');
    params.branchId = scope.branchId;
  }
  const employees = await select<EmployeeRow>(
    `SELECT e.id, to_char(e.hire_date, 'YYYY-MM-DD') AS "hireDate",
            to_char(e.termination_date, 'YYYY-MM-DD') AS "terminationDate", e.shift_id AS "shiftId"
     FROM employees e
     WHERE e.shift_id IS NOT NULL AND e.hire_date <= :to
       AND (e.termination_date IS NULL OR e.termination_date >= :from)
       ${filters.length ? `AND ${filters.join(' AND ')}` : ''}`,
    params,
    transaction,
  );
  if (!employees.length) return { employees: 0, days: 0 };
  const ids = employees.map((item) => item.id);
  const shifts = await loadShifts(transaction);

  const punches = await select<{ employeeId: string; at: string }>(
    `SELECT employee_id AS "employeeId", to_char(punched_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS at
     FROM attendance_punches
     WHERE employee_id IN (:ids) AND voided_at IS NULL
       AND punched_at >= (:from::date - 1) AND punched_at < (:to::date + 2)
     ORDER BY punched_at`,
    { ids, from: scope.from, to },
    transaction,
  );
  const punchesByEmployee = new Map<string, string[]>();
  for (const punch of punches) {
    const list = punchesByEmployee.get(punch.employeeId) ?? [];
    list.push(punch.at);
    punchesByEmployee.set(punch.employeeId, list);
  }

  const leaveTypes = new Map(settings.leaveTypes.map((type) => [type.id, type]));
  const leaves = await select<{
    id: string; employeeId: string; leaveTypeId: string; startsOn: string; endsOn: string;
    startTime: string | null; endTime: string | null;
  }>(
    `SELECT id, employee_id AS "employeeId", leave_type_id AS "leaveTypeId",
            to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn",
            to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime"
     FROM leave_requests
     WHERE employee_id IN (:ids) AND status = 'approved' AND starts_on <= :to AND ends_on >= :from`,
    { ids, from: scope.from, to },
    transaction,
  );
  const tasks = await select<{ employeeId: string; date: string; startTime: string | null; endTime: string | null; title: string }>(
    `SELECT employee_id AS "employeeId", to_char(work_date, 'YYYY-MM-DD') AS date,
            to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime", title
     FROM attendance_tasks
     WHERE employee_id IN (:ids) AND voided_at IS NULL AND work_date BETWEEN :from AND :to
     ORDER BY work_date, start_time NULLS FIRST`,
    { ids, from: scope.from, to },
    transaction,
  );
  const tasksByDay = new Map<string, DayTask[]>();
  for (const task of tasks) {
    const key = `${task.employeeId}|${task.date}`;
    tasksByDay.set(key, [...(tasksByDay.get(key) ?? []), { title: task.title, startTime: task.startTime, endTime: task.endTime }]);
  }
  const holidays = new Set(settings.leaveRules.officialHolidays);
  const rules = settings.attendanceRules;

  const rows: Array<DayResult & { employeeId: string }> = [];
  for (const employee of employees) {
    const shift = shifts.get(employee.shiftId);
    if (!shift) continue;
    const own = (punchesByEmployee.get(employee.id) ?? []).map((at) => ({ at, minutes: toMinutes(at) }));
    const ownLeaves = leaves.filter((leave) => leave.employeeId === employee.id);
    for (const date of eachDate(scope.from, to)) {
      const window = punchWindow(date, shift);
      const dayPunches = own.filter((item) => item.minutes >= window.from && item.minutes <= window.to).map((item) => item.at);
      const request = ownLeaves.find((leave) => leave.startsOn <= date && leave.endsOn >= date);
      const leaveType = request ? leaveTypes.get(request.leaveTypeId) : undefined;
      const leave: DayLeave | null = request ? {
        requestId: request.id,
        typeName: leaveType?.name ?? 'إجازة',
        paid: leaveType?.paid ?? true,
        fullDay: !request.startTime,
        startTime: request.startTime,
        endTime: request.endTime,
      } : null;
      const result = computeDay({
        date,
        shift,
        punches: dayPunches,
        leave,
        tasks: tasksByDay.get(`${employee.id}|${date}`) ?? [],
        isHoliday: holidays.has(date),
        employed: date >= employee.hireDate && (!employee.terminationDate || date <= employee.terminationDate),
        isPast: date < today,
        overtimeMinimumMinutes: rules.overtimeMinimumMinutes,
        duplicatePunchWindowMinutes: rules.duplicatePunchWindowMinutes,
        markAbsentWithoutPunch: rules.markAbsentWithoutPunch,
      });
      rows.push({ ...result, employeeId: employee.id });
    }
  }

  for (let index = 0; index < rows.length; index += 1000) {
    const batch = rows.slice(index, index + 1000);
    await execute(
      `INSERT INTO attendance_days (employee_id, work_date, shift_id, scheduled_minutes, first_in, last_out, punch_count,
         worked_minutes, late_minutes, early_leave_minutes, overtime_minutes, excused_minutes, status,
         leave_request_id, leave_type_name, task_title, computed_at)
       SELECT x."employeeId", x."workDate", x."shiftId", x."scheduledMinutes", x."firstIn", x."lastOut", x."punchCount",
              x."workedMinutes", x."lateMinutes", x."earlyLeaveMinutes", x."overtimeMinutes", x."excusedMinutes", x.status,
              x."leaveRequestId", x."leaveTypeName", x."taskTitle", now()
       FROM jsonb_to_recordset(:rows::jsonb) AS x(
         "employeeId" uuid, "workDate" date, "shiftId" uuid, "scheduledMinutes" int, "firstIn" timestamp, "lastOut" timestamp,
         "punchCount" int, "workedMinutes" int, "lateMinutes" int, "earlyLeaveMinutes" int, "overtimeMinutes" int,
         "excusedMinutes" int, status varchar, "leaveRequestId" uuid, "leaveTypeName" varchar, "taskTitle" varchar)
       ON CONFLICT (employee_id, work_date) DO UPDATE SET
         shift_id = EXCLUDED.shift_id, scheduled_minutes = EXCLUDED.scheduled_minutes, first_in = EXCLUDED.first_in,
         last_out = EXCLUDED.last_out, punch_count = EXCLUDED.punch_count, worked_minutes = EXCLUDED.worked_minutes,
         late_minutes = EXCLUDED.late_minutes, early_leave_minutes = EXCLUDED.early_leave_minutes,
         overtime_minutes = EXCLUDED.overtime_minutes, excused_minutes = EXCLUDED.excused_minutes, status = EXCLUDED.status,
         leave_request_id = EXCLUDED.leave_request_id, leave_type_name = EXCLUDED.leave_type_name,
         task_title = EXCLUDED.task_title, computed_at = now()
       WHERE attendance_days.payroll_run_id IS NULL`,
      { rows: JSON.stringify(batch) },
      transaction,
    );
  }
  return { employees: employees.length, days: rows.length };
}

/** SQL for a day's effective values after manual overrides. */
export const EFFECTIVE_DAY_COLUMNS = `
  COALESCE(d.override_status, d.status) AS "status",
  COALESCE(d.override_late_minutes, d.late_minutes) AS "lateMinutes",
  d.early_leave_minutes AS "earlyLeaveMinutes",
  COALESCE(d.override_overtime_minutes, d.overtime_minutes) AS "overtimeMinutes"`;

// ---------------------------------------------------------------------------
// Punch ingestion
// ---------------------------------------------------------------------------

export interface RawPunch {
  pin: string;
  at: string; // YYYY-MM-DDTHH:MM:SS local
}

export interface IngestResult {
  importId: string;
  total: number;
  imported: number;
  duplicate: number;
  unmatched: number;
  invalid: number;
  from: string | null;
  to: string | null;
}

/**
 * Stores punches, matching each device PIN to an employee by fingerprint PIN
 * first and employee number second. Repeated uploads of the same export are
 * harmless: a PIN can punch only once per second.
 */
export async function ingestPunches(
  punches: RawPunch[],
  meta: { source: 'file' | 'device'; fileName?: string | null; deviceId?: string | null; userId?: string | null; invalid?: number },
): Promise<IngestResult> {
  const importId = randomUUID();
  const pins = [...new Set(punches.map((item) => item.pin))];
  const matches = pins.length ? await select<{ pin: string; id: string }>(
    `SELECT DISTINCT ON (pin) pin, id FROM (
       SELECT attendance_pin AS pin, id, 1 AS rank FROM employees WHERE attendance_pin IN (:pins)
       UNION ALL
       SELECT employee_no AS pin, id, 2 AS rank FROM employees WHERE employee_no IN (:pins)
     ) candidates ORDER BY pin, rank`,
    { pins },
  ) : [];
  const employeeByPin = new Map(matches.map((item) => [item.pin, item.id]));

  await execute(
    `INSERT INTO attendance_imports (id, source, file_name, device_id, rows_total, rows_invalid, created_by)
     VALUES (:id, :source, :fileName, :deviceId, :total, :invalid, :userId)`,
    {
      id: importId, source: meta.source, fileName: meta.fileName ?? null, deviceId: meta.deviceId ?? null,
      total: punches.length + (meta.invalid ?? 0), invalid: meta.invalid ?? 0, userId: meta.userId ?? null,
    },
  );

  let imported = 0;
  let unmatched = 0;
  const source = meta.source === 'device' ? 'device' : 'import';
  for (let index = 0; index < punches.length; index += 1000) {
    const batch = punches.slice(index, index + 1000).map((item) => ({
      id: randomUUID(), pin: item.pin, at: item.at, employeeId: employeeByPin.get(item.pin) ?? null,
    }));
    const inserted = await execute<{ employeeId: string | null }>(
      `INSERT INTO attendance_punches (id, employee_id, device_pin, punched_at, source, device_id, import_id)
       SELECT x.id, x."employeeId", x.pin, x.at, :source, :deviceId, :importId
       FROM jsonb_to_recordset(:rows::jsonb) AS x(id uuid, "employeeId" uuid, pin varchar, at timestamp)
       ON CONFLICT (device_pin, punched_at) DO NOTHING
       RETURNING employee_id AS "employeeId"`,
      { rows: JSON.stringify(batch), source, deviceId: meta.deviceId ?? null, importId },
    );
    imported += inserted.length;
    unmatched += inserted.filter((item) => !item.employeeId).length;
  }
  const duplicate = punches.length - imported;
  await execute(
    `UPDATE attendance_imports SET rows_imported = :imported, rows_duplicate = :duplicate, rows_unmatched = :unmatched
     WHERE id = :id`,
    { id: importId, imported, duplicate, unmatched },
  );
  const dates = punches.map((item) => item.at.slice(0, 10)).sort();
  return {
    importId, total: punches.length + (meta.invalid ?? 0), imported, duplicate, unmatched, invalid: meta.invalid ?? 0,
    from: dates[0] ?? null, to: dates[dates.length - 1] ?? null,
  };
}

/** Recomputes the days touched by newly stored punches (one day of margin for night shifts). */
export async function recomputeAfterIngest(result: IngestResult): Promise<void> {
  if (!result.imported || !result.from || !result.to) return;
  const employees = await select<{ id: string }>(
    'SELECT DISTINCT employee_id AS id FROM attendance_punches WHERE import_id = :id AND employee_id IS NOT NULL',
    { id: result.importId },
  );
  if (!employees.length) return;
  await computeAttendance({
    from: addDays(result.from, -1),
    to: result.to,
    employeeIds: employees.map((item) => item.id),
  });
}
