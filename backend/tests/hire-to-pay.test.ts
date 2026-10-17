import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SystemSettings } from '../src/config/systemSettings';
import { execute, select, selectOne } from '../src/db/query';
import { verifyAuditChain } from '../src/services/security';
import { resetSapClient } from '../src/services/sapB1';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';
import { MockSap, startMockSap } from './mockSap';

/**
 * One person's whole journey through the system, across the modules that hand
 * work to each other: a vacancy is filled, the new employee gets a salary, a
 * manager, a portal account; they take a day of unpaid leave, miss two days and
 * owe a loan instalment; the month's payroll is calculated, approved by someone
 * other than its preparer, booked to SAP as a balanced journal by cost centre,
 * and only then does the payslip appear in the employee's portal.
 */

const PERIOD = '2032-03';
const BASIC = '30000000-0000-4000-8000-000000000001';
const FOOD = '30000000-0000-4000-8000-000000000002';
const LIVING = '30000000-0000-4000-8000-000000000003';
const ABSENCE = '30000000-0000-4000-8000-000000000007';
const SOCIAL_SECURITY = '30000000-0000-4000-8000-000000000011';
const LOANS = '30000000-0000-4000-8000-000000000015';
const UNPAID_LEAVE = '43000000-0000-4000-8000-0000000000a1';

type User = Awaited<ReturnType<typeof makeUser>>;
let sap: MockSap;
let admin: User; let hr: User; let finance: User; let managerUser: User; let self: User; let colleagueUser: User;
let original: SystemSettings;
let branchId: string;
interface Mapping { mappingKey: string; label: string; debitAccount: string | null; creditAccount: string | null; useCostCenter: boolean }
let mappingsBefore: Mapping[];

beforeAll(async () => {
  sap = await startMockSap();
  Object.assign(process.env, {
    SAP_B1_URL: sap.url, SAP_B1_COMPANY_DB: 'SBO_LAITH', SAP_B1_USER: 'manager', SAP_B1_PASSWORD: 'sap-pass', SAP_B1_LOCAL_CURRENCY: 'IQD',
  });
  resetSapClient();
  admin = await makeUser('super_admin');
  hr = await makeUser('hr_manager');
  finance = await makeUser('finance');
  branchId = (await makeBranch('فرع الدورة الكاملة')).id;
  // Account mappings are company-wide: put them back afterwards so other tests start from what they expect.
  mappingsBefore = await select<Mapping>(
    `SELECT mapping_key AS "mappingKey", label, debit_account AS "debitAccount", credit_account AS "creditAccount", use_cost_center AS "useCostCenter"
     FROM finance_account_mappings`,
  );

  // The company's rules for this journey: social security on, an unpaid leave type, the line manager approves leave.
  original = (await api().get('/api/settings').set(admin.auth).expect(200)).body.data;
  await api().put('/api/settings').set(admin.auth).send({
    ...original,
    leaveTypes: [...original.leaveTypes.filter((type) => type.id !== UNPAID_LEAVE), {
      id: UNPAID_LEAVE, name: 'إجازة بلا راتب (الدورة الكاملة)', unit: 'days', paid: false, active: true,
      annualEntitlement: null, carryForwardLimit: null, deductsBalance: false,
    }],
    approvalSteps: [{ id: '42000000-0000-4000-8000-0000000000a1', role: 'line_manager' }],
    payrollRules: {
      ...original.payrollRules,
      approvalChain: false,
      // A statutory deduction runs only once the company confirmed it (as HR did for the 5% rule).
      components: original.payrollRules.components.map((component) => component.id === SOCIAL_SECURITY ? { ...component, active: true, legalApproved: true } : component),
    },
  }).expect(200);
});

afterAll(async () => {
  await api().put('/api/settings').set(admin.auth).send(original).expect(200);
  await execute('DELETE FROM finance_account_mappings');
  for (const row of mappingsBefore) {
    await execute(
      `INSERT INTO finance_account_mappings (mapping_key, label, debit_account, credit_account, use_cost_center, updated_by, updated_at)
       VALUES (:mappingKey, :label, :debitAccount, :creditAccount, :useCostCenter, :userId, now())`,
      { ...row, userId: admin.user.id },
    );
  }
  await sap.close();
  for (const key of ['SAP_B1_URL', 'SAP_B1_COMPANY_DB', 'SAP_B1_USER', 'SAP_B1_PASSWORD']) delete process.env[key];
  resetSapClient();
});

