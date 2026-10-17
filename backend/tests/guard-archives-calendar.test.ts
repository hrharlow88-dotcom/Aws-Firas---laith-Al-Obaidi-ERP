import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { execute, select, selectOne } from '../src/db/query';
import { runSecurityGuard, verifyAuditChain, outsideWorkday } from '../src/services/security';
import { invalidateSettingsCache } from '../src/services/settings';
import { lateTierDays } from '../src/services/payrollCalc';
import { normalizePhone } from '../src/services/messaging';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

async function setSettings(patch: (value: Record<string, any>) => void) {
  const owner = await makeUser('super_admin');
  const current = await api().get('/api/settings').set(owner.auth).expect(200);
  patch(current.body.data);
  await api().put('/api/settings').set(owner.auth).send(current.body.data).expect(200);
  invalidateSettingsCache();
  return owner;
}

describe('security guard', () => {
  it('chains the audit trail so an edit made outside the system is detected', async () => {
    const hr = await makeUser('hr_manager');
    const branch = await makeBranch('فرع السلسلة');
    await makeEmployee(branch.id);
    await api().post('/api/calendar/events').set(hr.auth).send({ title: 'اجتماع', start: '2033-06-01T10:00', end: '2033-06-01T11:00', visibility: 'company' }).expect(201);
    const before = await verifyAuditChain();
    expect(before.broken).toBe(0);
    expect(before.entries).toBeGreaterThan(0);
    // Simulate someone with database access rewriting history.
    await execute('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_change');
    const last = await selectOne<{ id: string }>('SELECT id FROM audit_logs ORDER BY seq DESC LIMIT 1');
    await execute("UPDATE audit_logs SET action = 'tampered' WHERE id = :id", { id: last!.id });
    const after = await verifyAuditChain();
    expect(after.broken).toBeGreaterThan(0);
    await runSecurityGuard();
    const alert = await selectOne("SELECT 1 FROM security_alerts WHERE kind = 'audit_tamper' AND resolved_at IS NULL");
    expect(alert).not.toBeNull();
    // Put it back so later tests see a clean chain.
    const original = await selectOne<{ action: string }>("SELECT 'calendar.created' AS action");
    await execute('UPDATE audit_logs SET action = :action WHERE id = :id', { id: last!.id, action: original!.action });
    await execute('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_change');
    await execute("UPDATE security_alerts SET resolved_at = now(), resolution = 'test' WHERE resolved_at IS NULL");
  });

  it('raises one alert for repeated failed sign-ins from one address and lets only the owner see it', async () => {
    for (let index = 0; index < 9; index += 1) {
      await execute("INSERT INTO security_events (kind, ip, details) VALUES ('login_failed', '10.9.9.9', '{}')");
    }
    await runSecurityGuard();
    await runSecurityGuard();
    const alerts = await select("SELECT id FROM security_alerts WHERE kind = 'brute_force' AND ip = '10.9.9.9' AND resolved_at IS NULL");
    expect(alerts).toHaveLength(1);
    const owner = await makeUser('super_admin');
    const hr = await makeUser('hr_manager');
    await api().get('/api/security/alerts').set(hr.auth).expect(403);
    const list = await api().get('/api/security/alerts').set(owner.auth).expect(200);
    const alert = list.body.data.find((item: { ip: string }) => item.ip === '10.9.9.9');
    await api().post(`/api/security/alerts/${alert.id}/resolve`).set(owner.auth).send({ resolution: 'عنوان اختبار' }).expect(200);
    const notices = await api().get('/api/notifications').set(owner.auth).expect(200);
    expect(notices.body.data).toHaveProperty('unread');
  });

  it('records the sign-in with the place it came from and ends idle sessions', async () => {
    const hr = await makeUser('hr_manager');
    await execute('UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE id = :id) WHERE id = :id', { id: hr.user.id });
    const login = await api().post('/api/auth/login').send({ email: hr.user.email, password: 'TestPassword#1' }).expect(200);
    expect(login.body).toMatchObject({ askLocation: true, idleMinutes: 15 });
    const auth = { Authorization: `Bearer ${login.body.token}` };
    await api().post('/api/auth/login-location').set(auth).send({ eventId: login.body.loginEventId, status: 'shared', latitude: 33.3152, longitude: 44.3661, accuracy: 25 }).expect(200);
    const event = await selectOne<{ latitude: number; status: string }>(
      'SELECT latitude::float AS latitude, location_status AS status FROM login_events WHERE id = :id', { id: login.body.loginEventId },
    );
    expect(event).toEqual({ latitude: 33.3152, status: 'shared' });
    // A second report for the same sign-in is ignored.
    const again = await api().post('/api/auth/login-location').set(auth).send({ eventId: login.body.loginEventId, status: 'denied' }).expect(200);
    expect(again.body.data.saved).toBe(false);
    // Idle beyond the limit → the session ends.
    await execute("UPDATE users SET last_seen_at = now() - interval '16 minutes' WHERE id = :id", { id: hr.user.id });
    const idle = await api().get('/api/auth/me').set(auth).expect(401);
    expect(idle.body.reason).toBe('idle');
  });

  it('knows the working day and the late-tier policy', () => {
    expect(outsideWorkday(new Date('2033-01-01T23:30:00Z'), '07:00', '21:00')).toBe(true); // 02:30 Baghdad
    expect(outsideWorkday(new Date('2033-01-01T07:00:00Z'), '07:00', '21:00')).toBe(false); // 10:00 Baghdad
    expect(lateTierDays([5, 20, 70, 0], [{ minutes: 15, days: 0.25 }, { minutes: 60, days: 0.5 }])).toBe(0.75);
    expect(lateTierDays([90], [])).toBe(0);
    expect(normalizePhone('0770 123 4567')).toBe('9647701234567');
    expect(normalizePhone('+964 770 123 4567')).toBe('9647701234567');
  });
});

