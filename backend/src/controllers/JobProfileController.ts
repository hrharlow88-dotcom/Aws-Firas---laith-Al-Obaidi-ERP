import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { execute, select, selectOne, transaction } from '../db/query';
import { recordAudit } from '../utils/audit';
import { badRequest, body, notFound } from '../utils/http';

/**
 * Job descriptions and KPIs from the L-O performance portal
 * (https://alobaidi-hr.github.io). The portal exports a JSON file
 * ("lo-hr.jd-kpi"); importing it here creates any missing job titles by their
 * shared code and stores one profile per title. Evaluations stay in the
 * portal, which the ERP opens from the job profile.
 */

export const IMPORT_FORMAT = 'lo-hr.jd-kpi';
const MAX_JOBS = 500;

type Pair = [string, string];

interface Kpi {
  en: string; ar: string; t_en: string; t_ar: string; m_en: string; m_ar: string; f_en: string; f_ar: string; w: number;
}

interface CleanJob {
  code: string;
  dept: number | null;
  en: string;
  ar: string;
  purpose: Pair;
  duties: Pair[];
  kpis: Kpi[];
  qualifications: Record<string, Pair>;
  technical: Pair[];
  behavioural: Pair[];
  overview: Record<string, string[]>;
  weight: number;
}

const text = (value: unknown, max: number): string => (typeof value === 'string' || typeof value === 'number'
  ? String(value).trim().slice(0, max) : '');
const pair = (value: unknown, max: number): Pair => {
  const list = Array.isArray(value) ? value : [];
  return [text(list[0], max), text(list[1], max)];
};
const pairs = (value: unknown, max = 600): Pair[] => (Array.isArray(value) ? value : [])
  .map((item) => pair(item, max)).filter((item) => item[0] || item[1]).slice(0, 40);

export function portalUrl(): string {
  return (process.env.PERFORMANCE_PORTAL_URL || 'https://alobaidi-hr.github.io').replace(/\/+$/, '');
}

export function cleanImportJob(raw: unknown): CleanJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const job = raw as Record<string, unknown>;
  const code = text(job.code, 24).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,23}$/.test(code)) return null;
  const b = (job.b && typeof job.b === 'object' ? job.b : {}) as Record<string, unknown>;
  const kpis: Kpi[] = (Array.isArray(b.kpis) ? b.kpis : []).slice(0, 15).map((item) => {
    const k = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const w = Number(k.w);
    return {
      en: text(k.en, 300), ar: text(k.ar, 300), t_en: text(k.t_en, 300), t_ar: text(k.t_ar, 300),
      m_en: text(k.m_en, 300), m_ar: text(k.m_ar, 300), f_en: text(k.f_en, 60), f_ar: text(k.f_ar, 60),
      w: Number.isFinite(w) && w > 0 && w <= 100 ? Math.round(w * 100) / 100 : 0,
    };
  }).filter((k) => k.en || k.ar);
  const q = (b.qual && typeof b.qual === 'object' ? b.qual : {}) as Record<string, unknown>;
  const o = (b.ov && typeof b.ov === 'object' ? b.ov : {}) as Record<string, unknown>;
  const overview: Record<string, string[]> = {};
  for (const key of ['Reports To', 'Grade', 'Branches', 'Headcount', 'Employment Type']) {
    const value = Array.isArray(o[key]) ? (o[key] as unknown[]).map((item) => text(item, 200)).filter(Boolean).slice(0, 2) : [];
    if (value.length) overview[key] = value;
  }
  const dept = Number(job.dept);
  return {
    code,
    dept: Number.isInteger(dept) ? dept : null,
    en: text(job.en, 150),
    ar: text(job.ar, 150),
    purpose: pair(b.purpose, 1500),
    duties: pairs(b.duties),
    kpis,
    qualifications: {
      education: pair(q.Education, 600),
      experience: pair(q.Experience, 600),
      languages: pair(q.Languages, 600),
    },
    technical: pairs(b.tech),
    behavioural: pairs(b.beh),
    overview,
    weight: Math.round(kpis.reduce((sum, k) => sum + k.w, 0) * 100) / 100,
  };
}

/** "Level 3 — Supervisor / المستوى 3 — إشرافي" → "L3" (job_titles.grade is short). */
function gradeOf(job: CleanJob): string | null {
  const grade = job.overview.Grade?.[0] || '';
  const level = grade.match(/Level\s*(\d+)/i);
  return level ? `L${level[1]}` : (grade.slice(0, 20) || null);
}

interface DepartmentRef { id: string; code: string; name: string }

/**
 * The portal and the payroll register name a few departments differently; the
 * portal splits fleet, warehouses and security out of logistics, which the ERP
 * keeps as sections. Portal name → ERP name.
 */
