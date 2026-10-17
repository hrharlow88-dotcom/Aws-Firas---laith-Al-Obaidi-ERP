/**
 * Pure attendance arithmetic, kept free of database access so every rule can
 * be unit-tested. Times are local wall-clock strings "YYYY-MM-DDTHH:MM:SS";
 * they are compared as minute counts, which is exact in a time zone without
 * daylight-saving changes (Asia/Baghdad).
 */

export type DayStatus =
  | 'present' | 'absent' | 'leave' | 'unpaid_leave' | 'holiday' | 'weekend' | 'incomplete' | 'not_employed';

export interface ShiftRule {
  id: string;
  startTime: string; // HH:MM or HH:MM:SS
  endTime: string;
  breakMinutes: number;
  graceMinutes: number;
  earlyLeaveGraceMinutes: number;
  workingDays: number[]; // 0 = Sunday … 6 = Saturday
}

export interface DayLeave {
  requestId: string;
  typeName: string;
  paid: boolean;
  /** Whole-day leave, or a window of excused time on this day. */
  fullDay: boolean;
  startTime?: string | null;
  endTime?: string | null;
}

/**
 * External work from the fingerprint app's tasks export: the whole day, or a
 * window of time away from the device (both times), or just a note on a
 * punch made with the app (start time only).
 */
export interface DayTask {
  title: string;
  startTime: string | null;
  endTime: string | null;
}

export interface DayInput {
  date: string; // YYYY-MM-DD
  shift: ShiftRule;
  punches: string[];
  leave: DayLeave | null;
  tasks?: DayTask[];
  isHoliday: boolean;
  employed: boolean;
  isPast: boolean;
  overtimeMinimumMinutes: number;
  duplicatePunchWindowMinutes: number;
  markAbsentWithoutPunch: boolean;
}

export interface DayResult {
  workDate: string;
  shiftId: string;
  scheduledMinutes: number;
  firstIn: string | null;
  lastOut: string | null;
  punchCount: number;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  excusedMinutes: number;
  status: DayStatus;
  leaveRequestId: string | null;
  leaveTypeName: string | null;
  taskTitle: string | null;
}

const MINUTE = 60000;

export function toMinutes(localDateTime: string): number {
  return Math.floor(Date.parse(`${localDateTime.slice(0, 19)}Z`) / MINUTE);
}

export function fromMinutes(minutes: number): string {
  return new Date(minutes * MINUTE).toISOString().slice(0, 19);
}

function clock(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function eachDate(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) dates.push(cursor);
  return dates;
}

/** Shift start and end on a date, as minute counts; night shifts end the next day. */
export function shiftBounds(date: string, shift: ShiftRule): { start: number; end: number } {
  const midnight = toMinutes(`${date}T00:00:00`);
  const start = midnight + clock(shift.startTime);
  let end = midnight + clock(shift.endTime);
  if (end <= start) end += 24 * 60;
  return { start, end };
}

/** Punches that belong to a shift on `date`: from 4 hours before start to 8 hours after end. */
export function punchWindow(date: string, shift: ShiftRule): { from: number; to: number } {
  const { start, end } = shiftBounds(date, shift);
  return { from: start - 4 * 60, to: end + 8 * 60 };
}

export function scheduledMinutes(shift: ShiftRule): number {
  const { start, end } = shiftBounds('2000-01-03', shift);
  return Math.max(0, end - start - shift.breakMinutes);
}