describe('notifications, approvals inbox and recycle bin', () => {
  it('tells the employee about decisions, lists pending work for HR, and restores a deleted payroll amount', async () => {
    const hr = await makeUser('hr_manager');
    const owner = await makeUser('super_admin');
    const branch = await makeBranch('فرع الإشعارات');
    const employee = await makeEmployee(branch.id);
    const staff = await makeUser('employee', null, employee.id);
    const created = await api().post('/api/me/requests').set(staff.auth).send({ kind: 'loan', amount: 300000, currency: 'IQD', months: 3, startPeriod: '2033-07', description: 'سلفة' }).expect(201);
    const inbox = await api().get('/api/approvals/inbox').set(hr.auth).expect(200);
    expect(inbox.body.data.groups.some((group: { id: string }) => group.id === 'requests')).toBe(true);
    await api().post(`/api/requests/${created.body.data.id}/decision`).set(hr.auth).send({ action: 'reject', note: 'تجربة' }).expect(200);
    const notices = await api().get('/api/notifications').set(staff.auth).expect(200);
    expect(notices.body.data.items.some((item: { kind: string }) => item.kind === 'request')).toBe(true);
    await api().post('/api/notifications/read').set(staff.auth).send({ all: true }).expect(200);
    expect((await api().get('/api/notifications').set(staff.auth)).body.data.unread).toBe(0);

    const input = await api().post('/api/payroll/inputs').set(owner.auth).send({
      employeeId: employee.id, period: '2033-08', componentId: '30000000-0000-4000-8000-000000000005', amount: 25000, note: 'مكافأة',
    });
    expect(input.status).toBe(201);
    await api().delete(`/api/payroll/inputs/${input.body.data.id}`).set(owner.auth).expect(200);
    const bin = await api().get('/api/recycle-bin').set(owner.auth).expect(200);
    const entry = bin.body.data.find((item: { entityId: string }) => item.entityId === input.body.data.id);
    expect(entry).toBeTruthy();
    await api().get('/api/recycle-bin').set(hr.auth).expect(403);
    await api().post(`/api/recycle-bin/${entry.id}/restore`).set(owner.auth).expect(200);
    expect(await selectOne('SELECT 1 FROM payroll_inputs WHERE id = :id', { id: input.body.data.id })).not.toBeNull();
    await api().post(`/api/recycle-bin/${entry.id}/restore`).set(owner.auth).expect(404);

    // Every signed-in request is in the activity log, and visits are recorded.
    await api().post('/api/activity/visit').set(staff.auth).send({ route: '/my', module: 'me' }).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const activity = await api().get(`/api/activity?userId=${staff.user.id}`).set(owner.auth).expect(200);
    expect(activity.body.data.rows.some((row: { kind: string }) => row.kind === 'visit')).toBe(true);
    expect(activity.body.data.rows.some((row: { kind: string; module: string }) => row.kind === 'write' && row.module === 'me')).toBe(true);
  });
});

