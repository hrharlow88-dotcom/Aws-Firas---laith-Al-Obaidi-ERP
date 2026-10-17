import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { execute, selectOne } from '../src/db/query';
import { runHrReminders } from '../src/services/hrReminders';
import { parseInstructions } from '../src/services/aiAttendance';
import { proposeHolidays } from '../src/controllers/HolidayController';
import { invalidateSettingsCache } from '../src/services/settings';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

const BAGHDAD = '70000000-0000-4000-8000-000000000001';
const ERBIL = '70000000-0000-4000-8000-000000000003';

const YEAR = 2040 + Math.floor(Math.random() * 50);

describe('governorates and the dollar bulletin', () => {
  it('runs payroll per governorate, refuses overlaps, and shows each line in dinars and dollars', async () => {
    const owner = await makeUser('super_admin');
    const hr = await makeUser('hr_manager');
    const branch = await makeBranch('فرع أربيل للاختبار');
    await api().put(`/api/branches/${branch.id}`).set(owner.auth).send({ governorateId: ERBIL }).expect(200);
    const list = await api().get('/api/governorates').set(hr.auth).expect(200);
    const erbil = list.body.data.governorates.find((row: { id: string }) => row.id === ERBIL);
    expect(erbil.branches.some((row: { id: string }) => row.id === branch.id)).toBe(true);

    await api().post('/api/exchange-rates').set(hr.auth).send({ date: '2026-07-30', rate: 1310 }).expect(200);
    await api().post('/api/exchange-rates').set(hr.auth).send({ date: '2026-07-31', rate: 1320 }).expect(200);
    const rates = await api().get('/api/exchange-rates').set(hr.auth).expect(200);
    expect(rates.body.data.latest.rate).toBe(1320);
    expect(rates.body.data.change).toBe(10);
    await api().post('/api/exchange-rates').set(hr.auth).send({ rate: 5 }).expect(400);

    const run = await api().post('/api/payroll/runs').set(hr.auth).send({ period: `${YEAR}-07`, governorateId: ERBIL, currency: 'USD' }).expect(201);
    await api().post('/api/payroll/runs').set(hr.auth).send({ period: `${YEAR}-07`, branchId: branch.id, currency: 'USD' }).expect(409);
    await api().post('/api/payroll/runs').set(hr.auth).send({ period: `${YEAR}-07`, governorateId: BAGHDAD, currency: 'USD' }).expect(201);
    const detail = await api().get(`/api/payroll/runs/${run.body.data.id}`).set(hr.auth).expect(200);
    expect(detail.body.data.run?.governorateName ?? detail.body.data.governorateName ?? detail.body.data.summary?.governorateName).toBeDefined();
    const register = await api().get(`/api/payroll/register?period=${YEAR}-07`).set(hr.auth).expect(200);
    expect(register.body.data.rate.rate).toBe(1320);
    expect(Array.isArray(register.body.data.groups)).toBe(true);
  });
});

describe('foreign employees and HR reminders', () => {
  it('keeps passport and residency, and reminds once before they expire', async () => {
    const hr = await makeUser('hr_manager');
    const branch = await makeBranch('فرع الأجانب');
    const employee = await makeEmployee(branch.id, { fullName: 'John Smith' });
    const staff = await makeUser('employee', null, employee.id);
    const soon = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
    await api().put(`/api/employees/${employee.id}/profile`).set(hr.auth)
      .send({ residencyStatus: 'foreign', nationality: 'British', passportNo: 'P1234567', passportExpiry: later, residencyType: 'إقامة عمل', residencyExpiry: soon })
      .expect(200);
    const profile = await api().get(`/api/employees/${employee.id}/profile`).set(hr.auth).expect(200);
    expect(profile.body.data).toMatchObject({ residencyStatus: 'foreign', passportNo: 'P1234567' });
    const raw = await selectOne<{ passport: string }>('SELECT passport_no AS passport FROM employee_profiles WHERE employee_id = :id', { id: employee.id });
    expect(raw!.passport).not.toContain('P1234567');
    const first = await runHrReminders();
    expect(first.passport).toBeGreaterThanOrEqual(1);
    expect(first.residency).toBeGreaterThanOrEqual(1);
    const second = await runHrReminders();
    expect(second.passport ?? 0).toBe(0);
    const notice = await selectOne("SELECT 1 FROM notifications WHERE user_id = :id AND kind = 'document'", { id: staff.user.id });
    expect(notice).not.toBeNull();
  });
});

