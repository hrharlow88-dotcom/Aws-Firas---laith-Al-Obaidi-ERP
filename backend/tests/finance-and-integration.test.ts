import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute, selectOne } from '../src/db/query';
import { processJournalQueue } from '../src/services/finance';
import { resetSapClient } from '../src/services/sapB1';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';
import { MockSap, startMockSap } from './mockSap';

const BASIC = '30000000-0000-4000-8000-000000000001';
const FOOD = '30000000-0000-4000-8000-000000000002';
const LIVING = '30000000-0000-4000-8000-000000000003';
const COMMISSION = '30000000-0000-4000-8000-000000000004';
const ABSENCE = '30000000-0000-4000-8000-000000000007';
const ADVANCE = '30000000-0000-4000-8000-000000000010';

let sap: MockSap;
let hr: Awaited<ReturnType<typeof makeUser>>;
let finance: Awaited<ReturnType<typeof makeUser>>;
let admin: Awaited<ReturnType<typeof makeUser>>;
let branchId: string;

async function approvedRun(period: string, currency = 'IQD') {
  const run = await api().post('/api/payroll/runs').set(hr.auth).send({ period, branchId, currency }).expect(201);
  await api().post(`/api/payroll/runs/${run.body.data.id}/calculate`).set(hr.auth).expect(200);
  await api().post(`/api/payroll/runs/${run.body.data.id}/approve`).set(finance.auth).expect(200);
  return run.body.data.id as string;
}

beforeAll(async () => {
  sap = await startMockSap();
  Object.assign(process.env, {
    SAP_B1_URL: sap.url, SAP_B1_COMPANY_DB: 'SBO_LAITH', SAP_B1_USER: 'manager', SAP_B1_PASSWORD: 'sap-pass', SAP_B1_LOCAL_CURRENCY: 'IQD',
  });
  resetSapClient();
  hr = await makeUser('hr_manager');
  finance = await makeUser('finance');
  admin = await makeUser('super_admin');
  branchId = (await makeBranch('فرع المالية')).id;

  const sales = await api().post('/api/org/departments').set(hr.auth).send({ code: 'FIN-SALES', name: 'مبيعات الفرع', costCenterCode: 'CC-SALES' }).expect(201);
  const service = await api().post('/api/org/departments').set(hr.auth).send({ code: 'FIN-SVC', name: 'صيانة الفرع', costCenterCode: 'CC-SVC' }).expect(201);
  const first = await makeEmployee(branchId, { hireDate: '2026-01-01', departmentId: sales.body.data.id });
  const second = await makeEmployee(branchId, { hireDate: '2026-01-01', departmentId: service.body.data.id });
  const consultant = await makeEmployee(branchId, { hireDate: '2026-01-01' });
  for (const [employee, gross, currency] of [[first, 1000000, 'IQD'], [second, 900000, 'IQD'], [consultant, 1500, 'USD']] as const) {
    await api().post(`/api/employees/${employee.id}/compensation`).set(hr.auth)
      .send({ effectiveFrom: '2026-01-01', grossSalary: gross, currency, reason: 'راتب التعيين' }).expect(201);
  }
  for (const period of ['2026-05', '2026-06', '2026-07']) {
    await api().post('/api/payroll/inputs').set(hr.auth)
      .send({ period, employeeId: first.id, componentId: COMMISSION, amount: 333333.33, note: 'عمولة' }).expect(201);
    await api().post('/api/payroll/inputs').set(hr.auth)
      .send({ period, employeeId: second.id, componentId: ADVANCE, amount: 100000, note: 'سلفة' }).expect(201);
  }
});

afterAll(async () => {
  await sap.close();
  for (const key of ['SAP_B1_URL', 'SAP_B1_COMPANY_DB', 'SAP_B1_USER', 'SAP_B1_PASSWORD']) delete process.env[key];
  resetSapClient();
});

