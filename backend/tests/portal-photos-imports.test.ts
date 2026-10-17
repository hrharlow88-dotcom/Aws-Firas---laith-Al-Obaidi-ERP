import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LeaveTypeSetting, SystemSettings } from '../src/config/systemSettings';
import { execute, select, selectOne } from '../src/db/query';
import { computeDay, ShiftRule } from '../src/services/attendanceRules';
import { guessType } from '../src/services/fingerprintImport';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const ANNUAL_ID = '40000000-0000-4000-8000-0000000000f1';
const SICK_ID = '40000000-0000-4000-8000-0000000000f2';
const HOURLY_ID = '40000000-0000-4000-8000-0000000000f3';
const TYPES: LeaveTypeSetting[] = [
  { id: ANNUAL_ID, name: 'إجازة اعتيادية (استيراد)', unit: 'days', paid: true, active: true, annualEntitlement: 21, carryForwardLimit: null },
  { id: SICK_ID, name: 'إجازة مرضية (استيراد)', unit: 'days', paid: true, active: true, annualEntitlement: null, carryForwardLimit: null, deductsBalance: false },
  { id: HOURLY_ID, name: 'إجازة زمنية (استيراد)', unit: 'hours', paid: true, active: true, annualEntitlement: null, carryForwardLimit: null },
];

let owner: Awaited<ReturnType<typeof makeUser>>;
let hr: Awaited<ReturnType<typeof makeUser>>;
let original: SystemSettings;
let branchId: string;
let branchName: string;
let shiftId: string;

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function setSettings(patch: (current: SystemSettings) => SystemSettings) {
  const current = (await api().get('/api/settings').set(owner.auth).expect(200)).body.data as SystemSettings;
  await api().put('/api/settings').set(owner.auth).send(patch(current)).expect(200);
}

beforeAll(async () => {
  owner = await makeUser('super_admin');
  hr = await makeUser('hr_manager');
  original = (await api().get('/api/settings').set(owner.auth).expect(200)).body.data;
  await setSettings((current) => ({ ...current, leaveTypes: [...current.leaveTypes.filter((type) => !TYPES.some((item) => item.id === type.id)), ...TYPES] }));
  branchName = `فرع الاستيراد ${randomUUID().slice(0, 4)}`;
  branchId = (await makeBranch(branchName)).id;
  const governorate = await selectOne<{ id: string }>("SELECT id FROM governorates WHERE code = 'BGD'");
  await execute('UPDATE branches SET governorate_id = :governorateId WHERE id = :id', { governorateId: governorate!.id, id: branchId });
  shiftId = (await api().post('/api/attendance/shifts').set(owner.auth).send({
    code: `IMP-${randomUUID().slice(0, 4)}`, name: 'دوام الاستيراد', startTime: '08:00', endTime: '16:00', breakMinutes: 0,
    graceMinutes: 10, earlyLeaveGraceMinutes: 5, workingDays: [0, 1, 2, 3, 4, 6], isDefault: false,
  }).expect(201)).body.data.id;
});

afterAll(async () => {
  await api().put('/api/settings').set(owner.auth).send(original).expect(200);
});

describe('owner control of the employee portal', () => {
  it('hides what the owner switched off and the server refuses it', async () => {
    const manager = await makeEmployee(branchId, { fullName: 'مدير البوابة' });
    const employee = await makeEmployee(branchId, { fullName: 'موظف خيارات البوابة', managerId: manager.id });
    const self = await makeUser('employee', null, employee.id);

    await api().get('/api/me/payslips').set(self.auth).expect(200);
    expect((await api().get('/api/me/profile').set(self.auth).expect(200)).body.data.managerName).toBe('مدير البوابة');

    await setSettings((current) => ({ ...current, portal: { ...current.portal, payslips: false, leaveRequests: false, showManager: false, welcome: 'أهلاً بكم' } }));
    await api().get('/api/me/payslips').set(self.auth).expect(403);
    expect((await api().get('/api/me/profile').set(self.auth).expect(200)).body.data.managerName).toBeNull();
    const refused = await api().post('/api/leaves').set(self.auth)
      .send({ employeeId: employee.id, leaveTypeId: ANNUAL_ID, startsOn: '2031-01-05', endsOn: '2031-01-05', reason: 'سفر' });
    expect(refused.status).toBe(403);
    // HR still records leave for the employee; the switch is about the portal.
    const byHr = await api().post('/api/leaves').set(hr.auth)
      .send({ employeeId: employee.id, leaveTypeId: ANNUAL_ID, startsOn: '2031-01-05', endsOn: '2031-01-05', reason: 'سفر' });
    expect(byHr.status).not.toBe(403);

    // What a plain account receives of the settings.
    const seen = (await api().get('/api/settings').set(self.auth).expect(200)).body.data;
    expect(seen.portal).toMatchObject({ payslips: false, welcome: 'أهلاً بكم' });
    expect(Object.keys(seen.security).sort()).toEqual(['askLocationOnLogin', 'idleMinutes']);
    expect(seen.roles.hr_manager.permissions).toEqual([]);
    expect(seen.roles.employee.permissions).toContain('self.service');
    expect((await api().get('/api/settings').set(owner.auth).expect(200)).body.data.security.failedLoginAlertThreshold).toBeDefined();

    await api().put('/api/settings').set(owner.auth).send({ ...original, portal: { ...original.portal, bogus: true } }).expect(400);
    await setSettings((current) => ({ ...current, portal: original.portal }));
    await api().get('/api/me/payslips').set(self.auth).expect(200);
  });
});

