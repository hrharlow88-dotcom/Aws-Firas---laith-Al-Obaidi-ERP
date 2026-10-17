import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { selectOne } from '../src/db/query';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

let hr: Awaited<ReturnType<typeof makeUser>>;
let a: { id: string; employeeNo: string };
let b: { id: string; employeeNo: string };
let c: { id: string; employeeNo: string };
let branchName: string;

async function sheet(rows: Array<Array<string>>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('الهيكل');
  ws.addRow(['رقم الموظف', 'الاسم (للمرجع فقط)', 'رقم المدير المباشر', 'اسم المدير (للمرجع فقط)', 'القسم', 'الشعبة', 'المسمى الوظيفي', 'الفرع']);
  rows.forEach((row) => ws.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

beforeAll(async () => {
  hr = await makeUser('hr_manager');
  const branch = await makeBranch('فرع الهيكل');
  branchName = branch.name;
  const parent = await api().post('/api/org/departments').set(hr.auth).send({ code: 'IMP-SAL', name: 'مبيعات الاستيراد' }).expect(201);
  await api().post('/api/org/departments').set(hr.auth).send({ code: 'IMP-SAL-T', name: 'فريق المعرض', parentId: parent.body.data.id }).expect(201);
  a = await makeEmployee(branch.id, { fullName: 'مدير المبيعات' });
  b = await makeEmployee(branch.id, { fullName: 'مشرف المعرض' });
  c = await makeEmployee(branch.id, { fullName: 'مندوب' });
});

describe('importing reporting lines and structure from Excel', () => {
  it('previews every change, refuses a file that would create a reporting loop, then applies a clean one', async () => {
    const looping = await sheet([
      [b.employeeNo, '', a.employeeNo, '', '', '', '', ''],
      [c.employeeNo, '', b.employeeNo, '', 'مبيعات الاستيراد', 'فريق المعرض', 'مندوب مبيعات معارض', branchName],
      [a.employeeNo, '', c.employeeNo, '', '', '', '', ''],
      ['NO-SUCH', '', '', '', '', '', '', ''],
    ]);
    const preview = await api().post('/api/org/import/preview').set(hr.auth).attach('file', looping, 'org.xlsx').expect(200);
    const rows = preview.body.data.rows as Array<{ employeeNo: string; errors: string[]; changes: Array<{ field: string; to: string }> }>;
    expect(rows.find((row) => row.employeeNo === 'NO-SUCH')!.errors[0]).toContain('غير موجود');
    expect(rows.some((row) => row.errors.some((error) => error.includes('حلقة')))).toBe(true);
    expect(preview.body.data.newJobTitles).toEqual(['مندوب مبيعات معارض']);
    // Nothing is written while there are errors.
    await api().post('/api/org/import/apply').set(hr.auth).attach('file', looping, 'org.xlsx').expect(400);
    expect((await selectOne<{ m: string | null }>('SELECT manager_id AS m FROM employees WHERE id = :id', { id: b.id }))!.m).toBeNull();

    const clean = await sheet([
      [b.employeeNo, '', a.employeeNo, '', '', '', '', ''],
      [c.employeeNo, '', b.employeeNo, '', 'مبيعات الاستيراد', 'فريق المعرض', 'مندوب مبيعات معارض', branchName],
    ]);
    const ok = await api().post('/api/org/import/preview').set(hr.auth).attach('file', clean, 'org.xlsx').expect(200);
    expect(ok.body.data.summary).toMatchObject({ rows: 2, changed: 2, errors: 0, managerChanges: 2 });
    const applied = await api().post('/api/org/import/apply').set(hr.auth).attach('file', clean, 'org.xlsx').expect(200);
    expect(applied.body.data.updated).toBe(2);
    const after = await selectOne<{ manager: string; dept: string; position: string }>(
      `SELECT m.employee_no AS manager, d.name AS dept, e."position" AS position
       FROM employees e JOIN employees m ON m.id = e.manager_id JOIN departments d ON d.id = e.department_id WHERE e.id = :id`,
      { id: c.id },
    );
    expect(after).toEqual({ manager: b.employeeNo, dept: 'فريق المعرض', position: 'مندوب مبيعات معارض' });

    // Uploading the same file again changes nothing.
    const again = await api().post('/api/org/import/preview').set(hr.auth).attach('file', clean, 'org.xlsx').expect(200);
    expect(again.body.data.summary).toMatchObject({ changed: 0, unchanged: 2 });
  });

  it('exports the current structure as the template', async () => {
    const res = await api().get('/api/org/import/template.xlsx').set(hr.auth)
      .buffer(true).parse((stream, done) => { const chunks: Buffer[] = []; stream.on('data', (chunk: Buffer) => chunks.push(chunk)); stream.on('end', () => done(null, Buffer.concat(chunks))); })
      .expect(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body as ArrayBuffer);
    const rows: string[][] = [];
    workbook.worksheets[0].eachRow((row) => rows.push((row.values as ExcelJS.CellValue[]).slice(1).map((value) => String(value ?? ''))));
    const line = rows.find((row) => row[0] === c.employeeNo)!;
    expect(line.slice(2, 3)).toEqual([b.employeeNo]);
    expect(line.slice(4, 6)).toEqual(['مبيعات الاستيراد', 'فريق المعرض']);
    const viewer = await makeUser('employee');
    await api().get('/api/org/import/template.xlsx').set(viewer.auth).expect(403);
  });
});