describe('finance and SAP Business One', () => {
  it('refuses to build an entry until every component has an account', async () => {
    const runId = await approvedRun('2026-05');
    const result = await api().post(`/api/finance/journals/from-payroll/${runId}`).set(finance.auth).expect(409);
    expect(result.body.message).toContain('الراتب الأساسي');
  });

  it('builds a balanced entry by cost center and posts it to SAP', async () => {
    await api().put('/api/finance/mappings').set(finance.auth).send({
      mappings: [
        { mappingKey: BASIC, debitAccount: '610100' },
        { mappingKey: FOOD, debitAccount: '610200' },
        { mappingKey: LIVING, debitAccount: '610300' },
        { mappingKey: COMMISSION, debitAccount: '610400' },
        { mappingKey: ADVANCE, creditAccount: '140300', useCostCenter: false },
        { mappingKey: ABSENCE, creditAccount: '710900', useCostCenter: false },
        { mappingKey: 'net_pay', creditAccount: '210500', useCostCenter: false },
      ],
    }).expect(200);
    await api().put('/api/finance/mappings').set(finance.auth)
      .send({ mappings: [{ mappingKey: BASIC, debitAccount: '61 01; DROP' }] }).expect(400);

    const run = await selectOne<{ id: string }>(`SELECT id FROM payroll_runs WHERE period = '2026-05' AND branch_id = :branchId`, { branchId });
    const created = await api().post(`/api/finance/journals/from-payroll/${run!.id}`).set(finance.auth).expect(201);
    const journal = await api().get(`/api/finance/journals/${created.body.data.id}`).set(finance.auth).expect(200);
    const { lines, totalDebit, totalCredit } = journal.body.data;
    expect(totalDebit).toBe(totalCredit);
    // 1,900,000 gross + 333,333.33 commission.
    expect(totalDebit).toBe(2233333.33);
    expect(lines.filter((line: { accountCode: string }) => line.accountCode === '610100')
      .map((line: { costCenter: string }) => line.costCenter).sort()).toEqual(['CC-SALES', 'CC-SVC']);
    expect(lines.find((line: { accountCode: string }) => line.accountCode === '210500').credit).toBe(2133333.33);

    const posted = await api().post(`/api/finance/journals/${created.body.data.id}/post`).set(finance.auth).expect(200);
    expect(posted.body.data.status).toBe('posted');
    expect(sap.documents).toHaveLength(1);
    const document = sap.documents[0] as { Reference: string; JournalEntryLines: Array<Record<string, unknown>> };
    expect(document.Reference).toMatch(/^PAY-2026-05-IQD-/);
    expect(document.JournalEntryLines.some((line) => line.CostingCode === 'CC-SALES')).toBe(true);

    const runAfter = await selectOne<{ status: string }>('SELECT status FROM payroll_runs WHERE id = :id', { id: run!.id });
    expect(runAfter!.status).toBe('posted');
    await api().post(`/api/payroll/runs/${run!.id}/reopen`).set(finance.auth).send({ reason: 'x' }).expect(409);
  });

  it('does not duplicate an entry when SAP saved it but the answer was lost', async () => {
    const runId = await approvedRun('2026-06');
    const created = await api().post(`/api/finance/journals/from-payroll/${runId}`).set(finance.auth).expect(201);
    sap.loseNextResponse = true;
    const first = await api().post(`/api/finance/journals/${created.body.data.id}/post`).set(finance.auth).expect(200);
    expect(first.body.data.status).toBe('queued');
    expect(first.body.data.lastError).toBeTruthy();

    await execute('UPDATE journal_entries SET next_attempt_at = now() WHERE id = :id', { id: created.body.data.id });
    await processJournalQueue();
    const entry = await selectOne<{ status: string; sapTransId: number }>(
      'SELECT status, sap_trans_id AS "sapTransId" FROM journal_entries WHERE id = :id', { id: created.body.data.id },
    );
    expect(entry!.status).toBe('posted');
    const saved = sap.documents.filter((doc) => String(doc.Reference).startsWith('PAY-2026-06'));
    expect(saved).toHaveLength(1);
    expect(entry!.sapTransId).toBe(saved[0].JdtNum);
  });

  it('stops retrying when SAP rejects the document and shows SAP\'s reason', async () => {
    const runId = await approvedRun('2026-07');
    await api().put('/api/finance/mappings').set(finance.auth)
      .send({ mappings: [{ mappingKey: ADVANCE, creditAccount: '999999', useCostCenter: false }] }).expect(200);
    const created = await api().post(`/api/finance/journals/from-payroll/${runId}`).set(finance.auth).expect(201);
    const result = await api().post(`/api/finance/journals/${created.body.data.id}/post`).set(finance.auth).expect(200);
    expect(result.body.data.status).toBe('failed');
    expect(result.body.data.lastError).toContain("Invalid account code '999999'");

    // Fix the mapping, regenerate, and post again under a new reference.
    await api().put('/api/finance/mappings').set(finance.auth)
      .send({ mappings: [{ mappingKey: ADVANCE, creditAccount: '140300', useCostCenter: false }] }).expect(200);
    const regenerated = await api().post(`/api/finance/journals/from-payroll/${runId}`).set(finance.auth).expect(201);
    const retried = await api().post(`/api/finance/journals/${regenerated.body.data.id}/post`).set(finance.auth).expect(200);
    expect(retried.body.data.status).toBe('posted');
  });

  it('posts a USD payroll as a foreign-currency entry', async () => {
    const runId = await approvedRun('2026-05', 'USD');
    const created = await api().post(`/api/finance/journals/from-payroll/${runId}`).set(finance.auth).expect(201);
    await api().post(`/api/finance/journals/${created.body.data.id}/post`).set(finance.auth).expect(200);
    const document = sap.documents.at(-1) as { JournalEntryLines: Array<Record<string, unknown>> };
    expect(document.JournalEntryLines.every((line) => line.FCCurrency === 'USD' && line.Debit === undefined)).toBe(true);
  });

  it('reads the chart of accounts from SAP', async () => {
    const accounts = await api().get('/api/finance/sap/accounts').set(finance.auth).expect(200);
    expect(accounts.body.data.map((item: { code: string }) => item.code)).toContain('210500');
    const status = await api().get('/api/finance/sap/status').set(finance.auth).expect(200);
    expect(status.body.data).toMatchObject({ configured: true, connected: true });
  });

  it('keeps journal posting away from HR', async () => {
    await api().get('/api/finance/journals').set(hr.auth).expect(403);
  });
});