describe('employee photos', () => {
  it('takes photos sent from the portal into the file, one click for all', async () => {
    const first = await makeEmployee(branchId, { fullName: 'صاحب الصورة الأولى' });
    const second = await makeEmployee(branchId, { fullName: 'صاحب الصورة الثانية' });
    const one = await makeUser('employee', null, first.id);
    const two = await makeUser('employee', null, second.id);

    await api().post('/api/me/photo').set(one.auth).attach('file', Buffer.from('not an image'), 'a.png').expect(400);
    await api().post('/api/me/photo').set(one.auth).attach('file', PNG, 'me.png').expect(201);
    await api().post('/api/me/photo').set(two.auth).attach('file', PNG, 'me.png').expect(201);
    // A newer photo replaces the one still waiting.
    await api().post('/api/me/photo').set(two.auth).attach('file', PNG, 'me-again.png').expect(201);
    expect((await api().get('/api/me/photo').set(two.auth).expect(200)).body.data.status).toBe('pending');
    await api().get('/api/employees/photo-submissions').set(one.auth).expect(403);

    const waiting = (await api().get('/api/employees/photo-submissions').set(hr.auth).expect(200)).body.data
      .filter((row: { employeeId: string }) => [first.id, second.id].includes(row.employeeId));
    expect(waiting).toHaveLength(2);
    await api().get(`/api/employees/photo-submissions/${waiting[0].id}/file`).set(hr.auth).expect(200);

    const rejected = waiting.find((row: { employeeId: string }) => row.employeeId === second.id);
    await api().post(`/api/employees/photo-submissions/${rejected.id}/reject`).set(hr.auth).send({}).expect(400);
    await api().post(`/api/employees/photo-submissions/${rejected.id}/reject`).set(hr.auth).send({ note: 'الصورة غير واضحة' }).expect(200);
    expect((await api().get('/api/me/photo').set(two.auth)).body.data).toMatchObject({ status: 'rejected', decisionNote: 'الصورة غير واضحة' });

    const accepted = await api().post('/api/employees/photo-submissions/accept').set(hr.auth).send({}).expect(200);
    expect(accepted.body.data.accepted).toBeGreaterThanOrEqual(1);
    const row = await selectOne<{ photo: string | null }>('SELECT photo_document_id AS photo FROM employees WHERE id = :id', { id: first.id });
    expect(row?.photo).toBeTruthy();
    await api().get(`/api/employees/${first.id}/photo`).set(one.auth).expect(200);
    expect((await api().get('/api/me/photo').set(one.auth)).body.data.status).toBe('accepted');

    // The owner can close photo uploads in the portal.
    await setSettings((current) => ({ ...current, portal: { ...current.portal, photoUpload: false } }));
    await api().post('/api/me/photo').set(one.auth).attach('file', PNG, 'me.png').expect(403);
    await setSettings((current) => ({ ...current, portal: original.portal }));
  });

  it('matches bulk photo files to employees by number or fingerprint number', async () => {
    const employee = await makeEmployee(branchId, { employeeNo: `PH${Date.now() % 100000}`, attendancePin: `9${Date.now() % 10000}` });
    const matched = await api().post('/api/employees/photos/match').set(hr.auth)
      .send({ names: [`${employee.employeeNo}.jpg`, `${employee.attendancePin} - name.png`, 'nobody.png'] }).expect(200);
    expect(matched.body.data.map((item: { employee: { id: string } | null }) => item.employee?.id ?? null)).toEqual([employee.id, employee.id, null]);
  });
});