describe('archives', () => {
  it('archives any file type, separates an employee into the former-employees archive and reinstates them', async () => {
    const hr = await makeUser('hr_manager');
    const branch = await makeBranch('فرع الأرشيف');
    const employee = await makeEmployee(branch.id);
    const staff = await makeUser('employee', null, employee.id);
    const upload = await api().post('/api/archive').set(hr.auth)
      .field('title', 'محضر اجتماع').field('category', 'correspondence').field('employeeId', employee.id)
      .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), 'minutes.html').expect(201);
    const file = await api().get(`/api/archive/${upload.body.data.id}/file?inline=1`).set(hr.auth).expect(200);
    expect(file.headers['content-type']).toContain('application/octet-stream');
    expect(file.headers['content-disposition']).toContain('attachment');
    await api().get('/api/archive').set(staff.auth).expect(403);
    await api().post(`/api/employees/${employee.id}/separate`).set(hr.auth).send({ terminationDate: '2026-01-31', reason: 'resignation', note: 'استقالة' }).expect(200);
    const former = await api().get('/api/employees/former').set(hr.auth).expect(200);
    expect(former.body.data.find((row: { id: string }) => row.id === employee.id)).toMatchObject({ separationReason: 'resignation', status: 'inactive' });
    expect((await selectOne<{ active: boolean }>('SELECT is_active AS active FROM users WHERE id = :id', { id: staff.user.id }))!.active).toBe(false);
    await api().post(`/api/employees/${employee.id}/reinstate`).set(hr.auth).send({ note: 'عودة' }).expect(200);
    await api().post(`/api/archive/${upload.body.data.id}/withdraw`).set(hr.auth).send({ reason: 'مكرر' }).expect(200);
    await api().get(`/api/archive/${upload.body.data.id}/file`).set(hr.auth).expect(404);
  });

  it('keeps the months before launch in the payroll archive and blocks system runs for them', async () => {
    const owner = await setSettings((value) => { value.payrollRules.launchPeriod = '2032-09'; });
    const branch = await makeBranch('فرع أرشيف الرواتب');
    const employee = await makeEmployee(branch.id, { employeeNo: `9${Date.now() % 100000}` });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Payroll');
    sheet.addRow(['كشف رواتب']);
    sheet.addRow(['Code', 'Name', 'Gross Salary', 'Total Deductions', 'Net Pay', 'Currency']);
    sheet.addRow([employee.employeeNo, 'موظف', 1000000, 50000, 950000, 'IQD']);
    sheet.addRow(['77777', 'غير موجود', 500, 0, 500, 'USD']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const preview = await api().post('/api/payroll/archive/preview').set(owner.auth).field('period', '2032-03').attach('file', buffer, 'march.xlsx').expect(200);
    expect(preview.body.data).toMatchObject({ lines: 2, matched: 1, period: '2032-03' });
    expect(preview.body.data.totals.IQD.net).toBe(950000);
    await api().post('/api/payroll/archive').set(owner.auth).field('period', '2032-10').attach('file', buffer, 'oct.xlsx').expect(400);
    const saved = await api().post('/api/payroll/archive').set(owner.auth).field('period', '2032-03').attach('file', buffer, 'march.xlsx').expect(201);
    await api().post('/api/payroll/archive').set(owner.auth).field('period', '2032-03').attach('file', buffer, 'march.xlsx').expect(409);
    const history = await api().get(`/api/employees/${employee.id}/payroll-history`).set(owner.auth).expect(200);
    expect(history.body.data[0]).toMatchObject({ period: '2032-03', netPay: 950000, source: 'archive' });
    await api().post('/api/payroll/runs').set(owner.auth).send({ period: '2032-05' }).expect(400);
    const lines = await api().get(`/api/payroll/archive/${saved.body.data.id}`).set(owner.auth).expect(200);
    expect(lines.body.data.lines).toHaveLength(2);
    await setSettings((value) => { value.payrollRules.launchPeriod = null; });
  });
});