describe('holidays and compensatory leave', () => {
  it('proposes the year, confirms a holiday, and credits compensatory leave apart from annual leave', async () => {
    const owner = await makeUser('super_admin');
    const proposals = proposeHolidays(2027);
    expect(proposals.some((item) => item.date === '2027-01-01')).toBe(true);
    expect(proposals.some((item) => item.source === 'hijri' && item.nameAr.startsWith('عيد الفطر'))).toBe(true);
    await api().post('/api/holidays/propose').set(owner.auth).send({ year: 2027 }).expect(200);
    const listed = await api().get('/api/holidays?year=2027').set(owner.auth).expect(200);
    expect(listed.body.data.holidays.every((item: { confirmed: boolean }) => item.confirmed === false)).toBe(true);
    await api().post('/api/holidays/2027-05-01/confirm').set(owner.auth).send({}).expect(200);
    invalidateSettingsCache();
    const branch = await makeBranch('فرع العطلة');
    const employee = await makeEmployee(branch.id);
    await api().post('/api/leaves/comp-credits').set(owner.auth).send({ employeeId: employee.id, workDate: '2027-05-02' }).expect(400);
    await api().post('/api/leaves/comp-credits').set(owner.auth).send({ employeeId: employee.id, workDate: '2027-05-01' }).expect(201);
    await api().post('/api/leaves/comp-credits').set(owner.auth).send({ employeeId: employee.id, workDate: '2027-05-01' }).expect(409);
    const ledger = await selectOne<{ q: number }>(
      "SELECT SUM(quantity)::float AS q FROM leave_ledger_entries WHERE employee_id = :id AND leave_type_id = '40000000-0000-4000-8000-0000000000c1'", { id: employee.id },
    );
    expect(ledger!.q).toBe(1);
  });
});

