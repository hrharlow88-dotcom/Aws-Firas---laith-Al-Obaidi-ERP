import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

// A tiny valid PNG data URL, long enough to pass the size check.
const SIGNATURE = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='.repeat(4)}`;

type User = Awaited<ReturnType<typeof makeUser>>;
let admin: User; let hr: User; let auditor: User; let ceo: User; let finance: User;
let branchId: string;
let settings: Record<string, unknown> & { payrollRules: Record<string, unknown> };

async function setChain(on: boolean) {
  const current = await api().get('/api/settings').set(admin.auth).expect(200);
  settings = current.body.data;
  await api().put('/api/settings').set(admin.auth).send({ ...settings, payrollRules: { ...settings.payrollRules, approvalChain: on } }).expect(200);
}

beforeAll(async () => {
  admin = await makeUser('super_admin');
  hr = await makeUser('hr_manager');
  auditor = await makeUser('auditor');
  ceo = await makeUser('executive');
  finance = await makeUser('finance');
  branchId = (await makeBranch('فرع سلسلة الاعتماد')).id;
  const employee = await makeEmployee(branchId, { hireDate: '2025-01-01' });
  await api().post(`/api/employees/${employee.id}/compensation`).set(hr.auth)
    .send({ effectiveFrom: '2026-01-01', grossSalary: 1000000, currency: 'IQD', socialSecurityBase: 1000000, reason: 'راتب' }).expect(201);
  await api().post('/api/payroll/loans').set(hr.auth).send({
    employeeId: employee.id, principal: 1000000, installment: 300000, installmentsTotal: 3, startPeriod: '2031-01',
  }).expect(201);
  await setChain(true);
});

afterAll(async () => { await setChain(false); });

describe('payroll approval chain with e-signatures', () => {
  it('goes HR → audit → executive → finance, in order, one person per step, and a recalculation voids the signatures', async () => {
    const created = await api().post('/api/payroll/runs').set(hr.auth).send({ period: '2031-01', branchId }).expect(201);
    const id = created.body.data.id as string;
    await api().post(`/api/payroll/runs/${id}/calculate`).set(hr.auth).expect(200);

    // Direct approval is closed while the chain is on; a signature must be drawn first.
    await api().post(`/api/payroll/runs/${id}/approve`).set(ceo.auth).expect(409);
    await api().post(`/api/payroll/runs/${id}/sign`).set(hr.auth).send({ step: 'hr' }).expect(400);
    for (const user of [hr, auditor, ceo, finance]) await api().put('/api/auth/signature').set(user.auth).send({ image: SIGNATURE }).expect(200);

    await api().post(`/api/payroll/runs/${id}/sign`).set(auditor.auth).send({ step: 'audit' }).expect(409);
    await api().post(`/api/payroll/runs/${id}/sign`).set(auditor.auth).send({ step: 'hr' }).expect(403);
    await api().post(`/api/payroll/runs/${id}/sign`).set(hr.auth).send({ step: 'hr', note: 'مراجَع' }).expect(200);
    await api().post(`/api/payroll/runs/${id}/sign`).set(hr.auth).send({ step: 'audit' }).expect(403);

    // Recalculating voids what was signed.
    await api().post(`/api/payroll/runs/${id}/calculate`).set(hr.auth).expect(200);
    expect((await api().get(`/api/payroll/runs/${id}`).set(hr.auth)).body.data.signoffs).toEqual([]);

    await api().post(`/api/payroll/runs/${id}/sign`).set(hr.auth).send({ step: 'hr' }).expect(200);
    await api().post(`/api/payroll/runs/${id}/sign`).set(auditor.auth).send({ step: 'audit' }).expect(200);
    await api().post(`/api/payroll/runs/${id}/sign`).set(finance.auth).send({ step: 'finance' }).expect(409);
    await api().post(`/api/payroll/runs/${id}/sign`).set(ceo.auth).send({ step: 'ceo' }).expect(200);
    const approved = await api().get(`/api/payroll/runs/${id}`).set(hr.auth).expect(200);
    expect(approved.body.data.status).toBe('approved');
    await api().post(`/api/payroll/runs/${id}/sign`).set(finance.auth).send({ step: 'finance', note: 'حُوّل للمصرف' }).expect(200);
    const paid = await api().get(`/api/payroll/runs/${id}`).set(hr.auth).expect(200);
    expect(paid.body.data.signoffs.map((item: { step: string }) => item.step)).toEqual(['hr', 'audit', 'ceo', 'finance']);
    expect(paid.body.data.paidAt).toBeTruthy();
    expect(paid.body.data.signoffs[0].signature).toBe(SIGNATURE);

    // The loan shows month by month: deducted in January, then the plan, the third clearing the rest.
    const loans = await api().get('/api/payroll/loans?status=active').set(hr.auth).expect(200);
    const loan = loans.body.data.find((item: { startPeriod: string }) => item.startPeriod === '2031-01');
    const schedule = await api().get(`/api/payroll/loans/${loan.id}/schedule`).set(hr.auth).expect(200);
    expect(schedule.body.data.rows.map((row: { period: string; amount: number; kind: string }) => [row.period, row.amount, row.kind])).toEqual([
      ['2031-01', 300000, 'deducted'], ['2031-02', 300000, 'planned'], ['2031-03', 400000, 'planned'],
    ]);
    const month = await api().get('/api/payroll/loans/deductions?period=2031-01').set(hr.auth).expect(200);
    expect(month.body.data.rows).toHaveLength(1);
  });
});
