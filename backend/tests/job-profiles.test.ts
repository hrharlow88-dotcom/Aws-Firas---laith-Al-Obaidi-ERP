import { beforeAll, describe, expect, it } from 'vitest';
import { select, selectOne } from '../src/db/query';
import { api, makeBranch, makeUser } from './helpers';

const kpi = (en: string, w: number) => ({ en, ar: `${en} ع`, t_en: '≥ 90%', t_ar: '≥ 90%', m_en: 'CRM', m_ar: 'CRM', f_en: 'Monthly', f_ar: 'شهري', w });
const file = (jobs: unknown[]) => ({
  format: 'lo-hr.jd-kpi', version: 1, exportedAt: '2026-10-15 12:00:00', source: 'https://alobaidi-hr.github.io',
  departments: [{ no: 12, en: 'CRM', ar: 'علاقات العملاء' }, { no: 99, en: 'Ghost', ar: 'قسم غير موجود' }],
  jobs,
});
const job = (code: string, dept: number, weights: number[]) => ({
  code, dept, en: `Title ${code}`, ar: `مسمى ${code}`,
  b: {
    purpose: ['Purpose', 'الغرض'], duties: [['Duty one', 'المهمة الأولى']],
    kpis: weights.map((w, i) => kpi(`KPI ${i + 1}`, w)),
    qual: { Education: ['BA', 'بكالوريوس'], Experience: ['3 years', '3 سنوات'], Languages: ['Arabic', 'العربية'] },
    tech: [['CRM', 'نظام CRM']], beh: [['Empathy', 'التعاطف']],
    ov: { 'Reports To': ['Head', 'المدير'], Grade: ['Level 3 — Supervisor / المستوى 3 — إشرافي'], Branches: ['Baghdad'], Headcount: ['1'], 'Employment Type': ['Full-time'] },
  },
});

let hr: Awaited<ReturnType<typeof makeUser>>;
let crmDeptId: string;

beforeAll(async () => {
  hr = await makeUser('hr_manager');
  await makeBranch();
  crmDeptId = (await api().post('/api/org/departments').set(hr.auth).send({ code: 'crm', name: 'علاقات العملاء' }).expect(201)).body.data.id;
  await api().post('/api/org/job-titles').set(hr.auth).send({ code: 'LO-CRM-01', name: 'تنفيذي علاقات العملاء (ERP)' }).expect(201);
});

describe('job descriptions and KPIs from the performance portal', () => {
  it('previews an import without writing', async () => {
    const res = await api().post('/api/org/job-profiles/import').set(hr.auth)
      .send({ dryRun: true, file: file([job('LO-CRM-01', 12, [60, 40]), job('LO-CRM-03', 12, [50, 30]), job('LO-X-01', 99, [100])]) }).expect(200);
    expect(res.body.data).toMatchObject({ dryRun: true, jobs: 3, newProfiles: 3, updatedProfiles: 0 });
    expect(res.body.data.newTitles).toEqual(['LO-CRM-03', 'LO-X-01']);
    expect(res.body.data.unmatchedDepartments).toEqual(['قسم غير موجود']);
    expect(res.body.data.weightWarnings).toEqual(['LO-CRM-03 (80%)']);
    expect(await selectOne('SELECT 1 FROM job_titles WHERE code = :c', { c: 'LO-CRM-03' })).toBeNull();
  });

  it('imports: creates missing titles by code, keeps existing names, matches departments by name', async () => {
    await api().post('/api/org/job-profiles/import').set(hr.auth)
      .send({ file: file([job('LO-CRM-01', 12, [60, 40]), job('lo-crm-03', 12, [70, 30])]) }).expect(200);
    const titles = await select<{ code: string; name: string; departmentId: string | null; grade: string | null }>(
      `SELECT code, name, department_id AS "departmentId", grade FROM job_titles WHERE code IN ('LO-CRM-01','LO-CRM-03') ORDER BY code`,
    );
    expect(titles[0]).toMatchObject({ name: 'تنفيذي علاقات العملاء (ERP)', departmentId: crmDeptId });
    expect(titles[1]).toMatchObject({ name: 'مسمى lo-crm-03', departmentId: crmDeptId, grade: 'L3' });
    const list = await api().get('/api/org/job-profiles').set(hr.auth).expect(200);
    expect(list.body.data.items).toHaveLength(2);
    expect(list.body.data.portalUrl).toBe('https://alobaidi-hr.github.io');
    const id = list.body.data.items.find((i: { code: string }) => i.code === 'LO-CRM-03').jobTitleId;
    const one = await api().get(`/api/org/job-titles/${id}/profile`).set(hr.auth).expect(200);
    expect(one.body.data.kpis).toHaveLength(2);
    expect(one.body.data.kpiWeight).toBe(100);
    expect(one.body.data.qualifications.education).toEqual(['BA', 'بكالوريوس']);
  });

  it('re-importing updates profiles instead of duplicating them and is audited', async () => {
    const res = await api().post('/api/org/job-profiles/import').set(hr.auth)
      .send({ file: file([job('LO-CRM-03', 12, [100])]) }).expect(200);
    expect(res.body.data).toMatchObject({ updatedProfiles: 1, newProfiles: 0 });
    const count = await selectOne<{ n: number }>('SELECT count(*)::int AS n FROM job_profiles');
    expect(count!.n).toBe(2);
    const audit = await selectOne("SELECT 1 FROM audit_logs WHERE action = 'job_profiles.imported'");
    expect(audit).not.toBeNull();
  });

  it('rejects other files, bad codes are counted, and only org.manage may import', async () => {
    await api().post('/api/org/job-profiles/import').set(hr.auth).send({ file: { format: 'other', jobs: [] } }).expect(400);
    const res = await api().post('/api/org/job-profiles/import').set(hr.auth)
      .send({ dryRun: true, file: file([job('bad code;', 12, [100]), job('LO-OK-1', 12, [100])]) }).expect(200);
    expect(res.body.data).toMatchObject({ jobs: 1, invalid: 1 });
    const viewer = await makeUser('viewer');
    await api().post('/api/org/job-profiles/import').set(viewer.auth).send({ file: file([job('LO-V-1', 12, [100])]) }).expect(403);
    await api().get('/api/org/job-profiles').set(viewer.auth).expect(200);
  });

  it('returns 404 for a title without a profile', async () => {
    const t = await api().post('/api/org/job-titles').set(hr.auth).send({ code: 'NOPROF', name: 'بدون وصف' }).expect(201);
    await api().get(`/api/org/job-titles/${t.body.data.id}/profile`).set(hr.auth).expect(404);
  });
});