describe('calendar, announcements and owner controls', () => {
  it('shows company events and holidays, and lets HR mark a holiday', async () => {
    const hr = await makeUser('hr_manager');
    const staff = await makeUser('employee');
    await api().post('/api/calendar/events').set(hr.auth).send({ title: 'تدريب السلامة', category: 'training', start: '2033-09-10', end: '2033-09-10', allDay: true, visibility: 'company' }).expect(201);
    await api().post('/api/calendar/events').set(staff.auth).send({ title: 'موعد خاص', start: '2033-09-11T09:00', end: '2033-09-11T10:00', visibility: 'company' }).expect(201);
    await api().put('/api/calendar/holidays/2033-09-12').set(hr.auth).send({ holiday: true }).expect(200);
    await api().put('/api/calendar/holidays/2033-09-12').set(staff.auth).send({ holiday: true }).expect(403);
    invalidateSettingsCache();
    const view = await api().get('/api/calendar?from=2033-09-01&to=2033-09-30').set(staff.auth).expect(200);
    const titles = view.body.data.items.map((item: { title: string }) => item.title);
    expect(titles).toContain('تدريب السلامة');
    expect(titles).toContain('موعد خاص');
    expect(view.body.data.items.some((item: { source: string }) => item.source === 'holiday')).toBe(true);
    const other = await makeUser('employee');
    const otherView = await api().get('/api/calendar?from=2033-09-01&to=2033-09-30').set(other.auth).expect(200);
    // An employee's own event is private to them.
    expect(otherView.body.data.items.map((item: { title: string }) => item.title)).not.toContain('موعد خاص');
    await api().put('/api/calendar/holidays/2033-09-12').set(hr.auth).send({ holiday: false }).expect(200);
  });

  it('shows an announcement full screen to its audience until acknowledged', async () => {
    const hr = await makeUser('hr_manager');
    const branch = await makeBranch('فرع الإعلانات');
    const inside = await makeEmployee(branch.id);
    const outside = await makeEmployee((await makeBranch('فرع آخر')).id);
    const a = await makeUser('employee', null, inside.id);
    const b = await makeUser('employee', null, outside.id);
    const created = await api().post('/api/announcements').set(hr.auth).send({
      titleAr: 'تعميم الدوام', titleEn: 'Working hours circular', bodyAr: 'يبدأ الدوام الساعة الثامنة', bodyEn: 'Work starts at 8', kind: 'circular',
      severity: 'important', audience: 'branch', branchId: branch.id, requireAck: true,
    }).expect(201);
    expect((await api().get('/api/me/announcements/pending').set(a.auth)).body.data).toHaveLength(1);
    expect((await api().get('/api/me/announcements/pending').set(b.auth)).body.data).toHaveLength(0);
    await api().post(`/api/me/announcements/${created.body.data.id}/seen`).set(a.auth).send({}).expect(200);
    expect((await api().get('/api/me/announcements/pending').set(a.auth)).body.data).toHaveLength(1);
    await api().post(`/api/me/announcements/${created.body.data.id}/seen`).set(a.auth).send({ acknowledge: true }).expect(200);
    expect((await api().get('/api/me/announcements/pending').set(a.auth)).body.data).toHaveLength(0);
    const list = await api().get('/api/announcements').set(hr.auth).expect(200);
    expect(list.body.data.find((row: { id: string }) => row.id === created.body.data.id)).toMatchObject({ acknowledged: '1' });
  });

  it('prepares bilingual messages with hand-send links and sends nothing while channels are off', async () => {
    const hr = await makeUser('hr_manager');
    const branch = await makeBranch('فرع الرسائل');
    const employee = await makeEmployee(branch.id, { phone: '07701234567', email: 'staff@example.com' });
    const result = await api().post('/api/messages/send').set(hr.auth).send({
      templateId: 'meeting_invite', employeeIds: [employee.id], channels: ['email', 'whatsapp'],
      values: { title: 'مراجعة الأداء', date: '2033-10-01', time: '10:00', place: 'الإدارة', details: '' },
    }).expect(200);
    expect(result.body.data.queued).toBe(0);
    expect(result.body.data.disabledChannels).toEqual(['email', 'whatsapp']);
    const message = result.body.data.prepared[0];
    expect(message.body).toContain('مراجعة الأداء');
    expect(message.body).toContain('Dear');
    expect(message.links.whatsapp).toMatch(/^https:\/\/wa\.me\/9647701234567\?text=/);
    await api().put('/api/messages/channels/email').set(hr.auth).send({ enabled: true }).expect(403);
  });

  it('lets only the owner hide apps, set brand logos and export the company template', async () => {
    const owner = await makeUser('super_admin');
    const hr = await makeUser('hr_manager');
    const branding = await api().get('/api/public/branding').expect(200);
    expect(branding.body.data.brands.map((brand: { name: string }) => brand.name)).toEqual(['ROX', 'DONGFENG', 'FORTHING', 'GENERAL MOTORS', 'MULTI-BRAND']);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1a5b9c40000000049454e44ae426082', 'hex');
    await api().post('/api/owner/brands/rox/logo').set(hr.auth).attach('file', png, 'rox.png').expect(403);
    await api().post('/api/owner/brands/rox/logo').set(owner.auth).attach('file', png, 'rox.png').expect(200);
    invalidateSettingsCache();
    const after = await api().get('/api/public/branding').expect(200);
    const logo = after.body.data.brands[0].logo as string;
    expect(logo).toMatch(/^\/api\/public\/brands\/rox\/logo/);
    await api().get(logo).expect(200).expect('Content-Type', /image\/png/);
    const template = await api().get('/api/owner/template').set(owner.auth).expect(200);
    expect(template.body).toMatchObject({ format: 'lo-erp.company-template', version: 1 });
    expect(JSON.stringify(template.body)).not.toContain('passwordHash');
    await api().post('/api/owner/template').set(owner.auth).send(template.body).expect(400); // employees exist
    await api().delete('/api/owner/brands/rox/logo').set(owner.auth).expect(200);
  });
});
