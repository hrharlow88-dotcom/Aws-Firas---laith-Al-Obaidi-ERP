import { describe, expect, it } from 'vitest';
import { selectOne } from '../src/db/query';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

describe('HR register', () => {
  it('issues a penalty with a reference number, puts the deduction into payroll, and the employee acknowledges it', async () => {
    const hr = await makeUser('hr_manager');
    const branch = await makeBranch('فرع السجل');
    const employee = await makeEmployee(branch.id);
    const staff = await makeUser('employee', null, employee.id);
    await api().post('/api/discipline').set(staff.auth).send({}).expect(403);
    const created = await api().post('/api/discipline').set(hr.auth).send({
      employeeId: employee.id, category: 'lateness', action: 'deduction', title: 'تأخير متكرر', description: 'تأخر خمس مرات خلال الشهر',
      incidentDate: '2033-03-10', deductionAmount: 50000, deductionPeriod: '2033-03',
    }).expect(201);
    expect(created.body.data.refNo).toMatch(/^HR-DIS-2033-\d{4}$/);
    const input = await selectOne<{ amount: string }>("SELECT amount FROM payroll_inputs WHERE employee_id = :id AND period = '2033-03'", { id: employee.id });
    expect(Number(input!.amount)).toBe(50000);
    await api().post(`/api/me/discipline/${created.body.data.id}/acknowledge`).set(staff.auth).send({ comment: 'اطلعت' }).expect(200);
    const mine = await api().get('/api/me/discipline').set(staff.auth).expect(200);
    expect(mine.body.data[0]).toMatchObject({ status: 'acknowledged', employeeComment: 'اطلعت' });
    await api().post(`/api/discipline/${created.body.data.id}/cancel`).set(hr.auth).send({ reason: 'اعتراض مقبول' }).expect(200);
    expect(await selectOne("SELECT 1 FROM payroll_inputs WHERE employee_id = :id AND period = '2033-03'", { id: employee.id })).toBeNull();
  });
});

describe('helpdesk', () => {
  it('lets anyone raise a ticket and only the desk move it', async () => {
    const it_ = await makeUser('it_admin');
    const requester = await makeUser('employee');
    const ticket = await api().post('/api/tickets').set(requester.auth).send({
      category: 'vehicle', title: 'سيارة لزيارة فرع أربيل', description: 'لنقل ملفات', neededFrom: '2033-04-01T08:00:00Z', neededTo: '2033-04-01T16:00:00Z', destination: 'أربيل', passengers: 2,
    }).expect(201);
    expect(ticket.body.data.refNo).toMatch(/^VEH-\d{5}$/);
    await api().patch(`/api/tickets/${ticket.body.data.id}`).set(requester.auth).send({ status: 'resolved' }).expect(403);
    await api().patch(`/api/tickets/${ticket.body.data.id}`).set(it_.auth).send({ assigneeUserId: it_.user.id, vehiclePlate: '12345 بغداد' }).expect(200);
    await api().post(`/api/tickets/${ticket.body.data.id}/comments`).set(requester.auth).send({ body: 'شكراً' }).expect(201);
    await api().patch(`/api/tickets/${ticket.body.data.id}`).set(it_.auth).send({ status: 'resolved', resolution: 'خُصصت السيارة' }).expect(200);
    await api().patch(`/api/tickets/${ticket.body.data.id}`).set(requester.auth).send({ status: 'closed' }).expect(200);
    const detail = await api().get(`/api/tickets/${ticket.body.data.id}`).set(requester.auth).expect(200);
    expect(detail.body.data).toMatchObject({ status: 'closed', assigneeName: it_.user.name, vehiclePlate: '12345 بغداد' });
    expect(detail.body.data.comments.length).toBeGreaterThanOrEqual(3);
    const other = await makeUser('employee');
    await api().get(`/api/tickets/${ticket.body.data.id}`).set(other.auth).expect(404);
  });
});

describe('recruitment', () => {
  it('opens a position, moves an applicant through the stages and hires them into an employee file', async () => {
    const hr = await makeUser('hr_manager');
    const branch = await makeBranch('فرع التوظيف');
    const position = await api().post('/api/recruitment/positions').set(hr.auth).send({ title: 'مستشار مبيعات', branchId: branch.id, vacancies: 2 }).expect(201);
    const applicant = await api().post('/api/recruitment/applicants').set(hr.auth).send({ positionId: position.body.data.id, fullName: 'متقدم تجريبي', phone: '07700000000', source: 'linkedin' }).expect(201);
    const id = applicant.body.data.id;
    await api().patch(`/api/recruitment/applicants/${id}`).set(hr.auth).send({ stage: 'interview1', interviewAt: '2033-05-01T10:00', priority: 2 }).expect(200);
    await api().patch(`/api/recruitment/applicants/${id}`).set(hr.auth).send({ stage: 'refused' }).expect(400);
    await api().patch(`/api/recruitment/applicants/${id}`).set(hr.auth).send({ stage: 'offer', note: 'مرشح قوي' }).expect(200);
    const hired = await api().post(`/api/recruitment/applicants/${id}/hire`).set(hr.auth).send({ employeeNo: `R-${Date.now() % 100000}`, hireDate: '2033-05-15' }).expect(201);
    const employee = await selectOne<{ fullName: string; type: string }>('SELECT full_name AS "fullName", employment_type AS type FROM employees WHERE id = :id', { id: hired.body.data.employeeId });
    expect(employee).toEqual({ fullName: 'متقدم تجريبي', type: 'probation' });
    const detail = await api().get(`/api/recruitment/applicants/${id}`).set(hr.auth).expect(200);
    expect(detail.body.data.stage).toBe('hired');
    expect(detail.body.data.activity.map((item: { kind: string }) => item.kind)).toContain('hired');
    const positions = await api().get('/api/recruitment/positions').set(hr.auth).expect(200);
    expect(positions.body.data.find((row: { id: string }) => row.id === position.body.data.id).hiredCount).toBe(1);
  });
});
