import type { SystemSettings } from '../config/systemSettings';

/** Working days between two dates (both included), by the company's week and official holidays. */
export function workingDayCount(start: string, end: string, settings: SystemSettings): number {
  const workingDays = new Set(settings.leaveRules.workingDays);
  const holidays = new Set(settings.leaveRules.officialHolidays);
  let total = 0;
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= last) {
    const date = cursor.toISOString().slice(0, 10);
    if (workingDays.has(cursor.getUTCDay()) && !holidays.has(date)) total += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return total;
}

export function calendarDayCount(start: string, end: string): number {
  return Math.floor((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86400000) + 1;
}

/** How much of the balance a leave of this type uses: days (working or calendar) or hours. */
export function leaveQuantity(
  type: SystemSettings['leaveTypes'][number], startsOn: string, endsOn: string, settings: SystemSettings,
  times?: { start: string; end: string } | null,
): number {
  if (type.unit === 'hours') {
    if (!times) return 0;
    const [sh, sm] = times.start.split(':').map(Number);
    const [eh, em] = times.end.split(':').map(Number);
    return Math.max(0, (eh * 60 + em - sh * 60 - sm) / 60);
  }
  return type.dayCountBasis === 'calendar' ? calendarDayCount(startsOn, endsOn) : workingDayCount(startsOn, endsOn, settings);
}
