import { describe, expect, it } from 'vitest';
import { computeDay, dedupePunches, DayInput, scheduledMinutes, ShiftRule, toMinutes } from '../src/services/attendanceRules';

// 2026-10-04 is a Sunday; Friday 2026-10-09 is the weekly rest day here.
const dayShift: ShiftRule = {
  id: 'day', startTime: '08:00', endTime: '16:00', breakMinutes: 30,
  graceMinutes: 10, earlyLeaveGraceMinutes: 5, workingDays: [0, 1, 2, 3, 4, 6],
};
const nightShift: ShiftRule = { ...dayShift, id: 'night', startTime: '22:00', endTime: '06:00' };

function day(overrides: Partial<DayInput>): DayInput {
  return {
    date: '2026-10-04', shift: dayShift, punches: [], leave: null, isHoliday: false, employed: true, isPast: true,
    overtimeMinimumMinutes: 30, duplicatePunchWindowMinutes: 2, markAbsentWithoutPunch: true, ...overrides,
  };
}

describe('attendance rules', () => {
  it('computes a normal day', () => {
    const result = computeDay(day({ punches: ['2026-10-04T07:55:00', '2026-10-04T16:02:00'] }));
    expect(result).toMatchObject({ status: 'present', lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, workedMinutes: 457 });
    expect(scheduledMinutes(dayShift)).toBe(450);
  });

  it('forgives lateness inside the grace period and counts all of it beyond', () => {
    expect(computeDay(day({ punches: ['2026-10-04T08:10:00', '2026-10-04T16:00:00'] })).lateMinutes).toBe(0);
    expect(computeDay(day({ punches: ['2026-10-04T08:11:00', '2026-10-04T16:00:00'] })).lateMinutes).toBe(11);
  });

  it('counts early departure and overtime only past their thresholds', () => {
    expect(computeDay(day({ punches: ['2026-10-04T08:00:00', '2026-10-04T15:40:00'] })).earlyLeaveMinutes).toBe(20);
    expect(computeDay(day({ punches: ['2026-10-04T08:00:00', '2026-10-04T16:20:00'] })).overtimeMinutes).toBe(0);
    expect(computeDay(day({ punches: ['2026-10-04T08:00:00', '2026-10-04T17:15:00'] })).overtimeMinutes).toBe(75);
  });

  it('marks absence only for past working days', () => {
    expect(computeDay(day({})).status).toBe('absent');
    expect(computeDay(day({ isPast: false })).status).toBe('incomplete');
    expect(computeDay(day({ markAbsentWithoutPunch: false })).status).toBe('incomplete');
  });

  it('treats the weekly rest day and holidays as overtime when worked', () => {
    const friday = computeDay(day({ date: '2026-10-09', punches: ['2026-10-09T09:00:00', '2026-10-09T13:30:00'] }));
    expect(friday).toMatchObject({ status: 'weekend', overtimeMinutes: 240, lateMinutes: 0 });
    expect(computeDay(day({ date: '2026-10-09' })).status).toBe('weekend');
    expect(computeDay(day({ isHoliday: true })).status).toBe('holiday');
  });

  it('applies full-day leave by paid flag', () => {
    const leave = { requestId: 'r', typeName: 'اعتيادية', paid: true, fullDay: true };
    expect(computeDay(day({ leave })).status).toBe('leave');
    expect(computeDay(day({ leave: { ...leave, paid: false } })).status).toBe('unpaid_leave');
  });

  it('lets hourly leave excuse lateness before early departure', () => {
    const leave = { requestId: 'r', typeName: 'زمنية', paid: true, fullDay: false, startTime: '08:00', endTime: '10:00' };
    const result = computeDay(day({ leave, punches: ['2026-10-04T09:30:00', '2026-10-04T16:00:00'] }));
    expect(result).toMatchObject({ lateMinutes: 0, excusedMinutes: 120, status: 'present' });
  });

  it('handles a night shift that crosses midnight', () => {
    const result = computeDay(day({ shift: nightShift, punches: ['2026-10-04T22:20:00', '2026-10-05T06:45:00'] }));
    expect(result).toMatchObject({ lateMinutes: 20, overtimeMinutes: 45, status: 'present' });
  });

  it('treats one late-in-shift punch as a missing entry rather than lateness', () => {
    expect(computeDay(day({ punches: ['2026-10-04T15:58:00'] }))).toMatchObject({ status: 'incomplete', lateMinutes: 0 });
    expect(computeDay(day({ punches: ['2026-10-04T08:30:00'] }))).toMatchObject({ status: 'incomplete', lateMinutes: 30 });
  });

  it('collapses double taps on the device', () => {
    const punches = ['2026-10-04T08:00:00', '2026-10-04T08:01:00', '2026-10-04T16:00:00'].map(toMinutes);
    expect(dedupePunches(punches, 2)).toHaveLength(2);
  });

  it('marks days outside employment', () => {
    expect(computeDay(day({ employed: false, punches: ['2026-10-04T08:00:00'] })).status).toBe('not_employed');
  });
});
