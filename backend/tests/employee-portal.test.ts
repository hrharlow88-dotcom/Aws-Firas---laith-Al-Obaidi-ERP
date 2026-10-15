import { describe, expect, it } from 'vitest';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

describe('employee portal', () => {
  it('invites an employee who signs in with the employee number and requests a loan and an expense', async () => {
    const admin = await makeUser('super_admin');
    const hr = await makeUser('hr_manager');
    const finance = await makeUser('finance');
    const branch = await makeBranch('فرع البوابة');
    const employee = await makeEmployee(branch.id, { employeeNo: `P-${Date.now() % 100000}`, fullName: 'موظف البوابة' });

    const invite = await api().post(`/api/portal/accounts/${employee.id}/invite`).set(admin.auth).expect(200);
    const token = invite.body.data.path.split('/').pop();
    await api().post('/api/auth/set-password').send({ token, password: 'Portal-Pass-2026' }).expect(200);
    const login = await api().post('/api/auth/login').send({ email: employee.employeeNo, password: 'Portal-Pass-2026' }).expect(200);
    const auth = { Authorization: `Bearer ${login.body.token}` };
    expect(login.body.user.role).toBe('employee');

    // A second invite reuses the account.
    await api().post(`/api/portal/accounts/${employee.id}/invite`).set(admin.auth).expect(200);
    const accounts = await api().get('/api/portal/accounts').set(admin.auth).expect(200);
    expect(accounts.body.data.filter((row: { id: string; userId: string | null }) => row.id === employee.id && row.userId)).toHaveLength(1);

    const loan = await api().post('/api/me/requests').set(auth)
      .send({ kind: 'loan', amount: 900000, currency: 'IQD', months: 4, startPeriod: '2032-01', description: 'ظرف عائلي' }).expect(201);
    const expense = await api().post('/api/me/requests').set(auth)
      .send({ kind: 'expense', amount: 25000, currency: 'IQD', expenseDate: '2026-10-10', description: 'أجرة نقل وثائق' }).expect(201);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await api().post(`/api/me/requests/${expense.body.data.id}/receipt`).set(auth).attach('file', png, 'receipt.png').expect(200);
    expect((await api().get('/api/me/requests').set(auth).expect(200)).body.data).toHaveLength(2);
    await api().get('/api/requests').set(auth).expect(403);

    await api().post(`/api/requests/${loan.body.data.id}/decision`).set(hr.auth).send({ action: 'approve' }).expect(200);
    await api().post(`/api/requests/${loan.body.data.id}/decision`).set(hr.auth).send({ action: 'approve' }).expect(409);
    const loans = await api().get(`/api/payroll/loans?employeeId=${employee.id}`).set(hr.auth).expect(200);
    expect(loans.body.data[0]).toMatchObject({ principal: 900000, installment: 225000, installmentsTotal: 4, startPeriod: '2032-01' });

    await api().post(`/api/requests/${expense.body.data.id}/decision`).set(hr.auth).send({ action: 'reject' }).expect(400);
    await api().post(`/api/requests/${expense.body.data.id}/decision`).set(hr.auth).send({ action: 'approve', note: 'وصل مطابق' }).expect(200);
    await api().get(`/api/requests/${expense.body.data.id}/receipt`).set(finance.auth).expect(200);
    await api().post(`/api/requests/${expense.body.data.id}/paid`).set(finance.auth).expect(200);
    const mine = (await api().get('/api/me/requests').set(auth)).body.data;
    expect(mine.map((row: { kind: string; status: string }) => `${row.kind}:${row.status}`).sort()).toEqual(['expense:paid', 'loan:approved']);
    await api().get('/api/me/attendance?period=2026-10').set(auth).expect(200);
  });
});