describe('employee master sheet', () => {
  it('updates fingerprint numbers, contacts and salary and adds new employees after a preview', async () => {
    const departmentName = `مبيعات الاستيراد ${Date.now() % 1000}`;
    const titleName = `مندوب استيراد ${Date.now() % 1000}`;
    const department = { name: departmentName, id: (await api().post('/api/org/departments').set(owner.auth).send({ code: `IMPD${Date.now() % 10000}`, name: departmentName }).expect(201)).body.data.id };
    const title = { name: titleName, id: (await api().post('/api/org/job-titles').set(owner.auth).send({ code: `IMPT${Date.now() % 10000}`, name: titleName }).expect(201)).body.data.id };
    const suffix = String(Date.now() % 100000);
    const existing = await makeEmployee(branchId, { employeeNo: `M${suffix}`, fullName: 'موظف الإكسل الحالي' });
    const header = ['رقم الموظف', 'الاسم بالعربي', 'الاسم بالإنكليزي', 'رقم البصمة', 'البريد الشخصي', 'الهاتف الشخصي', 'القسم', 'المسمى الوظيفي', 'المحافظة', 'الفرع', 'تاريخ المباشرة', 'الراتب', 'العملة'];
    const update = [`M${suffix}`, 'موظف الإكسل الحالي', 'Excel Current', `00${suffix}1`, 'Current@Example.com', '0770 123 4567', '', '', '', '', '', '1,500,000', 'IQD'];
    const create = [`N${suffix}`, 'موظف جديد من الإكسل', 'New From Excel', `${suffix}2`, 'new@example.com', '+964 750 111 2222', department.name, title.name, 'بغداد', branchName, '2026-09-01', '900', 'USD'];
    const broken = [`X${suffix}`, 'سطر ناقص', '', '', 'not-an-email', '', '', '', '', '', '', '', ''];

    const withError = await xlsx([header, update, create, broken]);
    const preview = await api().post('/api/employees/import/preview').set(hr.auth).attach('file', withError, 'staff.xlsx').expect(200);
    expect(preview.body.data.summary).toMatchObject({ create: 1, update: 1, errors: 1 });
    const brokenRow = preview.body.data.rows.find((row: { employeeNo: string }) => row.employeeNo === `X${suffix}`);
    expect(brokenRow.errors.join(' ')).toContain('البريد');
    await api().post('/api/employees/import/apply').set(hr.auth).attach('file', withError, 'staff.xlsx').expect(400);

    const clean = await xlsx([['قائمة الموظفين'], header, update, create]);
    const applied = await api().post('/api/employees/import/apply').set(hr.auth).attach('file', clean, 'staff.xlsx').expect(200);
    expect(applied.body.data).toMatchObject({ created: 1, updated: 1, salaries: 2 });

    const now = await selectOne<Record<string, string>>(
      `SELECT e.attendance_pin AS pin, e.email, e.phone, p.name_en AS "nameEn" FROM employees e
       LEFT JOIN employee_profiles p ON p.employee_id = e.id WHERE e.id = :id`, { id: existing.id },
    );
    expect(now).toMatchObject({ pin: `${suffix}1`, email: 'current@example.com', phone: '07701234567', nameEn: 'Excel Current' });
    const added = await selectOne<Record<string, string>>(
      `SELECT e.id, e.department_id AS "departmentId", e.job_title_id AS "jobTitleId", e.branch_id AS "branchId", e.phone,
              to_char(e.hire_date, 'YYYY-MM-DD') AS "hireDate", p.name_en AS "nameEn"
       FROM employees e LEFT JOIN employee_profiles p ON p.employee_id = e.id WHERE e.employee_no = :no`, { no: `N${suffix}` },
    );
    expect(added).toMatchObject({ departmentId: department.id, jobTitleId: title.id, branchId, phone: '+9647501112222', hireDate: '2026-09-01', nameEn: 'New From Excel' });
    const salaries = await select<{ employeeId: string; gross: number; currency: string; from: string }>(
      `SELECT employee_id AS "employeeId", gross_salary::float AS gross, currency, to_char(effective_from, 'YYYY-MM-DD') AS from
       FROM employee_compensation WHERE employee_id IN (:ids)`, { ids: [existing.id, added!.id] },
    );
    expect(salaries.find((item) => item.employeeId === added!.id)).toMatchObject({ gross: 900, currency: 'USD', from: '2026-09-01' });
    expect(salaries.find((item) => item.employeeId === existing.id)).toMatchObject({ gross: 1500000, currency: 'IQD' });

    // The same sheet again changes nothing.
    const again = await api().post('/api/employees/import/preview').set(hr.auth).attach('file', clean, 'staff.xlsx').expect(200);
    expect(again.body.data.summary).toMatchObject({ create: 0, update: 0, unchanged: 2, errors: 0 });
    await api().post('/api/employees/import/apply').set(hr.auth).attach('file', clean, 'staff.xlsx').expect(400);

    // A fingerprint number belongs to one person.
    const clash = await xlsx([['رقم الموظف', 'رقم البصمة'], [`M${suffix}`, `${suffix}2`]]);
    const clashPreview = await api().post('/api/employees/import/preview').set(hr.auth).attach('file', clash, 'pins.xlsx').expect(200);
    expect(clashPreview.body.data.summary.errors).toBeGreaterThan(0);

    // Someone without salary rights cannot change salaries through the sheet.
    const staff = await makeUser('hr_staff');
    const raise = await xlsx([['رقم الموظف', 'الراتب'], [`M${suffix}`, '2000000']]);
    const refused = await api().post('/api/employees/import/preview').set(staff.auth).attach('file', raise, 'raise.xlsx').expect(200);
    expect(refused.body.data.rows[0].errors.join(' ')).toContain('صلاحية');

    const template = await api().get('/api/employees/import/template.xlsx').set(hr.auth).buffer(true)
      .parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks))); })
      .expect(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(template.body);
    const headers = (workbook.worksheets[0].getRow(1).values as string[]).filter(Boolean);
    expect(headers).toEqual(expect.arrayContaining(['رقم البصمة', 'البريد الشخصي', 'الهاتف الشخصي', 'الراتب', 'المحافظة']));
  });
});

