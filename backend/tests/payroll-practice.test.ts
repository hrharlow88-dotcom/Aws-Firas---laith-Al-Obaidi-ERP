import { beforeAll, describe, expect, it } from 'vitest';
import { execute } from '../src/db/query';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

const LOANS = '30000000-0000-4000-8000-000000000015';
const ABSENCE = '30000000-0000-4000-8000-000000000007';

let hr: Awaited<ReturnType<typeof makeUser>>;
let approver: Awaited<ReturnType<typeof makeUser>>;
let branchId: string;
let borrower: { id: string };
let joiner: { id: string };
let onHold: { id: string };
let leaver: { id: string };

async function salary(employeeId: string, grossSalary: number) {
  await api().post(`/api/employees/${employeeId}/compensation`).set(hr.auth)
    .send({ effectiveFrom: '2026-01-01', grossSalary, currency: 'IQD', socialSecurityBase: grossSalary, reason: 'راتب' }).expect(201);
}

async function calculate(period: string) {
  const created = await api().post('/api/payroll/runs').set(hr.auth).send({ period, branchId }).expect(201);
  const id = created.body.data.id as string;
  await api().post(`/api/payroll/runs/${id}/calculate`).set(hr.auth).expect(200);
  const run = await api().get(`/api/payroll/runs/${id}`).set(hr.auth).expect(200);
  const lines = Object.fromEntries(run.body.data.lines.map((line: { employeeId: string }) => [line.employeeId, line]));
  return { id, lines: lines as Record<string, { netPay: number; payableDays: number | null; deductions: Array<{ componentId: string; amount: number }> }> };
}

const part = (items: Array<{ componentId: string; amount: number }>, id: string) => items.find((item) => item.componentId === id)?.amount;

beforeAll(async () => {
  hr = await makeUser('hr_manager');
  approver = await makeUser('finance');
  branchId = (await makeBranch('فرع ممارسة الرواتب')).id;
  borrower = await makeEmployee(branchId, { hireDate: '2025-01-01', fullName: 'مقترض' });
  joiner = await makeEmployee(branchId, { hireDate: '2026-11-10', fullName: 'منضم جديد' });
  onHold = await makeEmployee(branchId, { hireDate: '2025-01-01', fullName: 'موقوف' });
  leaver = await makeEmployee(branchId, { hireDate: '2025-01-01', fullName: 'تارك' });
  for (const employee of [borrower, joiner, onHold, leaver]) await salary(employee.id, 900000);
  await api().put(`/api/employees/${onHold.id}`).set(hr.auth).send({ employmentStatus: 'suspended' }).expect(200);
  await execute(`UPDATE employees SET termination_date = '2026-11-05', employment_status = 'inactive' WHERE id = :id`, { id: leaver.id });
});

describe('company payroll practice', () => {
  it('records a loan and deducts instalments month by month until it is repaid', async () => {
    await api().post('/api/payroll/loans').set(hr.auth).send({
      employeeId: borrower.id, principal: 1000000, installment: 400000, paidBefore: 200000, startPeriod: '2026-11',
    }).expect(201);

    const november = await calculate('2026-11');
    expect(part(november.lines[borrower.id].deductions, LOANS)).toBe(400000);
    await api().post(`/api/payroll/runs/${november.id}/approve`).set(approver.auth).expect(200);

    const december = await calculate('2026-12');
    expect(part(december.lines[borrower.id].deductions, LOANS)).toBe(400000);
    await api().post(`/api/payroll/runs/${december.id}/approve`).set(approver.auth).expect(200);

    // Only 0 is left after 200,000 + 400,000 + 400,000.
    const loans = await api().get(`/api/payroll/loans?employeeId=${borrower.id}`).set(hr.auth).expect(200);
    expect(loans.body.data[0]).toMatchObject({ repaidByPayroll: 800000, remaining: 0, lastPeriod: '2026-12' });
    const january = await calculate('2027-01');
    expect(part(january.lines[borrower.id].deductions, LOANS)).toBeUndefined();
  });

  it('uses payable and absence days set by HR, skips suspended staff and leavers paid by settlement', async () => {
    // Only the owner reads (and saves) the whole settings; others get what their screens need.
    const admin = await makeUser('super_admin');
    const settings = await api().get('/api/settings').set(admin.auth).expect(200);
    await api().put('/api/settings').set(admin.auth).send({
      ...settings.body.data,
      payrollRules: { ...settings.body.data.payrollRules, terminatedPaidBySettlement: true },
    }).expect(200);

    await api().put('/api/payroll/day-adjustments').set(hr.auth)
      .send({ period: '2027-02', employeeId: joiner.id, payableDays: 11, absenceDays: 1 }).expect(200);
    const run = await calculate('2027-02');
    expect(run.lines[onHold.id]).toBeUndefined();
    expect(run.lines[leaver.id]).toBeUndefined();
    expect(run.lines[joiner.id].payableDays).toBe(11);
    // 900,000 × 11 / 30 = 330,000; one absence day at 30,000.
    expect(part(run.lines[joiner.id].deductions, ABSENCE)).toBe(30000);
    expect(run.lines[joiner.id].netPay).toBe(300000);

    const adjustments = await api().get('/api/payroll/day-adjustments?period=2027-02').set(hr.auth).expect(200);
    expect(adjustments.body.data).toHaveLength(1);
  });
});