/** Collapses repeated taps within the window into the first one. */
export function dedupePunches(punches: number[], windowMinutes: number): number[] {
  const sorted = [...punches].sort((a, b) => a - b);
  const kept: number[] = [];
  for (const punch of sorted) {
    if (!kept.length || punch - kept[kept.length - 1] > windowMinutes) kept.push(punch);
  }
  return kept;
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Minutes of [start, end] covered by any of the windows, each minute counted once. */
function covered(start: number, end: number, windows: Array<[number, number]>): number {
  const sorted = windows.map(([from, to]) => [Math.max(from, start), Math.min(to, end)] as [number, number])
    .filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = start;
  for (const [from, to] of sorted) {
    const begin = Math.max(from, cursor);
    if (to > begin) { total += to - begin; cursor = to; }
  }
  return total;
}

export function computeDay(input: DayInput): DayResult {
  const { shift, date } = input;
  const tasks = input.tasks ?? [];
  const scheduled = scheduledMinutes(shift);
  const isWorkingDay = shift.workingDays.includes(weekday(date));
  const punches = dedupePunches(input.punches.map(toMinutes), input.duplicatePunchWindowMinutes);
  const base: DayResult = {
    workDate: date,
    shiftId: shift.id,
    scheduledMinutes: 0,
    firstIn: punches.length ? fromMinutes(punches[0]) : null,
    lastOut: punches.length > 1 ? fromMinutes(punches[punches.length - 1]) : null,
    punchCount: punches.length,
    workedMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
    excusedMinutes: 0,
    status: 'present',
    leaveRequestId: input.leave?.requestId ?? null,
    leaveTypeName: input.leave?.typeName ?? null,
    taskTitle: tasks.length ? [...new Set(tasks.map((task) => task.title))].join('، ').slice(0, 200) : null,
  };

  if (!input.employed) return { ...base, status: 'not_employed', leaveRequestId: null, leaveTypeName: null, taskTitle: null };

  const worked = punches.length > 1
    ? Math.max(0, punches[punches.length - 1] - punches[0] - shift.breakMinutes)
    : 0;

  // Work on a rest day or public holiday counts entirely as overtime.
  if (input.isHoliday || !isWorkingDay) {
    const status: DayStatus = input.isHoliday ? 'holiday' : 'weekend';
    const overtime = worked >= input.overtimeMinimumMinutes ? worked : 0;
    return { ...base, status, workedMinutes: worked, overtimeMinutes: overtime, leaveRequestId: null, leaveTypeName: null };
  }

  if (input.leave?.fullDay) {
    return { ...base, status: input.leave.paid ? 'leave' : 'unpaid_leave', workedMinutes: worked };
  }

  const { start, end } = shiftBounds(date, shift);
  const midnight = toMinutes(`${date}T00:00:00`);
  // Approved hourly leave and external-work windows excuse the time they cover.
  const windows: Array<[number, number]> = [];
  if (input.leave && input.leave.startTime && input.leave.endTime) {
    windows.push([midnight + clock(input.leave.startTime), midnight + clock(input.leave.endTime)]);
  }
  for (const task of tasks) {
    if (task.startTime && task.endTime) {
      const from = midnight + clock(task.startTime);
      let to = midnight + clock(task.endTime);
      if (to <= from) to += 24 * 60;
      windows.push([from, to]);
    }
  }
  const excused = windows.length ? covered(start, end, windows) : 0;

  // A whole day of external work (or windows covering the whole shift) counts as present.
  if (tasks.some((task) => !task.startTime && !task.endTime) || (excused && excused >= end - start)) {
    const lastOut = punches.length > 1 ? punches[punches.length - 1] : null;
    const after = lastOut === null ? 0 : lastOut - end;
    return {
      ...base,
      scheduledMinutes: scheduled,
      workedMinutes: Math.max(worked, scheduled),
      excusedMinutes: scheduled,
      overtimeMinutes: after >= input.overtimeMinimumMinutes ? after : 0,
      status: 'present',
    };
  }

  if (!punches.length) {
    if (!input.isPast) return { ...base, scheduledMinutes: scheduled, status: 'incomplete', excusedMinutes: excused };
    return {
      ...base,
      scheduledMinutes: scheduled,
      excusedMinutes: excused,
      status: input.markAbsentWithoutPunch ? 'absent' : 'incomplete',
    };
  }

  const firstIn = punches[0];
  // Lateness counts from the shift start once the grace period is exceeded.
  let late = firstIn > start + shift.graceMinutes ? firstIn - start : 0;
  let early = 0;
  let overtime = 0;
  if (punches.length > 1) {
    const lastOut = punches[punches.length - 1];
    early = lastOut < end - shift.earlyLeaveGraceMinutes ? end - lastOut : 0;
    const after = lastOut - end;
    overtime = after >= input.overtimeMinimumMinutes ? after : 0;
  } else if (firstIn > start + (end - start) / 2) {
    // A single punch late in the shift is an exit without an entry, not a late arrival.
    late = 0;
  }

  // Approved hourly leave excuses lateness first, then early departure.
  let remaining = excused;
  const lateCovered = Math.min(late, remaining);
  late -= lateCovered;
  remaining -= lateCovered;
  early -= Math.min(early, remaining);

  return {
    ...base,
    scheduledMinutes: scheduled,
    workedMinutes: worked,
    lateMinutes: late,
    earlyLeaveMinutes: early,
    overtimeMinutes: overtime,
    excusedMinutes: excused,
    status: punches.length > 1 ? 'present' : 'incomplete',
  };
}
