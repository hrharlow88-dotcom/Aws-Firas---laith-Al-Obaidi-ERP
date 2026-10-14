import { beforeAll, describe, expect, it } from 'vitest';
import { execute, selectOne } from '../src/db/query';
import { ipAllowed } from '../src/controllers/DevicePushController';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

let hr: Awaited<ReturnType<typeof makeUser>>;
let branchId: string;
let shiftId: string;

// 2026-09-06 is a Sunday. Friday 2026-09-11 is the weekly rest day.
beforeAll(async () => {
  hr = await makeUser('hr_manager');
  branchId = (await makeBranch('فرع المنصور')).id;
  const shift = await api().post('/api/attendance/shifts').set(hr.auth).send({
    code: 'DAY', name: 'الدوام الصباحي', startTime: '08:00', endTime: '16:00', breakMinutes: 30,
    graceMinutes: 10, earlyLeaveGraceMinutes: 5, workingDays: [0, 1, 2, 3, 4, 6], isDefault: true,
  }).expect(201);
  shiftId = shift.body.data.id;
});

describe('attendance', () => {
  it('imports a device export, matches PINs and computes the days', async () => {
    const employee = await makeEmployee(branchId, { attendancePin: '501', shiftId, hireDate: '2026-01-01' });
    const file = [
      '501\t2026-09-06 07:58:00\t0\t1',
      '501\t2026-09-06 07:59:00\t0\t1', // double tap
      '501\t2026-09-06 16:05:00\t1\t1',
      '501\t2026-09-07 08:25:00\t0\t1',
      '501\t2026-09-07 17:30:00\t1\t1',
      '999\t2026-09-07 08:00:00\t0\t1', // unknown PIN
    ].join('\n');
    const imported = await api().post('/api/attendance/imports').set(hr.auth)
      .attach('file', Buffer.from(file), 'attlog.dat').expect(201);
    expect(imported.body.data).toMatchObject({ imported: 6, unmatched: 1, duplicate: 0 });

    // Re-uploading the same export adds nothing.
    const again = await api().post('/api/attendance/imports').set(hr.auth)
      .attach('file', Buffer.from(file), 'attlog.dat').expect(201);
    expect(again.body.data).toMatchObject({ imported: 0, duplicate: 6 });

    await api().post('/api/attendance/compute').set(hr.auth)
      .send({ from: '2026-09-06', to: '2026-09-08', employeeId: employee.id }).expect(200);
    const days = await api().get(`/api/attendance/days?from=2026-09-06&to=2026-09-08&employeeId=${employee.id}`)
      .set(hr.auth).expect(200);
    const byDate = Object.fromEntries(days.body.data.map((day: { workDate: string }) => [day.workDate, day]));
    expect(byDate['2026-09-06']).toMatchObject({ status: 'present', lateMinutes: 0, firstIn: '07:58', lastOut: '16:05' });
    expect(byDate['2026-09-07']).toMatchObject({ status: 'present', lateMinutes: 25, overtimeMinutes: 90 });
    expect(byDate['2026-09-08']).toMatchObject({ status: 'absent' });
  });

  it('links an unmatched PIN to an employee and attaches its punches', async () => {
    const employee = await makeEmployee(branchId, { shiftId, hireDate: '2026-01-01' });
    await api().post('/api/attendance/unmatched/assign').set(hr.auth).send({ pin: '999', employeeId: employee.id }).expect(200);
    const linked = await selectOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM attendance_punches WHERE device_pin = :pin AND employee_id = :id',
      { pin: '999', id: employee.id },
    );
    expect(linked!.count).toBe(1);
    const day = await api().get(`/api/attendance/days?from=2026-09-07&to=2026-09-07&employeeId=${employee.id}`).set(hr.auth);
    expect(day.body.data[0].status).toBe('incomplete');
  });

  it('marks approved leave and lets HR override a day with a reason', async () => {
    const employee = await makeEmployee(branchId, { shiftId, hireDate: '2026-01-01' });
    await api().post('/api/attendance/compute').set(hr.auth)
      .send({ from: '2026-09-13', to: '2026-09-13', employeeId: employee.id }).expect(200);
    await api().put(`/api/attendance/days/${employee.id}/2026-09-13`).set(hr.auth).send({ status: 'present' }).expect(400);
    await api().put(`/api/attendance/days/${employee.id}/2026-09-13`).set(hr.auth)
      .send({ status: 'present', reason: 'عطل في جهاز البصمة' }).expect(200);
    const day = await api().get(`/api/attendance/days?from=2026-09-13&to=2026-09-13&employeeId=${employee.id}`).set(hr.auth);
    expect(day.body.data[0]).toMatchObject({ status: 'present', computedStatus: 'absent', overridden: true });

    // Recomputing keeps the override.
    await api().post('/api/attendance/compute').set(hr.auth)
      .send({ from: '2026-09-13', to: '2026-09-13', employeeId: employee.id }).expect(200);
    const after = await api().get(`/api/attendance/days?from=2026-09-13&to=2026-09-13&employeeId=${employee.id}`).set(hr.auth);
    expect(after.body.data[0].status).toBe('present');
  });

  it('adds and voids manual punches with an audit trail', async () => {
    const employee = await makeEmployee(branchId, { shiftId, hireDate: '2026-01-01', attendancePin: '777' });
    await api().post('/api/attendance/punches').set(hr.auth)
      .send({ employeeId: employee.id, punchedAt: '2026-09-14T08:00' }).expect(400);
    const added = await api().post('/api/attendance/punches').set(hr.auth)
      .send({ employeeId: employee.id, punchedAt: '2026-09-14T08:00', note: 'نسي البصمة - بتأييد المدير' }).expect(201);
    await api().post('/api/attendance/punches').set(hr.auth)
      .send({ employeeId: employee.id, punchedAt: '2026-09-14T16:00', note: 'نسي البصمة' }).expect(201);
    let day = await api().get(`/api/attendance/days?from=2026-09-14&to=2026-09-14&employeeId=${employee.id}`).set(hr.auth);
    expect(day.body.data[0].status).toBe('present');

    await api().post(`/api/attendance/punches/${added.body.data.id}/void`).set(hr.auth).send({ reason: 'إدخال خاطئ' }).expect(200);
    day = await api().get(`/api/attendance/days?from=2026-09-14&to=2026-09-14&employeeId=${employee.id}`).set(hr.auth);
    expect(day.body.data[0].status).toBe('incomplete');
  });

  it('refuses edits to days locked by payroll', async () => {
    const employee = await makeEmployee(branchId, { shiftId, hireDate: '2026-01-01' });
    await api().post('/api/attendance/compute').set(hr.auth)
      .send({ from: '2026-09-15', to: '2026-09-15', employeeId: employee.id }).expect(200);
    const admin = await makeUser('super_admin');
    const run = await selectOne<{ id: string }>(
      `INSERT INTO payroll_runs (id, period, starts_on, ends_on, status, currency, created_by)
       VALUES (gen_random_uuid(), '2019-01', '2019-01-01', '2019-01-31', 'approved', 'IQD', :userId) RETURNING id`,
      { userId: admin.user.id },
    );
    await execute('UPDATE attendance_days SET payroll_run_id = :run WHERE employee_id = :id', { run: run!.id, id: employee.id });
    await api().put(`/api/attendance/days/${employee.id}/2026-09-15`).set(hr.auth)
      .send({ status: 'present', reason: 'تصحيح' }).expect(409);
    await api().post('/api/attendance/punches').set(hr.auth)
      .send({ employeeId: employee.id, punchedAt: '2026-09-15T08:00', note: 'x' }).expect(409);
  });

  it('accepts pushes only from registered devices and computes from them', async () => {
    const employee = await makeEmployee(branchId, { attendancePin: '8801', shiftId, hireDate: '2026-01-01' });
    await api().post('/api/attendance/devices').set(hr.auth)
      .send({ name: 'بصمة المنصور', serialNo: 'CKJE210160', branchId, ipAllowlist: '127.0.0.1, ::1, 10.0.0.0/8' }).expect(201);

    await api().get('/iclock/cdata?SN=UNKNOWN&options=all').expect(403);
    const handshake = await api().get('/iclock/cdata?SN=CKJE210160&options=all').expect(200);
    expect(handshake.text).toContain('TransFlag=TransData AttLog');

    const upload = await api().post('/iclock/cdata?SN=CKJE210160&table=ATTLOG&Stamp=1')
      .set('Content-Type', 'text/plain')
      .send('8801\t2026-09-16 08:02:00\t0\t1\t0\t0\n8801\t2026-09-16 16:00:00\t1\t1\t0\t0\n')
      .expect(200);
    expect(upload.text).toBe('OK: 2');
    await api().post('/iclock/cdata?SN=CKJE210160&table=OPERLOG').set('Content-Type', 'text/plain').send('x').expect(200, 'OK');
    await api().get('/iclock/getrequest?SN=CKJE210160').expect(200, 'OK');

    await api().post('/api/attendance/compute').set(hr.auth)
      .send({ from: '2026-09-16', to: '2026-09-16', employeeId: employee.id }).expect(200);
    const day = await api().get(`/api/attendance/days?from=2026-09-16&to=2026-09-16&employeeId=${employee.id}`).set(hr.auth);
    expect(day.body.data[0]).toMatchObject({ status: 'present', firstIn: '08:02' });
  });

  it('matches device IP allowlists including CIDR ranges', () => {
    expect(ipAllowed('10.20.30.40', '10.0.0.0/8')).toBe(true);
    expect(ipAllowed('::ffff:192.168.1.5', '192.168.1.0/24')).toBe(true);
    expect(ipAllowed('192.168.2.5', '192.168.1.0/24')).toBe(false);
    expect(ipAllowed('1.2.3.4', null)).toBe(true);
  });

  it('confines branch managers to their branch', async () => {
    const otherBranch = await makeBranch('فرع البصرة');
    const outsider = await makeEmployee(otherBranch.id, { shiftId, hireDate: '2026-01-01' });
    const manager = await makeUser('branch_manager', branchId);
    await api().get(`/api/attendance/days?from=2026-09-06&to=2026-09-16&employeeId=${outsider.id}`).set(manager.auth)
      .expect(200).then((result) => expect(result.body.data).toHaveLength(0));
    await api().post('/api/attendance/compute').set(manager.auth).send({ from: '2026-09-06', to: '2026-09-06' }).expect(403);
  });
});
