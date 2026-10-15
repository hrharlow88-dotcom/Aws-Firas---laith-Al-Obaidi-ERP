import bcrypt from 'bcryptjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { User } from '../src/models';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

/**
 * Who sees whom. A manager with two levels below and a colleague outside the
 * team:  boss ─ lead ─ worker ;  outsider (same branch, other manager).
 */
let admin: Awaited<ReturnType<typeof makeUser>>;
let hr: Awaited<ReturnType<typeof makeUser>>;
let branchId: string;
let boss: { id: string };
let lead: { id: string };
let worker: { id: string };
let outsider: { id: string };
let bossUser: Awaited<ReturnType<typeof makeUser>>;
let leadUser: Awaited<ReturnType<typeof makeUser>>;
let workerUser: Awaited<ReturnType<typeof makeUser>>;
const LEAVE_TYPE = '41000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  admin = await makeUser('super_admin');
  hr = await makeUser('hr_manager');
  branchId = (await makeBranch('فرع الصلاحيات')).id;
  boss = await makeEmployee(branchId, { fullName: 'المدير الأعلى' });
  lead = await makeEmployee(branchId, { fullName: 'رئيس الفريق', managerId: boss.id });
  worker = await makeEmployee(branchId, { fullName: 'عضو الفريق', managerId: lead.id });
  outsider = await makeEmployee(branchId, { fullName: 'من خارج الفريق' });
  bossUser = await makeUser('line_manager', null, boss.id);
  leadUser = await makeUser('line_manager', null, lead.id);
  workerUser = await makeUser('employee', null, worker.id);

  const settings = (await api().get('/api/settings').set(admin.auth).expect(200)).body.data;
  await api().put('/api/settings').set(admin.auth).send({
    ...settings,
    leaveTypes: [...settings.leaveTypes.filter((item: { id: string }) => item.id !== LEAVE_TYPE), {
      id: LEAVE_TYPE, name: 'اعتيادية (اختبار الصلاحيات)', unit: 'days', paid: true, active: true,
      annualEntitlement: 21, carryForwardLimit: null, dayCountBasis: 'calendar',
    }],
    approvalSteps: [{ id: '42000000-0000-4000-8000-000000000001', role: 'line_manager' }],
  }).expect(200);
  for (const employee of [lead, worker]) {
    await api().post('/api/leaves/balances').set(hr.auth)
      .send({ employeeId: employee.id, leaveTypeId: LEAVE_TYPE, quantity: 10, entryType: 'opening', reason: 'رصيد افتتاحي' }).expect(201);
  }
});

const names = (body: { data: Array<{ fullName: string }> }) => body.data.map((item) => item.fullName).sort();