const DEPARTMENT_ALIASES: Record<string, string> = {
  'المالية والمحاسبة': 'المالية والحسابات',
  'أسطول النقل': 'النقل',
  'المستودعات': 'المخازن',
  'الأمن': 'الأمن والحراسة',
};

function matchDepartment(departments: DepartmentRef[], fileDept: { en?: string; ar?: string } | undefined, no: number | null) {
  const alias = fileDept?.ar ? DEPARTMENT_ALIASES[fileDept.ar.trim()] : undefined;
  const names = [alias, fileDept?.ar, fileDept?.en].filter(Boolean).map((name) => String(name).trim().toLowerCase());
  return departments.find((d) => names.includes(d.name.trim().toLowerCase()))
    ?? (no !== null ? departments.find((d) => d.code === `LO-D${no}`) : undefined)
    ?? null;
}

export class JobProfileController {
  static async list(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT j.id AS "jobTitleId", j.code, j.name, j.grade, d.name AS "departmentName",
              p.title_en AS "titleEn", jsonb_array_length(p.kpis)::int AS "kpiCount", p.kpi_weight_total::float AS "kpiWeight",
              p.imported_at AS "importedAt",
              (SELECT count(*)::int FROM employees e WHERE e.job_title_id = j.id AND e.employment_status <> 'inactive') AS "employeeCount"
       FROM job_profiles p
       JOIN job_titles j ON j.id = p.job_title_id
       LEFT JOIN departments d ON d.id = j.department_id
       ORDER BY d.name NULLS LAST, j.code`,
    );
    const last = await selectOne<{ at: string | null; exportedAt: string | null }>(
      `SELECT max(imported_at) AS at, max(source_exported_at) AS "exportedAt" FROM job_profiles`,
    );
    res.json({ data: { items: rows, portalUrl: portalUrl(), lastImportAt: last?.at ?? null, sourceExportedAt: last?.exportedAt ?? null } });
  }

  static async get(req: Request, res: Response): Promise<void> {
    const row = await selectOne(
      `SELECT j.id AS "jobTitleId", j.code, j.name, j.grade, d.name AS "departmentName",
              p.title_en AS "titleEn", p.title_ar AS "titleAr", p.purpose_ar AS "purposeAr", p.purpose_en AS "purposeEn",
              p.duties, p.kpis, p.qualifications, p.technical, p.behavioural, p.overview,
              p.kpi_weight_total::float AS "kpiWeight", p.imported_at AS "importedAt"
       FROM job_profiles p
       JOIN job_titles j ON j.id = p.job_title_id
       LEFT JOIN departments d ON d.id = j.department_id
       WHERE j.id = :id`,
      { id: req.params.id },
    );
    if (!row) throw notFound('لا يوجد وصف وظيفي ومؤشرات لهذا المسمى بعد. استورد ملف الأوصاف من بوابة الأداء.');
    res.json({ data: { ...row, portalUrl: portalUrl() } });
  }

  /**
   * POST /api/org/job-profiles/import  { file: <exported JSON>, dryRun?: boolean }
   * dryRun returns the plan (new titles, updated profiles, unmatched departments) without writing.
   */
  static async import(req: Request, res: Response): Promise<void> {
    const input = body(req);
    const file = (input.file && typeof input.file === 'object' ? input.file : null) as Record<string, unknown> | null;
    if (!file || file.format !== IMPORT_FORMAT) {
      throw badRequest('الملف ليس ملف أوصاف ومؤشرات من بوابة الأداء (lo-hr.jd-kpi).');
    }
    const rawJobs = Array.isArray(file.jobs) ? file.jobs : [];
    if (!rawJobs.length) throw badRequest('الملف لا يحتوي على أوصاف وظيفية.');
    if (rawJobs.length > MAX_JOBS) throw badRequest(`الحد الأقصى ${MAX_JOBS} وصفاً في الملف الواحد.`);
    const jobs = rawJobs.map(cleanImportJob);
    const invalid = jobs.filter((job) => !job).length;
    const valid = jobs.filter((job): job is CleanJob => Boolean(job));
    const seen = new Set<string>();
    for (const job of valid) {
      if (seen.has(job.code)) throw badRequest(`الرمز ${job.code} مكرر في الملف.`);
      seen.add(job.code);
    }
    const fileDepartments = new Map<number, { en?: string; ar?: string }>();
    for (const item of Array.isArray(file.departments) ? file.departments : []) {
      const d = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      if (Number.isInteger(Number(d.no))) fileDepartments.set(Number(d.no), { en: text(d.en, 120), ar: text(d.ar, 120) });
    }
    const departments = await select<DepartmentRef>('SELECT id, code, name FROM departments');
    const titles = await select<{ id: string; code: string; departmentId: string | null }>(
      'SELECT id, code, department_id AS "departmentId" FROM job_titles',
    );
    const titleByCode = new Map(titles.map((title) => [title.code.toUpperCase(), title]));
    const profiled = new Set((await select<{ id: string }>('SELECT job_title_id AS id FROM job_profiles')).map((row) => row.id));

    const unmatched = new Set<string>();
    const plan = valid.map((job) => {
      const fileDept = job.dept !== null ? fileDepartments.get(job.dept) : undefined;
      const department = matchDepartment(departments, fileDept, job.dept);
      if (!department && fileDept) unmatched.add(fileDept.ar || fileDept.en || String(job.dept));
      const existing = titleByCode.get(job.code);
      return { job, department, existing };
    });
    const summary = {
      jobs: valid.length,
      invalid,
      newTitles: plan.filter((item) => !item.existing).map((item) => item.job.code),
      newProfiles: plan.filter((item) => !item.existing || !profiled.has(item.existing.id)).length,
      updatedProfiles: plan.filter((item) => item.existing && profiled.has(item.existing.id)).length,
      unmatchedDepartments: [...unmatched],
      weightWarnings: valid.filter((job) => job.kpis.length && Math.abs(job.weight - 100) > 0.01).map((job) => `${job.code} (${job.weight}%)`),
    };
    if (input.dryRun === true) {
      res.json({ data: { dryRun: true, ...summary } });
      return;
    }

    const exportedAt = text(file.exportedAt, 40) || null;
    await transaction(async (tx) => {
      for (const { job, department, existing } of plan) {
        let titleId = existing?.id;
        if (!titleId) {
          titleId = randomUUID();
          await execute(
            `INSERT INTO job_titles (id, code, name, department_id, grade, description)
             VALUES (:id, :code, :name, :departmentId, :grade, :description)`,
            {
              id: titleId,
              code: job.code,
              name: (job.ar || job.en).slice(0, 120),
              departmentId: department?.id ?? null,
              grade: gradeOf(job),
              description: (job.purpose[1] || job.purpose[0]).slice(0, 2000) || null,
            },
            tx,
          );
        } else if (!existing!.departmentId && department) {
          await execute('UPDATE job_titles SET department_id = :departmentId, updated_at = now() WHERE id = :id',
            { id: titleId, departmentId: department.id }, tx);
        }
        await execute(
          `INSERT INTO job_profiles (job_title_id, title_en, title_ar, purpose_en, purpose_ar, duties, kpis, qualifications,
                                     technical, behavioural, overview, kpi_weight_total, source_exported_at, imported_at, imported_by)
           VALUES (:id, :en, :ar, :purposeEn, :purposeAr, CAST(:duties AS jsonb), CAST(:kpis AS jsonb), CAST(:qualifications AS jsonb),
                   CAST(:technical AS jsonb), CAST(:behavioural AS jsonb), CAST(:overview AS jsonb), :weight, :exportedAt, now(), :userId)
           ON CONFLICT (job_title_id) DO UPDATE SET
             title_en = EXCLUDED.title_en, title_ar = EXCLUDED.title_ar, purpose_en = EXCLUDED.purpose_en,
             purpose_ar = EXCLUDED.purpose_ar, duties = EXCLUDED.duties, kpis = EXCLUDED.kpis,
             qualifications = EXCLUDED.qualifications, technical = EXCLUDED.technical, behavioural = EXCLUDED.behavioural,
             overview = EXCLUDED.overview, kpi_weight_total = EXCLUDED.kpi_weight_total,
             source_exported_at = EXCLUDED.source_exported_at, imported_at = now(), imported_by = EXCLUDED.imported_by`,
          {
            id: titleId,
            en: job.en || null,
            ar: job.ar || null,
            purposeEn: job.purpose[0] || null,
            purposeAr: job.purpose[1] || null,
            duties: JSON.stringify(job.duties),
            kpis: JSON.stringify(job.kpis),
            qualifications: JSON.stringify(job.qualifications),
            technical: JSON.stringify(job.technical),
            behavioural: JSON.stringify(job.behavioural),
            overview: JSON.stringify(job.overview),
            weight: job.weight,
            exportedAt,
            userId: req.user!.id,
          },
          tx,
        );
      }
      await recordAudit(req, tx, 'job_profiles.imported', 'job_profile', null, {
        jobs: summary.jobs, newTitles: summary.newTitles.length, exportedAt,
      });
    });
    res.json({ data: { dryRun: false, ...summary } });
  }
}

export default JobProfileController;
