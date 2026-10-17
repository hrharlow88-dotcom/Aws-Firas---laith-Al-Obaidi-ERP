import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { execute, select, selectOne, transaction } from '../db/query';
import { contentDisposition, openStoredFile, sniffFile, storedFileExists, storeFile, uploadedName } from '../services/storage';
import { recordAudit } from '../utils/audit';
import {
  assertOnlyKeys, badRequest, body, conflict, notFound, optionalNumber, optionalText, requiredText,
} from '../utils/http';
import { isDateOnly, isUuid } from '../utils/validation';

export const STAGES = ['new', 'screening', 'interview1', 'interview2', 'offer', 'hired', 'refused'] as const;
const STAGE_AR: Record<string, string> = {
  new: 'جديد', screening: 'فرز أولي', interview1: 'مقابلة أولى', interview2: 'مقابلة ثانية', offer: 'عرض عمل', hired: 'تم التعيين', refused: 'مرفوض',
};
const SOURCES = ['website', 'linkedin', 'referral', 'walk_in', 'facebook', 'agency', 'other'];

const APPLICANT_COLUMNS = `
  a.id, a.position_id AS "positionId", p.title AS "positionTitle", a.full_name AS "fullName", a.email, a.phone, a.source,
  a.expected_salary::float AS "expectedSalary", a.currency, a.stage, a.priority, a.notes, a.cv_name AS "cvName",
  a.cv_key IS NOT NULL AS "hasCv", a.interview_at AS "interviewAt", a.refuse_reason AS "refuseReason",
  a.hired_employee_id AS "hiredEmployeeId", a.stage_changed_at AS "stageChangedAt", a.created_at AS "createdAt"`;

async function applicantOr404(id: string) {
  if (!isUuid(id)) throw notFound('المتقدم غير موجود.');
  const row = await selectOne<{ id: string; stage: string; fullName: string; positionId: string; cvKey: string | null; cvName: string | null; email: string | null; phone: string | null; hiredEmployeeId: string | null }>(
    `SELECT id, stage, full_name AS "fullName", position_id AS "positionId", cv_key AS "cvKey", cv_name AS "cvName", email, phone,
            hired_employee_id AS "hiredEmployeeId" FROM applicants WHERE id = :id`, { id },
  );
  if (!row) throw notFound('المتقدم غير موجود.');
  return row;
}

