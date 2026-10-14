import { beforeAll, describe, expect, it } from 'vitest';
import { select, selectOne } from '../src/db/query';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

let hr: Awaited<ReturnType<typeof makeUser>>;
let admin: Awaited<ReturnType<typeof makeUser>>;
let branchId: string;

beforeAll(async () => {
  admin = await makeUser('super_admin');
  hr = await makeUser('hr_manager');
  branchId = (await makeBranch('فرع الكرادة')).id;
});

describe('organization structure', () => {
  it('builds a department tree and refuses cycles', async () => {
    const root = await api().post('/api/org/departments').set(hr.auth)
      .send({ code: 'sales', name: 'المبيعات', costCenterCode: 'CC-SALES' }).expect(201);
    const child = await api().post('/api/org/departments').set(hr.auth)
      .send({ code: 'sales-used', name: 'مبيعات المستعمل', parentId: root.body.data.id }).expect(201);
    await api().put(`/api/org/departments/${root.body.data.id}`).set(hr.auth)
      .send({ parentId: child.body.data.id }).expect(409);
    const list = await api().get('/api/org/departments').set(hr.auth).expect(200);
    const saved = list.body.data.find((item: { code: string }) => item.code === 'SALES');
    expect(saved.costCenterCode).toBe('CC-SALES');
  });

  it('rejects codes with unsafe characters', async () => {
    await api().post('/api/org/departments').set(hr.auth).send({ code: 'a b;', name: 'خطأ' }).expect(400);
  });

  it('only lets org.manage holders change the structure', async () => {
    const viewer = await makeUser('viewer');
    await api().post('/api/org/job-titles').set(viewer.auth).send({ code: 'X', name: 'X' }).expect(403);
  });

  it('creates an employee from department and job title and keeps labels in sync', async () => {
    const department = await api().post('/api/org/departments').set(hr.auth).send({ code: 'svc', name: 'الصيانة' }).expect(201);
    const title = await api().post('/api/org/job-titles').set(hr.auth)
      .send({ code: 'tech', name: 'فني صيانة', departmentId: department.body.data.id, grade: 'G3' }).expect(201);
    const created = await api().post('/api/employees').set(hr.auth).send({
      employeeNo: 'L-1001', fullName: 'علي حسن', branchId, hireDate: '2025-02-01',
      departmentId: department.body.data.id, jobTitleId: title.body.data.id, employmentType: 'probation', attendancePin: '1001',
    }).expect(201);
    expect(created.body.data.department).toBe('الصيانة');
    expect(created.body.data.position).toBe('فني صيانة');

    await api().put(`/api/org/job-titles/${title.body.data.id}`).set(hr.auth).send({ name: 'فني صيانة أول' }).expect(200);
    const detail = await api().get(`/api/employees/${created.body.data.id}`).set(hr.auth).expect(200);
    expect(detail.body.data.position).toBe('فني صيانة أول');
    expect(detail.body.data.employmentType).toBe('probation');
  });

  it('refuses a reporting line that loops', async () => {
    const boss = await makeEmployee(branchId);
    const report = await makeEmployee(branchId, { managerId: boss.id });
    await api().put(`/api/employees/${boss.id}`).set(hr.auth).send({ managerId: report.id }).expect(409);
  });

  it('keeps branch managers away from fields that change pay', async () => {
    const manager = await makeUser('branch_manager', branchId);
    const employee = await makeEmployee(branchId);
    await api().put(`/api/employees/${employee.id}`).set(manager.auth).send({ hireDate: '2020-01-01' }).expect(403);
    await api().put(`/api/employees/${employee.id}`).set(manager.auth).send({ phone: '07700000000' }).expect(200);
  });

  it('hides employees of other branches from branch managers', async () => {
    const otherBranch = await makeBranch('فرع آخر');
    const outsider = await makeEmployee(otherBranch.id);
    const manager = await makeUser('branch_manager', branchId);
    await api().get(`/api/employees/${outsider.id}`).set(manager.auth).expect(404);
  });
});

