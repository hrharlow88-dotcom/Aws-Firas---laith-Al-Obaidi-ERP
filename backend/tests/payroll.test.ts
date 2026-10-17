import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { selectOne } from '../src/db/query';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

const COMMISSION = '30000000-0000-4000-8000-000000000004';
const ADVANCE = '30000000-0000-4000-8000-000000000010';

let hr: Awaited<ReturnType<typeof makeUser>>;
let finance: Awaited<ReturnType<typeof makeUser>>;
let branchId: string;
let tracked: { id: string; employeeNo: string };
let office: { id: string; employeeNo: string };
let dollar: { id: string };
let runId: string;

async function salary(employeeId: string, grossSalary: number, currency = 'IQD', effectiveFrom = '2026-01-01') {
  await api().post(`/api/employees/${employeeId}/compensation`).set(hr.auth)
    .send({ effectiveFrom, grossSalary, currency, reason: 'راتب التعيين' }).expect(201);
}

beforeAll(async () => {
  hr = await makeUser('hr_manager');
  finance = await makeUser('finance');
  branchId = (await makeBranch('فرع الرواتب')).id;
  const shift = await api().post('/api/attendance/shifts').set(hr.auth).send({
    code: 'PAY-DAY', name: 'دوام الرواتب', startTime: '08:00', endTime: '16:00', breakMinutes: 30,
    graceMinutes: 10, earlyLeaveGraceMinutes: 5, workingDays: [0, 1, 2, 3, 4, 6],
  }).expect(201);

  tracked = await makeEmployee(branchId, { attendancePin: '3001', shiftId: shift.body.data.id, hireDate: '2026-01-01', fullName: 'حيدر علي' });
  office = await makeEmployee(branchId, { hireDate: '2026-01-01', fullName: 'سارة محمد' });
  dollar = await makeEmployee(branchId, { hireDate: '2026-01-01', fullName: 'مستشار' });
  await salary(tracked.id, 1200000);
  await salary(office.id, 1500000);
  await salary(dollar.id, 2000, 'USD');
  await api().put(`/api/employees/${office.id}/profile`).set(hr.auth)
    .send({ paymentMethod: 'bank', bankName: 'مصرف الرشيد', bankAccountNo: '=HYPERLINK("x")9988' }).expect(200);

  // September 2026 has 26 working days (Fridays off); the tracked employee attends two of them.
  const file = ['3001\t2026-09-01 08:00:00', '3001\t2026-09-01 16:00:00', '3001\t2026-09-02 08:00:00', '3001\t2026-09-02 16:00:00'].join('\n');
  await api().post('/api/attendance/imports').set(hr.auth).attach('file', Buffer.from(file), 'attlog.dat').expect(201);
});