/** Recruitment, Odoo-style: job positions and applicants moving through stages. */
export class RecruitmentController {
  static async positions(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT p.id, p.title, p.title_en AS "titleEn", p.department_id AS "departmentId", d.name AS "departmentName",
              p.branch_id AS "branchId", b.name AS "branchName", p.job_title_id AS "jobTitleId", p.description, p.requirements,
              p.vacancies, p.status, p.created_at AS "createdAt",
              (SELECT COUNT(*) FROM applicants a WHERE a.position_id = p.id AND a.stage NOT IN ('hired','refused'))::int AS "inProgress",
              (SELECT COUNT(*) FROM applicants a WHERE a.position_id = p.id AND a.stage = 'new')::int AS "newCount",
              (SELECT COUNT(*) FROM applicants a WHERE a.position_id = p.id AND a.stage = 'hired')::int AS "hiredCount"
       FROM job_positions p LEFT JOIN departments d ON d.id = p.department_id LEFT JOIN branches b ON b.id = p.branch_id
       ORDER BY (p.status = 'open') DESC, p.created_at DESC`,
    );
    res.json({ data: rows });
  }

  static async savePosition(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['title', 'titleEn', 'departmentId', 'branchId', 'jobTitleId', 'description', 'requirements', 'vacancies', 'status']);
    const id = req.params.id && isUuid(req.params.id) ? req.params.id : null;
    const values = {
      title: requiredText(input, 'title', 150, 'المسمى'),
      titleEn: optionalText(input, 'titleEn', 150) ?? null,
      departmentId: isUuid(input.departmentId) ? input.departmentId : null,
      branchId: isUuid(input.branchId) ? input.branchId : null,
      jobTitleId: isUuid(input.jobTitleId) ? input.jobTitleId : null,
      description: optionalText(input, 'description', 10000) ?? null,
      requirements: optionalText(input, 'requirements', 10000) ?? null,
      vacancies: optionalNumber(input, 'vacancies', { min: 1, max: 500 }) ?? 1,
      status: input.status === undefined ? 'open' : String(input.status),
    };
    if (!['open', 'paused', 'closed'].includes(values.status)) throw badRequest('الحالة غير صالحة.');
    const positionId = id ?? randomUUID();
    await transaction(async (tx) => {
      if (id) {
        const rows = await execute<{ id: string }>(
          `UPDATE job_positions SET title = :title, title_en = :titleEn, department_id = :departmentId, branch_id = :branchId,
             job_title_id = :jobTitleId, description = :description, requirements = :requirements, vacancies = :vacancies,
             status = :status, updated_at = now() WHERE id = :id RETURNING id`, { ...values, id }, tx,
        );
        if (!rows.length) throw notFound('الوظيفة غير موجودة.');
      } else {
        await execute(
          `INSERT INTO job_positions (id, title, title_en, department_id, branch_id, job_title_id, description, requirements, vacancies, status, created_by)
           VALUES (:id, :title, :titleEn, :departmentId, :branchId, :jobTitleId, :description, :requirements, :vacancies, :status, :userId)`,
          { ...values, id: positionId, userId: req.user!.id }, tx,
        );
      }
      await recordAudit(req, tx, id ? 'recruitment.position_updated' : 'recruitment.position_created', 'job_position', positionId, { title: values.title });
    });
    res.status(id ? 200 : 201).json({ data: { id: positionId } });
  }

  static async applicants(req: Request, res: Response): Promise<void> {
    const positionId = typeof req.query.positionId === 'string' && isUuid(req.query.positionId) ? req.query.positionId : null;
    const rows = await select(
      `SELECT ${APPLICANT_COLUMNS} FROM applicants a JOIN job_positions p ON p.id = a.position_id
       ${positionId ? 'WHERE a.position_id = :positionId' : ''} ORDER BY a.priority DESC, a.stage_changed_at DESC LIMIT 1000`,
      { positionId },
    );
    res.json({ data: rows });
  }

  static async applicant(req: Request, res: Response): Promise<void> {
    const found = await applicantOr404(req.params.id);
    const row = await selectOne<Record<string, unknown>>(`SELECT ${APPLICANT_COLUMNS} FROM applicants a JOIN job_positions p ON p.id = a.position_id WHERE a.id = :id`, { id: found.id });
    const activity = await select(
      `SELECT x.id, x.kind, x.body, x.created_at AS "createdAt", u.name AS "userName" FROM applicant_activities x JOIN users u ON u.id = x.user_id
       WHERE x.applicant_id = :id ORDER BY x.created_at DESC`, { id: found.id },
    );
    res.json({ data: { ...row, activity } });
  }

  static async createApplicant(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['positionId', 'fullName', 'email', 'phone', 'source', 'expectedSalary', 'currency', 'notes', 'priority']);
    if (!isUuid(input.positionId) || !(await selectOne('SELECT 1 FROM job_positions WHERE id = :id', { id: input.positionId }))) throw badRequest('اختر الوظيفة.');
    const source = input.source ? String(input.source) : null;
    if (source && !SOURCES.includes(source)) throw badRequest('مصدر غير صالح.');
    const id = randomUUID();
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO applicants (id, position_id, full_name, email, phone, source, expected_salary, currency, notes, priority, created_by)
         VALUES (:id, :positionId, :fullName, :email, :phone, :source, :salary, :currency, :notes, :priority, :userId)`,
        {
          id, positionId: input.positionId, fullName: requiredText(input, 'fullName', 180, 'اسم المتقدم'),
          email: optionalText(input, 'email', 254) ?? null, phone: optionalText(input, 'phone', 40) ?? null, source,
          salary: optionalNumber(input, 'expectedSalary', { min: 0, max: 1e11 }) ?? null,
          currency: (optionalText(input, 'currency', 3) || 'IQD').toUpperCase(), notes: optionalText(input, 'notes', 10000) ?? null,
          priority: optionalNumber(input, 'priority', { min: 0, max: 3 }) ?? 0, userId: req.user!.id,
        }, tx,
      );
      await execute(`INSERT INTO applicant_activities (id, applicant_id, user_id, kind, body) VALUES (:aid, :id, :userId, 'created', 'أُضيف المتقدم')`,
        { aid: randomUUID(), id, userId: req.user!.id }, tx);
      await recordAudit(req, tx, 'recruitment.applicant_created', 'applicant', id);
    });
    res.status(201).json({ data: { id } });
  }

  /** Stage moves (drag and drop on the kanban), stars, interview time, notes. */
  static async updateApplicant(req: Request, res: Response): Promise<void> {
    const applicant = await applicantOr404(req.params.id);
    const input = body(req);
    assertOnlyKeys(input, ['stage', 'priority', 'interviewAt', 'note', 'refuseReason', 'expectedSalary', 'phone', 'email']);
    if (applicant.stage === 'hired') throw conflict('تم تعيين هذا المتقدم.');
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: applicant.id };
    const log: string[] = [];
    if (input.stage !== undefined) {
      const stage = String(input.stage);
      if (!(STAGES as readonly string[]).includes(stage) || stage === 'hired') throw badRequest('المرحلة غير صالحة (التعيين من زر «تعيين»).');
      if (stage === 'refused' && !optionalText(input, 'refuseReason', 500)) throw badRequest('اكتب سبب الرفض.');
      sets.push('stage = :stage', 'stage_changed_at = now()');
      params.stage = stage;
      log.push(`المرحلة: ${STAGE_AR[applicant.stage]} ← ${STAGE_AR[stage]}`);
    }
    if (input.refuseReason !== undefined) { sets.push('refuse_reason = :refuse'); params.refuse = optionalText(input, 'refuseReason', 500) ?? null; }
    if (input.priority !== undefined) { sets.push('priority = :priority'); params.priority = optionalNumber(input, 'priority', { min: 0, max: 3 }) ?? 0; }
    if (input.interviewAt !== undefined) {
      const value = input.interviewAt ? String(input.interviewAt) : null;
      if (value && Number.isNaN(Date.parse(value))) throw badRequest('موعد المقابلة غير صالح.');
      sets.push('interview_at = :interview');
      params.interview = value ? new Date(value).toISOString() : null;
      if (value) log.push(`موعد مقابلة: ${value.replace('T', ' ')}`);
    }
    if (input.expectedSalary !== undefined) { sets.push('expected_salary = :salary'); params.salary = optionalNumber(input, 'expectedSalary', { min: 0, max: 1e11 }) ?? null; }
    if (input.phone !== undefined) { sets.push('phone = :phone'); params.phone = optionalText(input, 'phone', 40) ?? null; }
    if (input.email !== undefined) { sets.push('email = :email'); params.email = optionalText(input, 'email', 254) ?? null; }
    const note = optionalText(input, 'note', 2000);
    if (!sets.length && !note) throw badRequest('لا يوجد تغيير.');
    await transaction(async (tx) => {
      if (sets.length) await execute(`UPDATE applicants SET ${sets.join(', ')}, updated_at = now() WHERE id = :id`, params, tx);
      for (const line of log) {
        await execute(`INSERT INTO applicant_activities (id, applicant_id, user_id, kind, body) VALUES (:aid, :id, :userId, 'stage', :body)`,
          { aid: randomUUID(), id: applicant.id, userId: req.user!.id, body: line }, tx);
      }
      if (note) {
        await execute(`INSERT INTO applicant_activities (id, applicant_id, user_id, kind, body) VALUES (:aid, :id, :userId, 'note', :body)`,
          { aid: randomUUID(), id: applicant.id, userId: req.user!.id, body: note }, tx);
      }
    });
    res.json({ data: { id: applicant.id } });
  }

  static async uploadCv(req: Request, res: Response): Promise<void> {
    const applicant = await applicantOr404(req.params.id);
    if (!req.file) throw badRequest('أرفق السيرة الذاتية.');
    const type = sniffFile(req.file.buffer, ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
    const key = await storeFile('cvs', req.file.buffer, type.ext);
    await execute('UPDATE applicants SET cv_key = :key, cv_name = :name, updated_at = now() WHERE id = :id',
      { key, name: uploadedName(req.file, `cv.${type.ext}`), id: applicant.id });
    res.json({ data: { id: applicant.id } });
  }

  static async cv(req: Request, res: Response): Promise<void> {
    const applicant = await applicantOr404(req.params.id);
    if (!applicant.cvKey || !(await storedFileExists(applicant.cvKey))) throw notFound('لا توجد سيرة ذاتية مرفقة.');
    res.setHeader('Content-Disposition', contentDisposition(applicant.cvName || 'cv', req.query.inline === '1'));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    openStoredFile(applicant.cvKey).pipe(res);
  }

  /** Hiring creates the employee file (on probation) from the applicant and the position. */
  static async hire(req: Request, res: Response): Promise<void> {
    const applicant = await applicantOr404(req.params.id);
    if (applicant.stage === 'hired') throw conflict('تم تعيين هذا المتقدم مسبقاً.');
    const input = body(req);
    assertOnlyKeys(input, ['employeeNo', 'hireDate', 'branchId']);
    const employeeNo = requiredText(input, 'employeeNo', 40, 'الرقم الوظيفي');
    const hireDate = typeof input.hireDate === 'string' ? input.hireDate : '';
    if (!isDateOnly(hireDate)) throw badRequest('حدد تاريخ المباشرة.');
    const position = await selectOne<{ title: string; branchId: string | null; departmentId: string | null; departmentName: string | null; jobTitleId: string | null }>(
      `SELECT p.title, p.branch_id AS "branchId", p.department_id AS "departmentId", d.name AS "departmentName", p.job_title_id AS "jobTitleId"
       FROM job_positions p LEFT JOIN departments d ON d.id = p.department_id WHERE p.id = :id`, { id: applicant.positionId },
    );
    const branchId = isUuid(input.branchId) ? String(input.branchId) : position?.branchId;
    if (!branchId) throw badRequest('اختر الفرع.');
    if (await selectOne('SELECT 1 FROM employees WHERE employee_no = :no', { no: employeeNo })) throw conflict('الرقم الوظيفي مستخدم.');
    const employeeId = randomUUID();
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO employees (id, employee_no, full_name, email, phone, branch_id, department, "position", hire_date, employment_status,
           custom_fields, created_at, updated_at, department_id, job_title_id, employment_type)
         VALUES (:id, :no, :name, :email, :phone, :branchId, :department, :position, :hireDate, 'active', '{}'::jsonb, now(), now(),
           :departmentId, :jobTitleId, 'probation')`,
        {
          id: employeeId, no: employeeNo, name: applicant.fullName, email: applicant.email, phone: applicant.phone, branchId,
          department: position?.departmentName ?? '—', position: position?.title ?? '—', hireDate,
          departmentId: position?.departmentId ?? null, jobTitleId: position?.jobTitleId ?? null,
        }, tx,
      );
      await execute(`UPDATE applicants SET stage = 'hired', stage_changed_at = now(), hired_employee_id = :employeeId, updated_at = now() WHERE id = :id`,
        { employeeId, id: applicant.id }, tx);
      await execute(`INSERT INTO applicant_activities (id, applicant_id, user_id, kind, body) VALUES (:aid, :id, :userId, 'hired', :body)`,
        { aid: randomUUID(), id: applicant.id, userId: req.user!.id, body: `عُيّن برقم ${employeeNo} بتاريخ ${hireDate}` }, tx);
      await recordAudit(req, tx, 'recruitment.hired', 'employee', employeeId, { applicantId: applicant.id, employeeNo });
    });
    res.status(201).json({ data: { employeeId } });
  }
}

export default RecruitmentController;