describe('fingerprint files', () => {
  it('reads the attendance export by fingerprint number, name and date', async () => {
    const suffix = String(Date.now() % 10000);
    const known = await makeEmployee(branchId, { fullName: 'سارة حضور الملف', attendancePin: `71${suffix}`, shiftId, hireDate: '2026-01-01' });
    const byName = await makeEmployee(branchId, { fullName: 'كريم بلا رقم بصمة', shiftId, hireDate: '2026-01-01' });
    const file = await xlsx([
      ['تقرير الحضور 01/09/2026 - 30/09/2026'],
      [],
      ['No.', 'Name', 'Date', 'Clock In', 'Clock Out'],
      [`71${suffix}`, 'سارة حضور الملف', '06/09/2026', '07:58', '16:05'],
      [`71${suffix}`, 'سارة حضور الملف', '07/09/2026', '08:25', '16:00'],
      [`72${suffix}`, 'كريم بلا رقم بصمة', '06/09/2026', '08:00', '16:10'],
      [`79${suffix}`, 'شخص غير معروف', '06/09/2026', '08:00', '16:00'],
      [`71${suffix}`, 'سارة حضور الملف', '08/09/2026', '', ''],
    ]);
    const preview = await api().post('/api/attendance/files/preview').set(hr.auth)
      .field('kind', 'attendance').attach('file', file, 'att.xlsx').expect(200);
    const data = preview.body.data;
    expect(data.headerIndex).toBe(1);
    expect(data.summary).toMatchObject({ ok: 3, unmatched: 1, skip: 1, pinsToSave: 1, punches: 8 });
    expect(data.rows.find((row: { name: string }) => row.name === 'كريم بلا رقم بصمة').warnings.join(' ')).toContain('سيُحفظ رقم البصمة');

    const applied = await api().post('/api/attendance/files/apply').set(hr.auth)
      .field('kind', 'attendance').attach('file', file, 'att.xlsx').expect(201);
    expect(applied.body.data).toMatchObject({ imported: 8, unmatched: 2, pinsSaved: 1 });
    expect((await selectOne<{ pin: string }>('SELECT attendance_pin AS pin FROM employees WHERE id = :id', { id: byName.id }))?.pin).toBe(`72${suffix}`);
    const days = await select<{ date: string; status: string; late: number }>(
      `SELECT to_char(work_date, 'YYYY-MM-DD') AS date, status, late_minutes AS late FROM attendance_days
       WHERE employee_id = :id AND work_date BETWEEN '2026-09-06' AND '2026-09-07' ORDER BY work_date`, { id: known.id },
    );
    expect(days).toEqual([{ date: '2026-09-06', status: 'present', late: 0 }, { date: '2026-09-07', status: 'present', late: 25 }]);
    const again = await api().post('/api/attendance/files/apply').set(hr.auth)
      .field('kind', 'attendance').attach('file', file, 'att.xlsx').expect(201);
    expect(again.body.data.imported).toBe(0);
  });

  it('imports approved leave of every type and skips what is already recorded', async () => {
    const suffix = String(Date.now() % 10000);
    const employee = await makeEmployee(branchId, { fullName: 'ليلى إجازات الملف', attendancePin: `81${suffix}`, shiftId, hireDate: '2026-01-01' });
    const pin = `81${suffix}`;
    const csv = [
      'رقم البصمة,الاسم,نوع الإجازة,من تاريخ,إلى تاريخ,الحالة',
      `${pin},ليلى إجازات الملف,اعتيادية,2026-09-13,2026-09-14,موافق`,
      `${pin},ليلى إجازات الملف,مرضية,2026-09-15,2026-09-15,`,
      `${pin},ليلى إجازات الملف,زمنية,2026-09-16 09:00,2026-09-16 11:00,approved`,
      `${pin},ليلى إجازات الملف,اعتيادية,2026-09-14,2026-09-14,موافق`,
      `${pin},ليلى إجازات الملف,اعتيادية,2026-09-20,2026-09-20,مرفوض`,
      '88888,شخص غير موجود,اعتيادية,2026-09-13,2026-09-13,موافق',
    ].join('\n');
    const typeMap = JSON.stringify({ 'اعتيادية': ANNUAL_ID, 'مرضية': SICK_ID, 'زمنية': HOURLY_ID });
    const preview = await api().post('/api/attendance/files/preview').set(hr.auth)
      .field('kind', 'leaves').field('typeMap', typeMap).attach('file', Buffer.from(csv), 'leaves.csv').expect(200);
    expect(preview.body.data.leaveTypes.map((item: { name: string }) => item.name).sort()).toEqual(['اعتيادية', 'زمنية', 'مرضية']);
    expect(preview.body.data.summary).toMatchObject({ ok: 3, duplicate: 1, skip: 1, error: 1, days: 3, hours: 2 });

    const applied = await api().post('/api/attendance/files/apply').set(hr.auth)
      .field('kind', 'leaves').field('typeMap', typeMap).attach('file', Buffer.from(csv), 'leaves.csv').expect(201);
    expect(applied.body.data.leaves).toBe(3);
    const leaves = await select<{ type: string; status: string; source: string; quantity: string }>(
      `SELECT leave_type_id AS type, status::text, source, quantity::text FROM leave_requests WHERE employee_id = :id ORDER BY starts_on`, { id: employee.id },
    );
    expect(leaves.map((item) => `${item.type}|${item.status}|${item.source}|${item.quantity}`)).toEqual([
      `${ANNUAL_ID}|approved|import|2.00`, `${SICK_ID}|approved|import|1.00`, `${HOURLY_ID}|approved|import|2.00`,
    ]);
    const ledger = await select<{ type: string; quantity: string }>(
      `SELECT leave_type_id AS type, quantity::text FROM leave_ledger_entries WHERE employee_id = :id ORDER BY leave_type_id`, { id: employee.id },
    );
    expect(ledger.map((item) => `${item.type}|${item.quantity}`).sort()).toEqual([`${ANNUAL_ID}|-2.00`, `${HOURLY_ID}|-2.00`].sort());
    const day = await selectOne<{ status: string }>(`SELECT status FROM attendance_days WHERE employee_id = :id AND work_date = '2026-09-13'`, { id: employee.id });
    expect(day?.status).toBe('leave');

    // The same file again: everything is already recorded.
    await api().post('/api/attendance/files/apply').set(hr.auth)
      .field('kind', 'leaves').field('typeMap', typeMap).attach('file', Buffer.from(csv), 'leaves.csv').expect(400);

    // Nobody imports their own leave.
    const self = await makeUser('hr_manager', null, employee.id);
    const own = await api().post('/api/attendance/files/preview').set(self.auth)
      .field('kind', 'leaves').field('typeMap', typeMap).attach('file', Buffer.from(csv), 'leaves.csv').expect(200);
    expect(own.body.data.rows.filter((row: { note: string | null }) => row.note === 'إجازتك يستوردها موظف آخر').length).toBeGreaterThan(0);
  });

  it('records external tasks from the app and counts those days as worked', async () => {
    const suffix = String(Date.now() % 10000);
    const employee = await makeEmployee(branchId, { fullName: 'حسن مهام الملف', attendancePin: `91${suffix}`, shiftId, hireDate: '2026-01-01' });
    const file = await xlsx([
      ['رقم البصمة', 'الاسم', 'التاريخ', 'من الساعة', 'إلى الساعة', 'المهمة', 'الموقع'],
      [`91${suffix}`, 'حسن مهام الملف', '2026-09-17', '08:30', '15:30', 'زيارة عميل', 'الكرادة'],
      [`91${suffix}`, 'حسن مهام الملف', '2026-09-19', '', '', 'تدريب خارجي', 'أربيل'],
    ]);
    const preview = await api().post('/api/attendance/files/preview').set(hr.auth)
      .field('kind', 'tasks').attach('file', file, 'tasks.xlsx').expect(200);
    expect(preview.body.data.summary).toMatchObject({ ok: 2, tasks: 2, punches: 2 });
    const applied = await api().post('/api/attendance/files/apply').set(hr.auth)
      .field('kind', 'tasks').attach('file', file, 'tasks.xlsx').expect(201);
    expect(applied.body.data).toMatchObject({ tasks: 2, punches: 2 });
    const punches = await select<{ source: string }>('SELECT source FROM attendance_punches WHERE employee_id = :id', { id: employee.id });
    expect(punches.map((item) => item.source)).toEqual(['app', 'app']);
    const days = await select<{ date: string; status: string; late: number; early: number; task: string }>(
      `SELECT to_char(work_date, 'YYYY-MM-DD') AS date, status, late_minutes AS late, early_leave_minutes AS early, task_title AS task
       FROM attendance_days WHERE employee_id = :id AND work_date IN ('2026-09-17', '2026-09-19') ORDER BY work_date`, { id: employee.id },
    );
    expect(days).toEqual([
      { date: '2026-09-17', status: 'present', late: 0, early: 0, task: 'زيارة عميل' },
      { date: '2026-09-19', status: 'present', late: 0, early: 0, task: 'تدريب خارجي' },
    ]);
    await api().post('/api/attendance/files/apply').set(hr.auth).field('kind', 'tasks').attach('file', file, 'tasks.xlsx').expect(400);
  });

  it('refuses the old binary Excel format with a clear message', async () => {
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
    const result = await api().post('/api/attendance/files/preview').set(hr.auth).field('kind', 'attendance').attach('file', ole, 'old.xls').expect(400);
    expect(result.body.message).toContain('.xlsx');
  });
});