describe('integrations and audit', () => {
  it('issues scoped, revocable API keys for other systems', async () => {
    const created = await api().post('/api/integrations/keys').set(admin.auth)
      .send({ name: 'بوابة الأوصاف الوظيفية', scopes: ['employees.read', 'org.read'] }).expect(201);
    const key = created.body.data.key as string;
    expect(key).toMatch(/^lo_[A-Za-z0-9]{8}_/);

    const employees = await api().get('/api/integrations/v1/employees?pageSize=5').set('X-API-Key', key).expect(200);
    expect(employees.body.data.length).toBeGreaterThan(0);
    expect(JSON.stringify(employees.body)).not.toMatch(/bank|national|salary/i);
    await api().get('/api/integrations/v1/org').set('X-API-Key', key).expect(200);
    await api().get('/api/integrations/v1/attendance-summary?from=2026-09-01&to=2026-09-30').set('X-API-Key', key).expect(403);
    await api().get('/api/integrations/v1/employees').set('X-API-Key', `${key.slice(0, -2)}xx`).expect(401);

    await api().post(`/api/integrations/keys/${created.body.data.id}/revoke`).set(admin.auth).expect(200);
    await api().get('/api/integrations/v1/employees').set('X-API-Key', key).expect(401);
    await api().get('/api/integrations/keys').set(hr.auth).expect(403);
  });

  it('lets auditors search the trail', async () => {
    const result = await api().get('/api/audit?action=payroll.run_approved').set(finance.auth).expect(200);
    expect(result.body.data.length).toBeGreaterThan(0);
    expect(result.body.data.every((row: { action: string }) => row.action === 'payroll.run_approved')).toBe(true);
    await api().get('/api/audit').set(hr.auth).expect(200);
    const viewer = await makeUser('viewer');
    await api().get('/api/audit').set(viewer.auth).expect(403);
  });
});