describe('data scope by role', () => {
  it('shows an employee only their own record', async () => {
    const me = workerUser;
    const list = await api().get('/api/employees?pageSize=100').set(me.auth).expect(200);
    expect(names(list.body)).toEqual(['عضو الفريق']);
    await api().get(`/api/employees/${outsider.id}`).set(me.auth).expect(404);
    await api().get(`/api/employees/${worker.id}`).set(me.auth).expect(200);
    const profile = await api().get('/api/me/profile').set(me.auth).expect(200);
    expect(profile.body.data).toMatchObject({ fullName: 'عضو الفريق', managerName: 'رئيس الفريق' });
    // No access to HR screens.
    await api().get(`/api/employees/${worker.id}/compensation`).set(me.auth).expect(403);
    await api().get('/api/payroll/runs').set(me.auth).expect(403);
  });

  it('shows a line manager their whole team, direct and indirect, and nobody else', async () => {
    const manager = bossUser;
    const list = await api().get('/api/employees?pageSize=100').set(manager.auth).expect(200);
    expect(names(list.body)).toEqual(['المدير الأعلى', 'رئيس الفريق', 'عضو الفريق'].sort());
    await api().get(`/api/employees/${outsider.id}`).set(manager.auth).expect(404);
    const leaves = await api().get(`/api/leaves/balances?employeeId=${outsider.id}`).set(manager.auth);
    expect(leaves.status).toBe(404);
  });

  it('lets the manager approve a team member but never their own request', async () => {

    const own = await api().post('/api/leaves').set(leadUser.auth)
      .send({ employeeId: lead.id, leaveTypeId: LEAVE_TYPE, startsOn: '2026-12-01', endsOn: '2026-12-01', reason: 'ظرف خاص' }).expect(201);
    await api().post(`/api/leaves/${own.body.data.id}/decision`).set(leadUser.auth).send({ action: 'approve' }).expect(403);
    await api().post(`/api/leaves/${own.body.data.id}/decision`).set(bossUser.auth).send({ action: 'approve' }).expect(200);

    // An employee can only ask for themselves.
    await api().post('/api/leaves').set(workerUser.auth)
      .send({ employeeId: outsider.id, leaveTypeId: LEAVE_TYPE, startsOn: '2026-12-02', endsOn: '2026-12-02', reason: 'محاولة' }).expect(400);
    const mine = await api().post('/api/leaves').set(workerUser.auth)
      .send({ employeeId: worker.id, leaveTypeId: LEAVE_TYPE, startsOn: '2026-12-02', endsOn: '2026-12-02', reason: 'مراجعة' }).expect(201);
    await api().post(`/api/leaves/${mine.body.data.id}/decision`).set(workerUser.auth).send({ action: 'approve' }).expect(403);
    await api().post(`/api/leaves/${mine.body.data.id}/decision`).set(leadUser.auth).send({ action: 'approve' }).expect(200);
    const list = await api().get('/api/leaves').set(workerUser.auth).expect(200);
    expect(list.body.data.every((item: { employeeId: string }) => item.employeeId === worker.id)).toBe(true);
  });

  it('keeps auditors read-only', async () => {
    const auditor = await makeUser('auditor');
    await api().get('/api/payroll/runs').set(auditor.auth).expect(200);
    await api().get('/api/audit').set(auditor.auth).expect((res) => expect([200, 404]).toContain(res.status));
    await api().post('/api/payroll/runs').set(auditor.auth).send({ period: '2026-11' }).expect(403);
    await api().post(`/api/employees/${worker.id}/compensation`).set(auditor.auth)
      .send({ effectiveFrom: '2026-11-01', grossSalary: 1, currency: 'IQD', reason: 'x' }).expect(403);
  });
});

describe('account management', () => {
  it('stops the IT administrator from handing out more access than they have', async () => {
    const it = await makeUser('it_admin');
    const base = { name: 'حساب', password: 'LongEnoughPass#1' };
    await api().post('/api/users').set(it.auth).send({ ...base, email: 'hr-escalation@test.local', role: 'hr_manager' }).expect(403);
    await api().post('/api/users').set(it.auth).send({ ...base, email: 'admin-escalation@test.local', role: 'super_admin' }).expect(403);
    // Employee accounts need the employee record they belong to.
    await api().post('/api/users').set(it.auth).send({ ...base, email: 'no-link@test.local', role: 'employee' }).expect(400);
    const created = await api().post('/api/users').set(it.auth)
      .send({ ...base, email: 'linked-employee@test.local', role: 'employee', employeeId: outsider.id }).expect(201);
    // One account per employee.
    await api().post('/api/users').set(it.auth)
      .send({ ...base, email: 'second-link@test.local', role: 'employee', employeeId: outsider.id }).expect(400);
    await api().put(`/api/users/${it.user.id}`).set(it.auth).send({ role: 'hr_manager' }).expect(403);
    await api().put(`/api/users/${created.body.data.id}`).set(it.auth).send({ role: 'finance' }).expect(403);
    // IT does not read salaries.
    await api().get(`/api/employees/${outsider.id}/compensation`).set(it.auth).expect(403);
  });

  it('locks an account after five wrong passwords and lets an administrator unlock it', async () => {
    const email = 'lockout@test.local';
    const user = await User.create({ name: 'قفل', email, passwordHash: await bcrypt.hash('RightPassword#1', 4), role: 'employee', employeeId: (await makeEmployee(branchId, { fullName: 'صاحب الحساب المقفل' })).id });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await api().post('/api/auth/login').send({ email, password: 'wrong-password' }).expect(401);
    }
    await api().post('/api/auth/login').send({ email, password: 'RightPassword#1' }).expect(423);
    await api().put(`/api/users/${user.id}`).set(admin.auth).send({ unlock: true }).expect(200);
    const login = await api().post('/api/auth/login').send({ email, password: 'RightPassword#1' }).expect(200);
    expect(login.body.user).toMatchObject({ role: 'employee', employeeId: user.employeeId });
  });
});
