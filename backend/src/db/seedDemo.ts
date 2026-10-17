import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { sequelize } from '../models';
import { execute, selectOne } from './query';

/**
 * Fills the DEMO copy of the system with made-up companies, branches, people,
 * fingerprints and a calculated payroll so a guest has something to look at.
 * It talks to the running API as the owner, so every rule and audit entry applies.
 * Refuses unless DEMO_MODE=true and the database has no employees yet.
 *
 *   docker compose --env-file companies/demo.env -f docker-compose.company.yml exec api node dist/db/seedDemo.js
 */
const BASE = `http://127.0.0.1:${process.env.PORT || 5000}/api`;
let token = '';

async function call<T = { data: { id: string } }>(path: string, options: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method || (options.body || options.form ? 'POST' : 'GET'),
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
    body: options.form ?? (options.body ? JSON.stringify(options.body) : undefined),
  });
  const json = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(`${path} → ${response.status} ${json.message ?? ''}`);
  return json as T;
}
async function optional(label: string, work: () => Promise<unknown>): Promise<void> {
  try { await work(); } catch (error) { console.warn(`skipped ${label}: ${error instanceof Error ? error.message : error}`); }
}
const pad = (n: number) => String(n).padStart(2, '0');

async function main(): Promise<void> {
  if (process.env.DEMO_MODE !== 'true') throw new Error('This copy is not a demo copy (DEMO_MODE is not true). Nothing was changed.');
  const existing = await selectOne<{ count: string }>('SELECT count(*) AS count FROM employees');
  if (Number(existing?.count) > 0) throw new Error('The demo copy already has employees. Nothing was changed.');
  const owner = await selectOne<{ id: string; token_version: number }>(
    "SELECT id, token_version FROM users WHERE role = 'super_admin' AND is_active ORDER BY created_at LIMIT 1");
  if (!owner) throw new Error('No owner account.');
  await execute('UPDATE users SET last_seen_at = now() WHERE id = :id', { id: owner.id });
  token = jwt.sign({ sub: owner.id, ver: owner.token_version }, process.env.JWT_SECRET!, { expiresIn: '20m' });

  const now = new Date();
  const year = now.getUTCFullYear();
  const prev = new Date(Date.UTC(year, now.getUTCMonth() - 1, 1));
  const prevPeriod = `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}`;
  const today = `${year}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;

  const settings = (await call<{ data: Record<string, any> }>('/settings')).data;
  settings.company.displayName = 'مجموعة النخبة التجريبية';
  settings.company.legalName = 'مجموعة النخبة التجريبية للسيارات (بيانات وهمية)';
  settings.company.address = 'بغداد - عنوان تجريبي';
  settings.company.currency = 'IQD';
  if (settings.payrollRules) settings.payrollRules.launchPeriod = null;
  await call('/settings', { method: 'PUT', body: settings });

  const companies: string[] = [];
  for (const [code, nameAr, nameEn] of [['DEMO-A', 'شركة النخبة للسيارات (تجريبية)', 'Elite Motors (demo)'], ['DEMO-B', 'شركة الرافدين للصيانة (تجريبية)', 'Rafidain Service (demo)']]) {
    companies.push((await call('/companies', { body: { code, nameAr, nameEn, brandIds: [] } })).data.id);
  }
  const branches: string[] = [];
  for (const [i, [code, name, city]] of [['D-BGD1', 'معرض بغداد التجريبي', 'بغداد'], ['D-BGD2', 'ورشة بغداد التجريبية', 'بغداد'], ['D-EBL', 'معرض أربيل التجريبي', 'أربيل'], ['D-BSR', 'معرض البصرة التجريبي', 'البصرة']].entries()) {
    const id = (await call('/branches', { body: { code, name, city } })).data.id;
    await call(`/branches/${id}`, { method: 'PUT', body: { companyId: companies[i === 1 ? 1 : 0] } });
    branches.push(id);
  }
  const dept: Record<string, string> = {};
  for (const [code, name, cc, parent] of [['MGMT', 'الإدارة العامة', 'CC-MGMT'], ['SALES', 'المبيعات', 'CC-SALES'], ['SVC', 'الصيانة', 'CC-SVC'],
    ['PARTS', 'قطع الغيار', 'CC-PARTS', 'SVC'], ['FIN', 'المالية', 'CC-FIN'], ['HR', 'الموارد البشرية', 'CC-HR']] as Array<[string, string, string, string?]>) {
    dept[code] = (await call('/org/departments', { body: { code, name, costCenterCode: cc, parentId: parent ? dept[parent] : null } })).data.id;
  }
  const title: Record<string, string> = {};
  for (const [code, name, d, grade] of [['GM', 'المدير العام', 'MGMT', 'G1'], ['SALES-MGR', 'مدير المبيعات', 'SALES', 'G2'], ['SALES-REP', 'مستشار مبيعات', 'SALES', 'G4'],
    ['SVC-MGR', 'مدير الصيانة', 'SVC', 'G2'], ['TECH', 'فني صيانة', 'SVC', 'G5'], ['PARTS', 'أمين مخزن', 'PARTS', 'G5'], ['ACCT', 'محاسب', 'FIN', 'G4'], ['HR', 'موظف موارد بشرية', 'HR', 'G4']]) {
    title[code] = (await call('/org/job-titles', { body: { code, name, departmentId: dept[d], grade } })).data.id;
  }
  const shift = (await call('/attendance/shifts', { body: { code: 'MORNING', name: 'الدوام الصباحي', startTime: '08:30', endTime: '16:30', breakMinutes: 30,
    graceMinutes: 10, earlyLeaveGraceMinutes: 5, workingDays: [0, 1, 2, 3, 4, 6], isDefault: true } })).data.id;

  // Every name and number below is invented.
  const people: Array<[string, string, string, string, number, number, string]> = [
    ['D-101', 'عمر سامي الجبوري', 'GM', 'MGMT', 0, 5000000, 'permanent'],
    ['D-102', 'رنا خالد العزاوي', 'SALES-MGR', 'SALES', 0, 2200000, 'permanent'],
    ['D-103', 'حسين مهدي الربيعي', 'SALES-REP', 'SALES', 0, 1000000, 'permanent'],
    ['D-104', 'دعاء فراس الدليمي', 'SALES-REP', 'SALES', 2, 1000000, 'probation'],
    ['D-105', 'باسم نزار الكعبي', 'SALES-REP', 'SALES', 3, 950000, 'permanent'],
    ['D-106', 'وسام طارق الشمري', 'SVC-MGR', 'SVC', 1, 2000000, 'permanent'],
    ['D-107', 'عباس جواد الحلي', 'TECH', 'SVC', 1, 850000, 'permanent'],
    ['D-108', 'مرتضى صادق البياتي', 'TECH', 'SVC', 1, 25000, 'daily'],
    ['D-109', 'هبة ثامر العبيدي', 'ACCT', 'FIN', 0, 1200000, 'permanent'],
    ['D-110', 'آية رياض الساعدي', 'HR', 'HR', 0, 1100000, 'permanent'],
    ['D-111', 'منتظر كريم الموسوي', 'PARTS', 'PARTS', 1, 900000, 'fixed_term'],
    ['D-112', 'أنس وليد التميمي', 'SALES-REP', 'SALES', 2, 1000000, 'permanent'],
  ];
  const ids: Record<string, string> = {};
  for (const [no, fullName, t, d, b, salary, type] of people) {
    const hireDate = no === 'D-104' ? `${prevPeriod}-10` : '2023-02-01';
    const id = (await call('/employees', { body: { employeeNo: no, fullName, branchId: branches[b], hireDate, departmentId: dept[d],
      jobTitleId: title[t], employmentType: type, shiftId: shift, attendancePin: no.slice(2), phone: `07700000${no.slice(2)}` } })).data.id;
    ids[no] = id;
    await call(`/employees/${id}/compensation`, { body: { effectiveFrom: hireDate, grossSalary: salary, currency: 'IQD', reason: 'راتب التعيين (وهمي)' } });
  }
  for (const [no, manager] of [['D-102', 'D-101'], ['D-106', 'D-101'], ['D-109', 'D-101'], ['D-110', 'D-101'], ['D-103', 'D-102'], ['D-104', 'D-102'],
    ['D-105', 'D-102'], ['D-112', 'D-102'], ['D-107', 'D-106'], ['D-108', 'D-106'], ['D-111', 'D-106']]) {
    await call(`/employees/${ids[no]}`, { method: 'PUT', body: { managerId: ids[manager] } });
  }

  await optional('fingerprints', async () => {
    const lines: string[] = [];
    let seed = 11;
    const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    const days = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0)).getUTCDate();
    for (const [no] of people) {
      for (let day = 1; day <= days; day++) {
        const date = `${prevPeriod}-${pad(day)}`;
        if (new Date(`${date}T00:00:00Z`).getUTCDay() === 5 || rand() < 0.04) continue;
        if (no === 'D-104' && day < 10) continue;
        const inMin = 8 * 60 + 15 + Math.floor(rand() * (no === 'D-107' ? 45 : 25));
        const outMin = 16 * 60 + 30 + Math.floor(rand() * 40);
        lines.push(`${no.slice(2)}\t${date} ${pad(Math.floor(inMin / 60))}:${pad(inMin % 60)}:00\t0\t1`);
        lines.push(`${no.slice(2)}\t${date} ${pad(Math.floor(outMin / 60))}:${pad(outMin % 60)}:00\t1\t1`);
      }
    }
    const form = new FormData();
    form.append('file', new Blob([lines.join('\n')]), `attlog-${prevPeriod}.dat`);
    await call('/attendance/imports', { form });
  });
  await optional('payroll', async () => {
    const run = (await call('/payroll/runs', { body: { period: prevPeriod } })).data.id;
    await call(`/payroll/runs/${run}/calculate`, { body: {} });
  });
  await optional('announcement', () => call('/announcements', { body: {
    titleAr: 'أهلاً بك في النسخة التجريبية', titleEn: 'Welcome to the demo',
    bodyAr: 'هذه نسخة عرض ببيانات وهمية بالكامل. جرّب التطبيقات بحرية، فلا شيء هنا حقيقي.',
    bodyEn: 'This is a demo copy with entirely made-up data. Explore freely; nothing here is real.',
    kind: 'announcement', severity: 'info', audience: 'all', requireAck: false,
  } }));
  await optional('calendar', async () => {
    for (const [offset, t, category] of [[2, 'اجتماع مدراء الفروع', 'meeting'], [5, 'دورة خدمة العملاء', 'training'], [9, 'إطلاق موديل جديد', 'event']] as Array<[number, string, string]>) {
      const day = new Date(now.getTime() + offset * 86400000);
      const date = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
      await call('/calendar/events', { body: { title: t, category, start: `${date}T10:00`, end: `${date}T11:30`, visibility: 'company' } });
    }
  });
  await optional('chat', async () => {
    const channels = await call<{ data: { channels: Array<{ id: string; name: string }> } }>('/chat/channels');
    const general = channels.data.channels[0];
    if (general) await call(`/chat/channels/${general.id}/messages`, { body: { body: `مرحباً بالجميع في النسخة التجريبية (${today}) 👋` } });
  });
  console.log(`Demo data ready: ${companies.length} companies, ${branches.length} branches, ${people.length} employees.`);
}

void main().then(() => sequelize.close()).catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await sequelize.close().catch(() => undefined);
  process.exitCode = 1;
});