describe('employee file', () => {
  it('encrypts identity and bank numbers at rest and masks the account without pay rights', async () => {
    const employee = await makeEmployee(branchId);
    await api().put(`/api/employees/${employee.id}/profile`).set(hr.auth).send({
      nationalIdNo: '199012345678', gender: 'male', bloodType: 'O+', maritalStatus: 'married', dependentsCount: 2,
    }).expect(200);
    // HR managers lack compensation.manage? They have it by default, so set bank details as HR.
    await api().put(`/api/employees/${employee.id}/profile`).set(hr.auth).send({
      paymentMethod: 'bank', bankName: 'مصرف الرافدين', bankAccountNo: 'IQ00RAFD1234567890',
    }).expect(200);

    const raw = await selectOne<{ national: string; bank: string }>(
      'SELECT national_id_no AS national, bank_account_no AS bank FROM employee_profiles WHERE employee_id = :id',
      { id: employee.id },
    );
    expect(raw!.national.startsWith('enc:v1:')).toBe(true);
    expect(raw!.bank).not.toContain('1234567890');

    const full = await api().get(`/api/employees/${employee.id}/profile`).set(hr.auth).expect(200);
    expect(full.body.data.nationalIdNo).toBe('199012345678');
    expect(full.body.data.bankAccountNo).toBe('IQ00RAFD1234567890');

    const staff = await makeUser('hr_staff');
    const limited = await api().get(`/api/employees/${employee.id}/profile`).set(staff.auth).expect(200);
    expect(limited.body.data.bankAccountNo).toBe('••••7890');
    await api().put(`/api/employees/${employee.id}/profile`).set(staff.auth).send({ bankAccountNo: 'X' }).expect(403);

    const audit = await select<{ details: { changes: Record<string, unknown> } }>(
      `SELECT details FROM audit_logs WHERE entity_id = :id AND action = 'employee.profile_updated' ORDER BY created_at`,
      { id: employee.id },
    );
    expect(JSON.stringify(audit)).not.toContain('199012345678');
  });

  it('accepts real PDFs, rejects disguised files and records downloads', async () => {
    const employee = await makeEmployee(branchId);
    await api().post(`/api/employees/${employee.id}/documents`).set(hr.auth)
      .field('docType', 'contract').field('title', 'ملف تنفيذي')
      .attach('file', Buffer.from('MZ\x90\x00 not a pdf'), { filename: 'contract.pdf', contentType: 'application/pdf' })
      .expect(400);

    const uploaded = await api().post(`/api/employees/${employee.id}/documents`).set(hr.auth)
      .field('docType', 'national_id').field('title', 'البطاقة الوطنية').field('expiryDate', '2026-12-31')
      .attach('file', PDF, { filename: 'البطاقة.pdf', contentType: 'application/pdf' })
      .expect(201);
    const documentId = uploaded.body.data.id;

    const download = await api().get(`/api/documents/${documentId}/file`).set(hr.auth).expect(200);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(download.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('البطاقة.pdf')}`);

    const viewed = await selectOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs WHERE action = 'employee.document_viewed' AND entity_id = :id`,
      { id: employee.id },
    );
    expect(viewed!.count).toBe(1);

    await api().delete(`/api/documents/${documentId}`).set(hr.auth).expect(200);
    await api().get(`/api/documents/${documentId}/file`).set(hr.auth).expect(404);
  });

  it('stores a photo and serves it back', async () => {
    const employee = await makeEmployee(branchId);
    await api().post(`/api/employees/${employee.id}/photo`).set(hr.auth)
      .attach('file', PNG, { filename: 'me.png', contentType: 'image/png' }).expect(201);
    const photo = await api().get(`/api/employees/${employee.id}/photo`).set(hr.auth).expect(200);
    expect(photo.headers['content-type']).toBe('image/png');
  });

  it('issues a card whose public check reveals no personal data and stops working once reissued', async () => {
    const employee = await makeEmployee(branchId, { fullName: 'زينب كريم', phone: '07801112233' });
    const first = await api().post(`/api/employees/${employee.id}/card`).set(hr.auth).expect(201);
    const verified = await api().get(`/api/public/cards/${first.body.data.cardToken}`).expect(200);
    expect(verified.body.data.fullName).toBe('زينب كريم');
    expect(verified.body.data.valid).toBe(true);
    expect(JSON.stringify(verified.body)).not.toContain('07801112233');

    const listed = await api().get('/api/employees?pageSize=200').set(admin.auth).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(first.body.data.cardToken);

    const second = await api().post(`/api/employees/${employee.id}/card`).set(hr.auth).expect(201);
    await api().get(`/api/public/cards/${first.body.data.cardToken}`).expect(404);
    await api().get(`/api/public/cards/${second.body.data.cardToken}`).expect(200);
  });

  it('records salary history with a reason', async () => {
    const employee = await makeEmployee(branchId);
    await api().post(`/api/employees/${employee.id}/compensation`).set(hr.auth)
      .send({ effectiveFrom: '2025-01-01', grossSalary: 1200000 }).expect(400);
    await api().post(`/api/employees/${employee.id}/compensation`).set(hr.auth)
      .send({ effectiveFrom: '2025-01-01', grossSalary: 1200000, reason: 'راتب التعيين' }).expect(201);
    const history = await api().get(`/api/employees/${employee.id}/compensation`).set(hr.auth).expect(200);
    expect(history.body.data[0].grossSalary).toBe(1200000);
    expect(history.body.data[0].currency).toBe('IQD');
  });

  it('lists documents and probations that are about to expire', async () => {
    const employee = await makeEmployee(branchId);
    const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    await api().post(`/api/employees/${employee.id}/contracts`).set(hr.auth)
      .send({ contractType: 'probation', startsOn: '2025-01-01', probationEndsOn: soon }).expect(201);
    const alerts = await api().get('/api/hr/alerts?days=30').set(hr.auth).expect(200);
    expect(alerts.body.data.contracts.some((item: { employeeId: string; kind: string }) =>
      item.employeeId === employee.id && item.kind === 'probation')).toBe(true);
  });
});
