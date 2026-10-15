import fsp from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { execute, selectOne } from '../src/db/query';
import { refreshBlocks, attackIn } from '../src/services/firewall';
import { readStoredFile, resolveKey, storeFile } from '../src/services/storage';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

describe('firewall', () => {
  it('spots attack patterns and refuses blocked addresses', async () => {
    expect(attackIn("/api/employees?search=' OR 1=1")).toBe('sql_injection');
    expect(attackIn('/api/x?q=1 UNION SELECT password FROM users')).toBe('sql_injection');
    expect(attackIn('/api/../../etc/passwd')).toBe('path_traversal');
    expect(attackIn('{"name":"<script>alert(1)</script>"}')).toBe('script_injection');
    expect(attackIn('{"note":"سلفة لتجهيز المنزل"}')).toBeNull();
    const hr = await makeUser('hr_manager');
    const refused = await api().get("/api/employees?search=%27%20OR%201%3D1").set(hr.auth);
    expect(refused.status).toBe(403);
    expect(await selectOne("SELECT 1 FROM security_events WHERE kind = 'waf_blocked' ORDER BY at DESC LIMIT 1")).not.toBeNull();

    const owner = await makeUser('super_admin');
    await api().post('/api/security/blocks').set(owner.auth).send({ ip: '203.0.113.9', minutes: 60, reason: 'اختبار' }).expect(200);
    const blocks = await api().get('/api/security/blocks').set(owner.auth).expect(200);
    const block = blocks.body.data.find((row: { ip: string }) => row.ip === '203.0.113.9');
    expect(block).toBeTruthy();
    // Requests from the test client's own address are still served.
    await api().get('/api/health').expect(200);
    await api().post(`/api/security/blocks/${block.id}/lift`).set(owner.auth).expect(200);
    await refreshBlocks();
  });

  it('scans the system and applies a one-click fix', async () => {
    const owner = await makeUser('super_admin');
    const branch = await makeBranch('فرع الفحص');
    const employee = await makeEmployee(branch.id, { terminationDate: '2026-01-01' });
    await makeUser('employee', null, employee.id);
    const report = await api().get('/api/security/scan-report').set(owner.auth).expect(200);
    expect(report.body.data.score).toBeLessThanOrEqual(100);
    const leaver = report.body.data.findings.find((item: { id: string }) => item.id === 'leaver_accounts');
    expect(leaver.severity).toBe('high');
    await api().post('/api/security/fix/leaver_accounts').set(owner.auth).expect(200);
    const after = await api().get('/api/security/scan-report').set(owner.auth).expect(200);
    expect(after.body.data.findings.find((item: { id: string }) => item.id === 'leaver_accounts').severity).toBe('ok');
    const radar = await api().get('/api/security/radar').set(owner.auth).expect(200);
    expect(Array.isArray(radar.body.data.people)).toBe(true);
  });

  it('stores files encrypted and reads them back', async () => {
    const key = await storeFile('test', Buffer.from('بيانات سرية'), 'txt');
    const raw = await fsp.readFile(resolveKey(key));
    expect(raw.subarray(0, 6).toString()).toBe('LOENC1');
    expect(raw.toString('utf8')).not.toContain('بيانات');
    expect((await readStoredFile(key)).toString('utf8')).toBe('بيانات سرية');
  });
});

