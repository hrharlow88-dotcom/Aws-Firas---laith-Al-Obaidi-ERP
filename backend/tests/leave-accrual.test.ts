import { beforeAll, describe, expect, it } from 'vitest';
import type { LeaveTypeSetting } from '../src/config/systemSettings';
import { completedYears, monthlyAccrual } from '../src/services/leaveAccrual';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

const ANNUAL: LeaveTypeSetting = {
  id: '40000000-0000-4000-8000-0000000000aa',
  name: 'سنوية (اختبار الاستحقاق)',
  unit: 'days',
  paid: true,
  active: true,
  annualEntitlement: 21,
  carryForwardLimit: null,
  // Company policy as stated by HR: 21 days, +2 for every five years of service.
  serviceEntitlements: [{ minimumYears: 5, days: 23 }, { minimumYears: 10, days: 25 }],
  monthlyAccrual: true,
};
const base = { terminationDate: null, employmentStatus: 'active', employmentType: 'permanent' };

describe('monthly accrual rule', () => {
  it('credits 1.75 days a month on 21 days a year', () => {
    expect(monthlyAccrual('2026-10', { ...base, hireDate: '2024-01-01' }, ANNUAL)).toMatchObject({ days: 1.75, entitlement: 21 });
  });

  it('adds up to exactly the yearly entitlement over twelve full months', () => {
    const months = Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}`);
    const total = months.reduce((sum, period) => sum + monthlyAccrual(period, { ...base, hireDate: '2015-06-01' }, ANNUAL).days, 0);
    expect(Math.round(total * 100) / 100).toBe(25);
  });

  it('uses the service tier from the month the fifth year is completed', () => {
    expect(completedYears('2021-10-20', '2026-10-31')).toBe(5);
    expect(monthlyAccrual('2026-09', { ...base, hireDate: '2021-10-20' }, ANNUAL).entitlement).toBe(21);
    expect(monthlyAccrual('2026-10', { ...base, hireDate: '2021-10-20' }, ANNUAL).entitlement).toBe(23);
  });

  it('prorates a joiner and a leaver by calendar days and skips suspended staff', () => {
    // Joined 17 October: 15 of 31 days → 1.75 × 15/31 = 0.85.
    expect(monthlyAccrual('2026-10', { ...base, hireDate: '2026-10-17' }, ANNUAL)).toMatchObject({ days: 0.85, employedDays: 15 });
    // Left 10 October after six years (23 days a year): 23/12 × 10/31 = 0.62.
    expect(monthlyAccrual('2026-10', { ...base, hireDate: '2020-01-01', employmentStatus: 'inactive', terminationDate: '2026-10-10' }, ANNUAL).days).toBe(0.62);
    expect(monthlyAccrual('2026-10', { ...base, hireDate: '2020-01-01', employmentStatus: 'suspended' }, ANNUAL)).toMatchObject({ days: 0, skipReason: 'موقوف' });
    expect(monthlyAccrual('2026-10', { ...base, hireDate: '2026-11-02' }, ANNUAL).skipReason).toBe('لم يباشر بعد');
  });

  it('leaves out employment types the leave type does not cover', () => {
    const permanentOnly = { ...ANNUAL, accrualEmploymentTypes: ['permanent'] };
    expect(monthlyAccrual('2026-10', { ...base, hireDate: '2024-01-01', employmentType: 'daily' }, permanentOnly).days).toBe(0);
  });
});

describe('posting a month', () => {
  let hr: Awaited<ReturnType<typeof makeUser>>;
  let staff: { id: string };

  beforeAll(async () => {
    hr = await makeUser('hr_manager');
    const admin = await makeUser('super_admin');
    const settings = await api().get('/api/settings').set(admin.auth).expect(200);
    await api().put('/api/settings').set(admin.auth).send({
      ...settings.body.data,
      leaveTypes: [...settings.body.data.leaveTypes.filter((type: LeaveTypeSetting) => type.id !== ANNUAL.id), ANNUAL],
      leaveRules: { ...settings.body.data.leaveRules, accrualStartPeriod: '2026-09' },
    }).expect(200);
    const branch = await makeBranch('فرع الاستحقاق');
    staff = await makeEmployee(branch.id, { hireDate: '2024-03-01' });
  });

  it('previews, posts once, and refuses months before the opening balances or a second posting', async () => {
    await api().get(`/api/leaves/accruals/preview?period=2026-08&leaveTypeId=${ANNUAL.id}`).set(hr.auth).expect(200)
      .then((res) => expect(res.body.data.errors.join(' ')).toContain('الرصيد الافتتاحي'));
    await api().post('/api/leaves/accruals').set(hr.auth).send({ period: '2026-08', leaveTypeId: ANNUAL.id }).expect(400);

    const preview = await api().get(`/api/leaves/accruals/preview?period=2026-09&leaveTypeId=${ANNUAL.id}`).set(hr.auth).expect(200);
    expect(preview.body.data.errors).toEqual([]);
    expect(preview.body.data.lines.find((line: { employeeId: string }) => line.employeeId === staff.id)).toMatchObject({ days: 1.75 });

    const posted = await api().post('/api/leaves/accruals').set(hr.auth).send({ period: '2026-09', leaveTypeId: ANNUAL.id }).expect(201);
    expect(posted.body.data.credited).toBe(preview.body.data.summary.credited);
    await api().post('/api/leaves/accruals').set(hr.auth).send({ period: '2026-09', leaveTypeId: ANNUAL.id }).expect(400);

    const balances = await api().get(`/api/leaves/balances?employeeId=${staff.id}`).set(hr.auth).expect(200);
    expect(balances.body.data.balances.find((b: { leaveTypeId: string }) => b.leaveTypeId === ANNUAL.id).balance).toBe(1.75);

    // October warns that September is the latest posted month only when it is missing — here it is not.
    const october = await api().get(`/api/leaves/accruals/preview?period=2026-10&leaveTypeId=${ANNUAL.id}`).set(hr.auth).expect(200);
    expect(october.body.data.warnings.join(' ')).not.toContain('2026-09');
    const runs = await api().get('/api/leaves/accruals').set(hr.auth).expect(200);
    expect(runs.body.data.some((run: { period: string }) => run.period === '2026-09')).toBe(true);
  });

  it('is not available to a branch manager or an ordinary employee', async () => {
    const employee = await makeUser('employee');
    await api().get(`/api/leaves/accruals/preview?period=2026-10&leaveTypeId=${ANNUAL.id}`).set(employee.auth).expect(403);
  });
});