describe('AI assistant (built-in readers when no key is set)', () => {
  it('turns Arabic attendance instructions into rules the owner applies', async () => {
    const parsed = parseInstructions('التأخير أكثر من 30 دقيقة يخصم ربع يوم. التأخير 120 دقيقة يخصم نصف يوم. الإضافي لا يحتسب أقل من 45 دقيقة. الإضافي يحتسب 1.5 مرة. سماح 60 دقيقة شهرياً');
    expect(parsed.attendanceRules?.lateDayTiers).toEqual([{ minutes: 30, days: 0.25 }, { minutes: 120, days: 0.5 }]);
    expect(parsed.attendanceRules?.overtimeMinimumMinutes).toBe(45);
    expect(parsed.attendanceRules?.lateMonthlyAllowanceMinutes).toBe(60);
    expect(parsed.components?.overtime?.rate).toBe(1.5);
    const owner = await makeUser('super_admin');
    const hr = await makeUser('hr_manager');
    await api().post('/api/ai/attendance').set(hr.auth).send({ instruction: 'x' }).expect(403);
    const job = await api().post('/api/ai/attendance').set(owner.auth).send({ instruction: 'التأخير أكثر من 15 دقيقة يخصم ربع يوم' }).expect(201);
    expect(job.body.data.engine).toBe('rules');
    await api().post(`/api/ai/jobs/${job.body.data.id}/apply`).set(owner.auth).send({}).expect(200);
    invalidateSettingsCache();
    const settings = await api().get('/api/settings').set(owner.auth).expect(200);
    expect(settings.body.data.attendanceRules.lateDayTiers).toEqual([{ minutes: 15, days: 0.25 }]);
    await api().post(`/api/ai/jobs/${job.body.data.id}/apply`).set(owner.auth).send({}).expect(409);
  });

  it('organises an old Excel file into employee cards and salaries after review', async () => {
    const owner = await makeUser('super_admin');
    const branch = await makeBranch('فرع الملف القديم');
    const employee = await makeEmployee(branch.id, { employeeNo: `X${Date.now() % 100000}` });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('الموظفين');
    sheet.addRow(['سجل الموظفين القديم']);
    sheet.addRow(['الرقم الوظيفي', 'الاسم الكامل', 'الجنسية', 'رقم الجواز', 'تاريخ انتهاء الجواز', 'الراتب الإجمالي', 'العملة', 'الفرع']);
    sheet.addRow([employee.employeeNo, 'موظف تجريبي', 'مصري', 'A9988776', '2028-03-01', 1500, 'USD', '']);
    sheet.addRow(['N-NEW-1', 'موظف جديد من الملف', 'عراقية', '', '', 900000, 'IQD', 'فرع الملف القديم']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const preview = await api().post('/api/ai/import').set(owner.auth).attach('file', buffer, 'old.xlsx').expect(201);
    expect(preview.body.data.summary).toMatchObject({ update: 1, create: 1 });
    await api().post(`/api/ai/jobs/${preview.body.data.id}/apply`).set(owner.auth).send({ effectiveFrom: '2026-10-01' }).expect(200);
    const profile = await selectOne<{ status: string; expiry: string }>(
      "SELECT residency_status AS status, to_char(passport_expiry, 'YYYY-MM-DD') AS expiry FROM employee_profiles WHERE employee_id = :id", { id: employee.id },
    );
    expect(profile).toEqual({ status: 'foreign', expiry: '2028-03-01' });
    const pay = await selectOne<{ gross: number; currency: string }>('SELECT gross_salary::float AS gross, currency FROM employee_compensation WHERE employee_id = :id', { id: employee.id });
    expect(pay).toEqual({ gross: 1500, currency: 'USD' });
    expect(await selectOne("SELECT 1 FROM employees WHERE employee_no = 'N-NEW-1'")).not.toBeNull();
    const check = await api().get('/api/hr/documents-check').set(owner.auth).expect(200);
    const row = check.body.data.rows.find((item: { id: string }) => item.id === employee.id);
    expect(row.missing).toContain('passport');
    await api().post('/api/hr/documents-check/rule').set(owner.auth).send({ employeeId: employee.id, docType: 'passport' }).expect(200);
    invalidateSettingsCache();
    const again = await api().get('/api/hr/documents-check').set(owner.auth).expect(200);
    expect(again.body.data.rows.find((item: { id: string }) => item.id === employee.id).missing).not.toContain('passport');
  });
});

describe('apps per user, approvals, expenses, invitations', () => {
  it('limits an account to the apps the owner chose', async () => {
    const owner = await makeUser('super_admin');
    const hr = await makeUser('hr_manager');
    await api().get('/api/attendance/shifts').set(hr.auth).expect(200);
    await api().put(`/api/users/${hr.user.id}/apps`).set(hr.auth).send({ apps: ['payroll'] }).expect(403);
    await api().put(`/api/users/${hr.user.id}/apps`).set(owner.auth).send({ apps: ['payroll'] }).expect(200);
    await api().get('/api/attendance/shifts').set(hr.auth).expect(403);
    await api().get('/api/payroll/runs').set(hr.auth).expect(200);
    await api().put(`/api/users/${hr.user.id}/apps`).set(owner.auth).send({ apps: null }).expect(200);
    await api().get('/api/attendance/shifts').set(hr.auth).expect(200);
  });

  it('sends a request through its approvers and an expense report through to payment', async () => {
    const owner = await makeUser('super_admin');
    const branch = await makeBranch('فرع الموافقات');
    const boss = await makeEmployee(branch.id, { fullName: 'المدير' });
    const worker = await makeEmployee(branch.id, { fullName: 'الموظف', managerId: boss.id });
    const bossUser = await makeUser('line_manager', null, boss.id);
    const workerUser = await makeUser('employee', null, worker.id);
    const finance = await makeUser('finance');
    const categories = await api().get('/api/approval-categories').set(workerUser.auth).expect(200);
    const purchase = categories.body.data.find((row: { code: string }) => row.code === 'BORROW');
    const created = await api().post('/api/approval-requests').set(workerUser.auth)
      .field('categoryId', purchase.id).field('title', 'لابتوب للعمل').field('dateFrom', '2026-11-01').expect(201);
    await api().post(`/api/approval-requests/${created.body.data.id}/decide`).set(finance.auth).send({ decision: 'approved' }).expect(403);
    const todo = await api().get('/api/approval-requests?box=todo').set(bossUser.auth).expect(200);
    expect(todo.body.data.rows.some((row: { id: string }) => row.id === created.body.data.id)).toBe(true);
    await api().post(`/api/approval-requests/${created.body.data.id}/decide`).set(bossUser.auth).send({ decision: 'approved' }).expect(200);
    const done = await api().get(`/api/approval-requests/${created.body.data.id}`).set(workerUser.auth).expect(200);
    expect(done.body.data.status).toBe('approved');

    const report = await api().post('/api/expenses').set(workerUser.auth).send({ title: 'زيارة فرع أربيل', currency: 'IQD' }).expect(201);
    const id = report.body.data.id;
    await api().post(`/api/expenses/${id}/submit`).set(workerUser.auth).expect(400);
    await api().post(`/api/expenses/${id}/lines`).set(workerUser.auth)
      .field('expenseDate', '2026-10-10').field('category', 'وقود ونقل').field('description', 'وقود').field('amount', '50000')
      .attach('file', Buffer.from('%PDF-1.4 receipt'), 'receipt.pdf').expect(201);
    await api().post(`/api/expenses/${id}/submit`).set(workerUser.auth).expect(200);
    await api().post(`/api/expenses/${id}/decide`).set(bossUser.auth).send({ decision: 'approved' }).expect(200);
    await api().post(`/api/expenses/${id}/decide`).set(finance.auth).send({ decision: 'approved' }).expect(200);
    await api().post(`/api/expenses/${id}/pay`).set(finance.auth).send({ mode: 'cash' }).expect(200);
    const paid = await api().get(`/api/expenses/${id}`).set(workerUser.auth).expect(200);
    expect(paid.body.data).toMatchObject({ status: 'paid', amount: 50000 });
    const lineId = paid.body.data.lines[0].id;
    await api().get(`/api/expenses/${id}/lines/${lineId}/file`).set(bossUser.auth).expect(200);
    void owner;
  });

  it('lets the sender edit the invitation text but keeps the one-time link in it', async () => {
    const owner = await makeUser('super_admin');
    const link = `https://erp.example.com/#/set-password/${'a'.repeat(43)}`;
    const preview = await api().post('/api/invites/deliver').set(owner.auth).send({ link, name: 'علي', login: 'ali@example.com', kind: 'staff', channels: [] }).expect(200);
    expect(preview.body.data.body).toContain(link);
    expect(preview.body.data.loginUrl).toBeTruthy();
    await api().post('/api/invites/deliver').set(owner.auth).send({ link, name: 'علي', kind: 'staff', channels: [], customBody: 'نص بلا رابط' }).expect(400);
    const edited = await api().post('/api/invites/deliver').set(owner.auth).send({ link, name: 'علي', kind: 'staff', channels: [], customBody: `أهلاً علي، ادخل من هنا: ${link}` }).expect(200);
    expect(edited.body.data.body).toBe(`أهلاً علي، ادخل من هنا: ${link}`);
    await api().put('/api/users/me/notifications').set(owner.auth).send({ notifyEmail: true, personalEmail: 'aws@example.com' }).expect(200);
    await execute("UPDATE users SET notify_email = false WHERE id = :id", { id: owner.user.id });
  });
});