describe('external work in the day rule', () => {
  const shift: ShiftRule = { id: 's', startTime: '08:00', endTime: '16:00', breakMinutes: 0, graceMinutes: 10, earlyLeaveGraceMinutes: 5, workingDays: [0, 1, 2, 3, 4, 6] };
  const base = { date: '2026-09-17', shift, leave: null, isHoliday: false, employed: true, isPast: true, overtimeMinimumMinutes: 30, duplicatePunchWindowMinutes: 2, markAbsentWithoutPunch: true };

  it('counts a whole day of external work as present without punches', () => {
    const day = computeDay({ ...base, punches: [], tasks: [{ title: 'تدريب', startTime: null, endTime: null }] });
    expect(day).toMatchObject({ status: 'present', lateMinutes: 0, taskTitle: 'تدريب', workedMinutes: 480 });
  });

  it('excuses the hours spent outside on a task', () => {
    const late = computeDay({ ...base, punches: ['2026-09-17T11:00:00', '2026-09-17T16:00:00'], tasks: [] });
    expect(late.lateMinutes).toBe(180);
    const excused = computeDay({ ...base, punches: ['2026-09-17T11:00:00', '2026-09-17T16:00:00'], tasks: [{ title: 'زيارة', startTime: '08:00', endTime: '11:00' }] });
    expect(excused).toMatchObject({ lateMinutes: 0, excusedMinutes: 180, status: 'present' });
  });

  it('guesses the system leave type from the name the fingerprint program uses', () => {
    expect(guessType('Annual Leave', TYPES)).toBe(ANNUAL_ID);
    expect(guessType('مرضية', TYPES)).toBe(SICK_ID);
    expect(guessType('اجازة زمنية', TYPES)).toBe(HOURLY_ID);
    expect(guessType('شيء آخر', TYPES)).toBeNull();
  });
});