describe('from vacancy to salary: one employee across recruitment, leave, payroll, finance and the portal', () => {
  let employeeId: string;
  let runId: string;
  let journalId: string;

  it('fills a vacancy and opens the new employee file on probation in the right department', async () => {
    const department = await api().post('/api/org/departments').set(hr.auth)
      .send({ code: 'E2E-SVC', name: 'خدمة ما بعد البيع (الدورة)', costCenterCode: 'CC-E2E' }).expect(201);
    const position = await api().post('/api/recruitment/positions').set(hr.auth)
      .send({ title: 'مستشار خدمة', branchId, departmentId: department.body.data.id, vacancies: 1 }).expect(201);
    const applicant = await api().post('/api/recruitment/applicants').set(hr.auth)
      .send({ positionId: position.body.data.id, fullName: 'زينب كريم (الدورة)', phone: '07701234567', source: 'referral' }).expect(201);
    const applicantId = applicant.body.data.id;
    await api().patch(`/api/recruitment/applicants/${applicantId}`).set(hr.auth).send({ stage: 'interview1', interviewAt: '2032-02-10T10:00' }).expect(200);
    await api().patch(`/api/recruitment/applicants/${applicantId}`).set(hr.auth).send({ stage: 'offer', note: 'تمت الموافقة على العرض' }).expect(200);
    const hired = await api().post(`/api/recruitment/applicants/${applicantId}/hire`).set(hr.auth)
      .send({ employeeNo: `E2E-${Date.now() % 1000000}`, hireDate: `${PERIOD}-01` }).expect(201);
    employeeId = hired.body.data.employeeId;

    const file = await selectOne<{ type: string; branchId: string; departmentId: string; hireDate: string }>(
      `SELECT employment_type AS type, branch_id AS "branchId", department_id AS "departmentId", to_char(hire_date, 'YYYY-MM-DD') AS "hireDate"
       FROM employees WHERE id = :id`, { id: employeeId });
    expect(file).toEqual({ type: 'probation', branchId, departmentId: department.body.data.id, hireDate: `${PERIOD}-01` });
    // A second hire for the same vacancy is refused.
    await api().post(`/api/recruitment/applicants/${applicantId}/hire`).set(hr.auth).send({ employeeNo: 'E2E-AGAIN', hireDate: `${PERIOD}-01` }).expect(409);
  });

  it('gives them a salary, a line manager and a portal account', async () => {
    await api().post(`/api/employees/${employeeId}/compensation`).set(hr.auth)
      .send({ effectiveFrom: `${PERIOD}-01`, grossSalary: 1200000, currency: 'IQD', socialSecurityBase: 1000000, reason: 'راتب التعيين' }).expect(201);
    const manager = await makeEmployee(branchId, { fullName: 'مدير الخدمة (الدورة)', hireDate: '2030-01-01' });
    managerUser = await makeUser('line_manager', null, manager.id);
    await api().put(`/api/employees/${employeeId}`).set(hr.auth).send({ managerId: manager.id }).expect(200);
    self = await makeUser('employee', null, employeeId);
    colleagueUser = await makeUser('employee', null, (await makeEmployee(branchId, { fullName: 'زميل (الدورة)', hireDate: '2030-01-01' })).id);

    const profile = await api().get('/api/me/profile').set(self.auth).expect(200);
    expect(profile.body.data).toMatchObject({ fullName: 'زينب كريم (الدورة)', managerName: 'مدير الخدمة (الدورة)' });
    // Salaries stay with HR: the employee and the manager cannot read them.
    await api().get(`/api/employees/${employeeId}/compensation`).set(self.auth).expect(403);
    await api().get(`/api/employees/${employeeId}/compensation`).set(managerUser.auth).expect(403);
  });

  it('takes a day of unpaid leave that only the line manager approves', async () => {
    const request = await api().post('/api/leaves').set(self.auth)
      .send({ employeeId, leaveTypeId: UNPAID_LEAVE, startsOn: `${PERIOD}-10`, endsOn: `${PERIOD}-10`, reason: 'ظرف عائلي' }).expect(201);
    const requestId = request.body.data.id;
    const asked = await selectOne<{ title: string }>(
      'SELECT title FROM notifications WHERE user_id = :id ORDER BY created_at DESC LIMIT 1', { id: managerUser.user.id });
    expect(asked?.title).toContain('إجازة');
    // Not the employee, not a colleague: the manager.
    await api().post(`/api/leaves/${requestId}/decision`).set(self.auth).send({ action: 'approve' }).expect(403);
    await api().post(`/api/leaves/${requestId}/decision`).set(colleagueUser.auth).send({ action: 'approve' }).expect(403);
    await api().post(`/api/leaves/${requestId}/decision`).set(managerUser.auth).send({ action: 'approve', note: 'موافق' }).expect(200);
    const leave = await selectOne<{ status: string }>('SELECT status FROM leave_requests WHERE id = :id', { id: requestId });
    expect(leave!.status).toBe('approved');
  });

  it('records two absent days and a loan, then calculates the month exactly', async () => {
    await api().put('/api/payroll/day-adjustments').set(hr.auth)
      .send({ period: PERIOD, employeeId, absenceDays: 2, note: 'غياب بلا عذر' }).expect(200);
    await api().post('/api/payroll/loans').set(hr.auth)
      .send({ employeeId, principal: 600000, installment: 300000, installmentsTotal: 2, startPeriod: PERIOD }).expect(201);

    const created = await api().post('/api/payroll/runs').set(hr.auth).send({ period: PERIOD, branchId }).expect(201);
    runId = created.body.data.id;
    await api().post(`/api/payroll/runs/${runId}/calculate`).set(hr.auth).expect(200);
    const run = await api().get(`/api/payroll/runs/${runId}`).set(hr.auth).expect(200);
    const line = run.body.data.lines.find((item: { employeeId: string }) => item.employeeId === employeeId);
    const deductions = Object.fromEntries((line.deductions as Array<{ componentId: string; amount: number }>).map((item) => [item.componentId, item.amount]));

    // 1,200,000 a month = 40,000 a day (÷30). Unpaid leave (1 day) + absence (2 days) = 3 days.
    expect(line.unpaidLeaveDays).toBe(1);
    expect(line.totalEarnings).toBe(1200000);
    expect(deductions[ABSENCE]).toBe(120000);
    // Social security: 5% of the declared 1,000,000, whole dinars.
    expect(deductions[SOCIAL_SECURITY]).toBe(50000);
    expect(deductions[LOANS]).toBe(300000);
    expect(line.totalDeductions).toBe(470000);
    expect(line.netPay).toBe(730000);
    expect(line.netPay).toBe(line.totalEarnings - line.totalDeductions);
    expect(run.body.data.totalNet).toBe(run.body.data.lines.reduce((sum: number, item: { netPay: number }) => sum + item.netPay, 0));
  });

  it('keeps the payslip from the employee until someone other than the preparer approves', async () => {
    expect((await api().get('/api/me/payslips').set(self.auth).expect(200)).body.data).toEqual([]);
    await api().get(`/api/me/payslips/${runId}`).set(self.auth).expect(404);
    await api().post(`/api/payroll/runs/${runId}/approve`).set(hr.auth).expect(403);
    await api().post(`/api/payroll/runs/${runId}/approve`).set(finance.auth).expect(200);

    const mine = (await api().get('/api/me/payslips').set(self.auth).expect(200)).body.data;
    expect(mine).toEqual([expect.objectContaining({ runId, period: PERIOD, netPay: 730000, totalEarnings: 1200000, totalDeductions: 470000 })]);
    const slip = await api().get(`/api/me/payslips/${runId}`).set(self.auth).expect(200);
    expect(slip.body.data).toMatchObject({ netPay: 730000 });
    // A colleague sees only their own payslip, never this one.
    const theirs = (await api().get('/api/me/payslips').set(colleagueUser.auth).expect(200)).body.data;
    expect(theirs.every((item: { netPay: number }) => item.netPay !== 730000)).toBe(true);
    await api().get(`/api/payroll/runs/${runId}/payslips/${employeeId}`).set(colleagueUser.auth).expect(403);
  });

  it('books the approved month to SAP as one balanced journal on the department cost centre', async () => {
    await api().put('/api/finance/mappings').set(finance.auth).send({
      mappings: [
        { mappingKey: BASIC, debitAccount: '610100' },
        { mappingKey: FOOD, debitAccount: '610200' },
        { mappingKey: LIVING, debitAccount: '610300' },
        { mappingKey: ABSENCE, creditAccount: '710900', useCostCenter: false },
        { mappingKey: SOCIAL_SECURITY, creditAccount: '220100', useCostCenter: false },
        { mappingKey: LOANS, creditAccount: '140300', useCostCenter: false },
        { mappingKey: 'net_pay', creditAccount: '210500', useCostCenter: false },
      ],
    }).expect(200);
    await api().post(`/api/finance/journals/from-payroll/${runId}`).set(hr.auth).expect(403);
    const created = await api().post(`/api/finance/journals/from-payroll/${runId}`).set(finance.auth).expect(201);
    journalId = created.body.data.id;
    const journal = (await api().get(`/api/finance/journals/${journalId}`).set(finance.auth).expect(200)).body.data;
    expect(journal.totalDebit).toBe(1200000);
    expect(journal.totalCredit).toBe(1200000);
    const credit = (account: string) => journal.lines.filter((item: { accountCode: string }) => item.accountCode === account)
      .reduce((sum: number, item: { credit: number }) => sum + item.credit, 0);
    expect(credit('210500')).toBe(730000);
    expect(credit('220100')).toBe(50000);
    expect(credit('140300')).toBe(300000);
    expect(credit('710900')).toBe(120000);
    const salaryLines = journal.lines.filter((item: { accountCode: string; debit: number }) => item.accountCode.startsWith('610') && item.debit > 0);
    expect(new Set(salaryLines.map((item: { costCenter: string }) => item.costCenter))).toEqual(new Set(['CC-E2E']));

    const posted = await api().post(`/api/finance/journals/${journalId}/post`).set(finance.auth).expect(200);
    expect(posted.body.data.status).toBe('posted');
    const document = sap.documents.at(-1) as { Reference: string; JournalEntryLines: Array<{ Debit?: number; Credit?: number }> };
    expect(document.Reference).toMatch(new RegExp(`^PAY-${PERIOD}-IQD-`));
    const sum = (key: 'Debit' | 'Credit') => document.JournalEntryLines.reduce((total, item) => total + (item[key] ?? 0), 0);
    expect(sum('Debit')).toBe(sum('Credit'));
    const after = await selectOne<{ status: string }>('SELECT status FROM payroll_runs WHERE id = :id', { id: runId });
    expect(after!.status).toBe('posted');
    // The payslip stays visible once the month is booked.
    expect((await api().get('/api/me/payslips').set(self.auth).expect(200)).body.data[0]).toMatchObject({ runId, netPay: 730000 });
  });

  it('carries the loan into next month and leaves an unbroken audit trail behind', async () => {
    const loans = (await api().get(`/api/payroll/loans?employeeId=${employeeId}`).set(hr.auth).expect(200)).body.data;
    const loan = loans.find((item: { startPeriod: string; employeeId?: string }) => item.startPeriod === PERIOD);
    const schedule = (await api().get(`/api/payroll/loans/${loan.id}/schedule`).set(hr.auth).expect(200)).body.data.rows;
    expect(schedule.map((row: { period: string; amount: number; kind: string }) => [row.period, row.amount, row.kind])).toEqual([
      [PERIOD, 300000, 'deducted'], ['2032-04', 300000, 'planned'],
    ]);

    const actions = (await select<{ action: string }>(
      `SELECT action FROM audit_logs WHERE entity_id = :employeeId OR entity_id = :runId OR entity_id = :journalId ORDER BY seq`,
      { employeeId, runId, journalId },
    )).map((row) => row.action);
    for (const action of ['recruitment.hired', 'payroll.days_adjusted']) expect(actions).toContain(action);
    expect(actions.some((action) => action.startsWith('payroll.') && action.includes('approv'))).toBe(true);
    expect(actions.some((action) => action.startsWith('finance.') || action.startsWith('journal.'))).toBe(true);
    const chain = await verifyAuditChain();
    expect(chain.broken).toBe(0);
  });
});