describe('chat', () => {
  it('has a company channel, direct messages, mentions, reactions and unread counts', async () => {
    const a = await makeUser('hr_manager');
    const b = await makeUser('finance');
    const channels = await api().get('/api/chat/channels').set(a.auth).expect(200);
    const general = channels.body.data.channels.find((row: { name: string }) => row.name.includes('General'));
    expect(general).toBeTruthy();
    await api().get('/api/chat/channels').set(b.auth).expect(200);
    await api().post(`/api/chat/channels/${general.id}/messages`).set(a.auth).send({ body: `صباح الخير @${b.user.name}` }).expect(201);
    const unread = await api().get('/api/chat/unread').set(b.auth).expect(200);
    expect(unread.body.data.unread).toBeGreaterThan(0);
    const notice = await selectOne("SELECT 1 FROM notifications WHERE user_id = :id AND kind = 'chat'", { id: b.user.id });
    expect(notice).not.toBeNull();
    const dm = await api().post('/api/chat/direct').set(a.auth).send({ userId: b.user.id }).expect(201);
    const again = await api().post('/api/chat/direct').set(b.auth).send({ userId: a.user.id }).expect(200);
    expect(again.body.data.id).toBe(dm.body.data.id);
    const sent = await api().post(`/api/chat/channels/${dm.body.data.id}/messages`).set(b.auth).field('body', 'الملف المطلوب')
      .attach('file', Buffer.from('%PDF-1.4 test'), 'report.pdf').expect(201);
    await api().post(`/api/chat/messages/${sent.body.data.id}/react`).set(a.auth).send({ emoji: '👍' }).expect(200);
    const list = await api().get(`/api/chat/channels/${dm.body.data.id}/messages`).set(a.auth).expect(200);
    expect(list.body.data[0]).toMatchObject({ body: 'الملف المطلوب', attachmentName: 'report.pdf' });
    expect(list.body.data[0].reactions['👍']).toEqual([a.user.id]);
    await api().get(`/api/chat/messages/${sent.body.data.id}/file`).set(a.auth).expect(200);
    const outsider = await makeUser('employee');
    await api().get(`/api/chat/channels/${dm.body.data.id}/messages`).set(outsider.auth).expect(404);
    await api().patch(`/api/chat/messages/${sent.body.data.id}`).set(a.auth).send({ body: 'تعديل' }).expect(403);
  });
});

describe('companies and demo accounts', () => {
  it('adds a group company, links a branch, and shows it on the login page', async () => {
    const owner = await makeUser('super_admin');
    const created = await api().post('/api/companies').set(owner.auth).send({ code: `CO${Date.now() % 10000}`, nameAr: 'شركة روكس العراق', nameEn: 'ROX Iraq', brandIds: ['rox'] }).expect(201);
    const branch = await makeBranch('فرع الشركة');
    await api().put(`/api/branches/${branch.id}`).set(owner.auth).send({ companyId: created.body.data.id }).expect(200);
    const list = await api().get('/api/companies').set(owner.auth).expect(200);
    expect(list.body.data.find((row: { id: string }) => row.id === created.body.data.id)).toMatchObject({ branches: 1, brandIds: ['rox'] });
    const branding = await api().get('/api/public/branding').expect(200);
    expect(branding.body.data.companies.some((row: { nameAr: string }) => row.nameAr === 'شركة روكس العراق')).toBe(true);
    const hr = await makeUser('hr_manager');
    await api().post('/api/companies').set(hr.auth).send({ code: 'X', nameAr: 'x' }).expect(403);
  });

  it('creates demo accounts only on the demo copy, and the owner switches them off', async () => {
    const owner = await makeUser('super_admin');
    const branch = await makeBranch('فرع العرض');
    const employee = await makeEmployee(branch.id);
    await api().post('/api/owner/demo').set(owner.auth).send({ name: 'ديمو', email: 'demo1@demo.local', password: 'Demo-Password-2026', role: 'hr_manager' }).expect(409);
    process.env.DEMO_MODE = 'true';
    try {
      await api().post('/api/owner/demo').set(owner.auth).send({ name: 'مدير تجريبي', email: `admin.${Date.now()}@demo.local`, password: 'Demo-Password-2026', role: 'hr_manager' }).expect(201);
      const staff = await api().post('/api/owner/demo').set(owner.auth).send({ name: 'موظف تجريبي', email: `emp.${Date.now()}@demo.local`, password: 'Demo-Password-2026', role: 'employee', employeeId: employee.id }).expect(201);
      const list = await api().get('/api/owner/demo').set(owner.auth).expect(200);
      const account = list.body.data.accounts.find((row: { id: string }) => row.id === staff.body.data.id);
      const login = await api().post('/api/auth/login').send({ email: account.email, password: 'Demo-Password-2026' }).expect(200);
      expect(login.body.demo).toBe(true);
      const auth = { Authorization: `Bearer ${login.body.token}` };
      await api().post('/api/auth/change-password').set(auth).send({ currentPassword: 'Demo-Password-2026', newPassword: 'Another-Password-1' }).expect(403);
      await api().patch(`/api/owner/demo/${staff.body.data.id}`).set(owner.auth).send({ isActive: false }).expect(200);
      await api().get('/api/auth/me').set(auth).expect(401);
      await api().post('/api/owner/demo-toggle').set(owner.auth).send({ enabled: false }).expect(200);
    } finally {
      delete process.env.DEMO_MODE;
    }
    await execute('UPDATE users SET is_active = false WHERE is_demo');
  });
});