describe('payroll run', () => {
  it('prepares and calculates a branch run in one currency', async () => {
    const created = await api().post('/api/payroll/runs').set(hr.auth).send({ period: '2026-09', branchId }).expect(201);
    runId = created.body.data.id;
    await api().post(`/api/payroll/inputs`).set(hr.auth)
      .send({ period: '2026-09', employeeId: office.id, componentId: COMMISSION, amount: 250000, note: 'عمولة مبيعات' }).expect(201);

    await api().post(`/api/payroll/runs/${runId}/calculate`).set(hr.auth).expect(200);
    const run = await api().get(`/api/payroll/runs/${runId}`).set(hr.auth).expect(200);
    expect(run.body.data.status).toBe('calculated');
    const lines = Object.fromEntries(run.body.data.lines.map((line: { employeeId: string }) => [line.employeeId, line]));
    expect(lines[dollar.id]).toBeUndefined();

    expect(lines[tracked.id]).toMatchObject({ presentDays: 2, absentDays: 24, totalEarnings: 1200000, totalDeductions: 960000, netPay: 240000 });
    expect(lines[office.id]).toMatchObject({ attendanceTracked: false, totalEarnings: 1750000, netPay: 1750000 });
  });

  it('refuses an overlapping company-wide run for the same month and currency', async () => {
    await api().post('/api/payroll/runs').set(hr.auth).send({ period: '2026-09' }).expect(409);
    await api().post('/api/payroll/runs').set(hr.auth).send({ period: '2026-09', branchId, currency: 'USD' }).expect(201);
  });

  it('requires a second person to approve', async () => {
    const admin = await makeUser('super_admin');
    const own = await api().post('/api/payroll/runs').set(admin.auth).send({ period: '2026-08', branchId }).expect(201);
    await api().post(`/api/payroll/runs/${own.body.data.id}/calculate`).set(admin.auth).expect(200);
    await api().post(`/api/payroll/runs/${own.body.data.id}/approve`).set(admin.auth).expect(403);
    await api().post(`/api/payroll/runs/${runId}/approve`).set(hr.auth).expect(403); // HR lacks payroll.approve
  });

  it('rejects approval when data changed after calculation', async () => {
    await api().post('/api/payroll/inputs').set(hr.auth)
      .send({ period: '2026-09', employeeId: office.id, componentId: ADVANCE, amount: 100000, note: 'سلفة' }).expect(201);
    const stale = await api().post(`/api/payroll/runs/${runId}/approve`).set(finance.auth).expect(409);
    expect(stale.body.message).toContain('أعد احتساب');

    await api().post(`/api/payroll/runs/${runId}/calculate`).set(hr.auth).expect(200);
    await api().post(`/api/payroll/runs/${runId}/approve`).set(finance.auth).expect(200);
    const run = await api().get(`/api/payroll/runs/${runId}`).set(finance.auth).expect(200);
    expect(run.body.data.status).toBe('approved');
    const officeLine = run.body.data.lines.find((line: { employeeId: string }) => line.employeeId === office.id);
    expect(officeLine.netPay).toBe(1650000);
  });

  it('locks attendance, variable amounts and back-dated salary changes after approval', async () => {
    const day = await selectOne<{ runId: string | null }>(
      `SELECT payroll_run_id AS "runId" FROM attendance_days WHERE employee_id = :id AND work_date = '2026-09-10'`,
      { id: tracked.id },
    );
    expect(day!.runId).toBe(runId);
    await api().put(`/api/attendance/days/${tracked.id}/2026-09-10`).set(hr.auth)
      .send({ status: 'present', reason: 'تصحيح' }).expect(409);
    await api().post('/api/payroll/inputs').set(hr.auth)
      .send({ period: '2026-09', employeeId: office.id, componentId: COMMISSION, amount: 1, note: 'x' }).expect(409);
    await api().post(`/api/employees/${office.id}/compensation`).set(hr.auth)
      .send({ effectiveFrom: '2026-09-15', grossSalary: 1, reason: 'x' }).expect(409);
    await api().post(`/api/employees/${office.id}/compensation`).set(hr.auth)
      .send({ effectiveFrom: '2026-10-01', grossSalary: 1600000, reason: 'زيادة سنوية' }).expect(201);
  });

  it('produces payslips, an Excel register and a safe bank file', async () => {
    const payslip = await api().get(`/api/payroll/runs/${runId}/payslips/${office.id}`).set(finance.auth).expect(200);
    expect(payslip.body.data).toMatchObject({ netPay: 1650000, bankAccountTail: '9988', employeeName: 'سارة محمد' });

    const register = await api().get(`/api/payroll/runs/${runId}/register.xlsx`).set(finance.auth)
      .buffer(true).parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      }).expect(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(register.body as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    expect(sheet.rowCount).toBe(4); // header, two employees, totals

    const bank = await api().get(`/api/payroll/runs/${runId}/bank.csv`).set(finance.auth).expect(200);
    expect(bank.text).toContain("'=HYPERLINK");
    expect(bank.text).toContain('1650000.00');
  });

  it('can be reopened by an approver, which releases the locks', async () => {
    await api().post(`/api/payroll/runs/${runId}/reopen`).set(finance.auth).send({}).expect(400);
    await api().post(`/api/payroll/runs/${runId}/reopen`).set(finance.auth).send({ reason: 'تصحيح عمولة' }).expect(200);
    const day = await selectOne<{ runId: string | null }>(
      `SELECT payroll_run_id AS "runId" FROM attendance_days WHERE employee_id = :id AND work_date = '2026-09-10'`,
      { id: tracked.id },
    );
    expect(day!.runId).toBeNull();
  });

  it('keeps payroll away from users without payroll rights', async () => {
    const manager = await makeUser('branch_manager', branchId);
    await api().get('/api/payroll/runs').set(manager.auth).expect(403);
    await api().get(`/api/payroll/runs/${runId}/payslips/${office.id}`).set(manager.auth).expect(403);
  });
});
