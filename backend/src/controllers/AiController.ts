import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { Employee, SystemSetting } from '../models';
import { normalizeSystemSettings } from '../config/systemSettings';
import { execute, select, selectOne, transaction } from '../db/query';
import { aiReady, aiStatus, setAiKey } from '../services/ai';
import { COMPONENT_IDS, AttendanceProposal, proposeAttendance } from '../services/aiAttendance';
import { amount, excelDate, ImportField, mapSheets, readSheets, text } from '../services/aiImport';
import { employeeScopeSql } from '../services/access';
import { getSettings, invalidateSettingsCache, SETTINGS_ID } from '../services/settings';
import { recordAudit } from '../utils/audit';
import { decryptField, encryptField } from '../utils/crypto';
import { badRequest, body, conflict, notFound, requiredText } from '../utils/http';
import { isUuid } from '../utils/validation';

const PROFILE_FIELDS: Partial<Record<ImportField, string>> = {
  nameEn: 'name_en', birthDate: 'birth_date', gender: 'gender', nationality: 'nationality', nationalIdNo: 'national_id_no',
  passportNo: 'passport_no', passportExpiry: 'passport_expiry', residencyType: 'residency_type', residencyExpiry: 'residency_expiry',
  bankName: 'bank_name', bankAccountNo: 'bank_account_no', address: 'address', motherName: 'mother_name', maritalStatus: 'marital_status',
  educationLevel: 'education_level', bloodType: 'blood_type',
};
const ENCRYPTED = new Set(['nationalIdNo', 'passportNo', 'bankAccountNo']);
const DATE_FIELDS = new Set(['birthDate', 'passportExpiry', 'residencyExpiry', 'hireDate']);
const LABELS: Record<string, string> = {
  fullName: 'الاسم', phone: 'الهاتف', email: 'البريد', hireDate: 'تاريخ المباشرة', nameEn: 'الاسم بالإنكليزي', birthDate: 'تاريخ الميلاد',
  gender: 'الجنس', nationality: 'الجنسية', nationalIdNo: 'رقم الهوية', passportNo: 'رقم الجواز', passportExpiry: 'انتهاء الجواز',
  residencyType: 'نوع الإقامة', residencyExpiry: 'انتهاء الإقامة', bankName: 'المصرف', bankAccountNo: 'رقم الحساب', address: 'العنوان',
  motherName: 'اسم الأم', maritalStatus: 'الحالة الاجتماعية', educationLevel: 'التحصيل', bloodType: 'فصيلة الدم', salary: 'الراتب', residencyStatus: 'محلي/أجنبي',
};

function normalizeValue(field: string, raw: unknown): string | null {
  const value = text(raw as never);
  if (!value) return null;
  if (DATE_FIELDS.has(field)) return excelDate(raw as never);
  if (field === 'gender') return /أنث|انث|female|^f$/i.test(value) ? 'female' : /ذكر|male|^m$/i.test(value) ? 'male' : null;
  if (field === 'maritalStatus') return /متزوج|married/i.test(value) ? 'married' : /أعزب|اعزب|عزباء|single/i.test(value) ? 'single' : /مطلق|divorced/i.test(value) ? 'divorced' : /أرمل|ارمل|widow/i.test(value) ? 'widowed' : null;
  if (field === 'bloodType') return /^(A|B|AB|O)[+-]$/i.test(value) ? value.toUpperCase() : null;
  return value.slice(0, field === 'address' ? 400 : 180);
}
const isIraqi = (nationality: string | null) => !nationality || /(عراق|iraq)/i.test(nationality);

interface RowChange { employeeId: string | null; employeeNo: string; name: string; action: 'update' | 'create' | 'skip'; reason?: string; changes: Array<{ field: string; label: string; before: string | null; after: string }>; values: Record<string, string>; salary?: { amount: number; currency: string; before: number | null }; branchId?: string | null }

/**
 * The AI assistant inside the system, driven by the owner: it turns
 * instructions into attendance rules, and old Excel files into employee
 * cards and salaries. It only proposes; nothing changes until the owner
 * reviews and applies it. Without an AI key, built-in readers do the same work.
 */
export class AiController {
  static async status(_req: Request, res: Response): Promise<void> {
    res.json({ data: await aiStatus() });
  }

  static async configure(req: Request, res: Response): Promise<void> {
    const input = body(req);
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      const key = input.apiKey.trim();
      if (!/^sk-ant-[A-Za-z0-9_-]{20,200}$/.test(key)) throw badRequest('مفتاح Anthropic غير صالح (يبدأ بـ sk-ant-).');
      await setAiKey(key, req.user!.id);
    } else if (input.apiKey === null) {
      await setAiKey(null, req.user!.id);
    }
    if (typeof input.enabled === 'boolean' || typeof input.model === 'string') {
      await transaction(async (tx) => {
        const settings = normalizeSystemSettings((await SystemSetting.findByPk(SETTINGS_ID, { transaction: tx }))?.value);
        if (typeof input.enabled === 'boolean') settings.hr.ai.enabled = input.enabled;
        if (typeof input.model === 'string' && /^[a-z0-9.-]{3,60}$/.test(input.model)) settings.hr.ai.model = input.model;
        await SystemSetting.upsert({ id: SETTINGS_ID, value: settings, updatedBy: req.user!.id }, { transaction: tx });
      });
      invalidateSettingsCache();
    }
    await recordAudit(req, null, 'ai.configured', 'system_settings', SETTINGS_ID, { key: input.apiKey === undefined ? 'unchanged' : input.apiKey ? 'set' : 'removed', enabled: input.enabled });
    res.json({ data: await aiStatus() });
  }

  static async jobs(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT j.id, j.kind, j.instruction, j.file_name AS "fileName", j.status, j.engine, j.error, j.created_at AS "createdAt",
              j.applied_at AS "appliedAt", u.name AS "createdByName",
              CASE WHEN j.kind = 'attendance_rules' THEN j.proposal ELSE j.proposal -> 'summary' END AS proposal, j.result
       FROM ai_jobs j JOIN users u ON u.id = j.created_by ORDER BY j.created_at DESC LIMIT 50`,
    );
    res.json({ data: rows });
  }

  static async job(req: Request, res: Response): Promise<void> {
    const row = await selectOne('SELECT id, kind, instruction, file_name AS "fileName", status, engine, proposal, result, error FROM ai_jobs WHERE id = :id', { id: req.params.id });
    if (!row) throw notFound('الطلب غير موجود.');
    res.json({ data: row });
  }

  /** "Calculate attendance this way": instructions in, a change set out for review. */
  static async attendance(req: Request, res: Response): Promise<void> {
    const instruction = requiredText(body(req), 'instruction', 4000, 'التعليمات');
    const settings = await getSettings();
    const useAi = await aiReady();
    let engine: 'ai' | 'rules' = 'rules';
    let proposal: AttendanceProposal;
    let error: string | null = null;
    try {
      ({ engine, proposal } = await proposeAttendance(instruction, settings, useAi));
    } catch (failure) {
      // The AI being unreachable never blocks the owner: the built-in reader answers instead.
      error = failure instanceof Error ? failure.message : 'AI_ERROR';
      ({ engine, proposal } = await proposeAttendance(instruction, settings, false));
    }
    const id = randomUUID();
    await execute(
      `INSERT INTO ai_jobs (id, kind, instruction, status, engine, proposal, error, created_by) VALUES (:id, 'attendance_rules', :instruction, 'proposed', :engine, :proposal::jsonb, :error, :userId)`,
      { id, instruction, engine, proposal: JSON.stringify(proposal), error, userId: req.user!.id },
    );
    await recordAudit(req, null, 'ai.attendance_proposed', 'ai_job', id, { engine });
    res.status(201).json({ data: { id, engine, proposal, error } });
  }

  /** An old Excel file in, a review of every card and salary change out. */
  static async importFile(req: Request, res: Response): Promise<void> {
    const file = req.file;
    if (!file || file.buffer.subarray(0, 2).toString('latin1') !== 'PK') throw badRequest('ارفع ملف Excel (xlsx).');
    let sheets;
    try { sheets = await readSheets(file.buffer); } catch { throw badRequest('تعذرت قراءة الملف.'); }
    if (!sheets.length) throw badRequest('لم أجد في الملف ورقة فيها جدول موظفين.');
    const useAi = await aiReady();
    let mapped;
    let error: string | null = null;
    try { mapped = await mapSheets(sheets, useAi); } catch (failure) { error = failure instanceof Error ? failure.message : 'AI_ERROR'; mapped = await mapSheets(sheets, false); }
    if (!mapped.plan.length) throw badRequest('لم أجد عمود الرقم الوظيفي في أي ورقة.');
    const branches = await select<{ id: string; name: string; city: string }>('SELECT id, name, city FROM branches WHERE is_active');
    const latest = await select<{ employeeId: string; gross: number; currency: string }>(
      `SELECT DISTINCT ON (employee_id) employee_id AS "employeeId", gross_salary::float AS gross, currency FROM employee_compensation ORDER BY employee_id, effective_from DESC`,
    );
    const salaries = new Map(latest.map((row) => [row.employeeId, row]));
    const rows: RowChange[] = [];
    const seen = new Set<string>();
    for (const { sheet, mapping } of mapped.plan) {
      const at = (row: unknown[], field: ImportField) => (mapping[field] !== undefined ? row[mapping[field]!] : null);
      const numbers = sheet.rows.map((row) => text(at(row, 'employeeNo') as never).replace(/\.0+$/, '')).filter(Boolean);
      const existing = numbers.length ? await select<Record<string, unknown>>(
        `SELECT e.id, e.employee_no AS "employeeNo", e.full_name AS "fullName", e.phone, e.email, to_char(e.hire_date, 'YYYY-MM-DD') AS "hireDate",
                p.name_en AS "nameEn", to_char(p.birth_date, 'YYYY-MM-DD') AS "birthDate", p.gender, p.nationality, p.national_id_no AS "nationalIdNo",
                p.passport_no AS "passportNo", to_char(p.passport_expiry, 'YYYY-MM-DD') AS "passportExpiry", p.residency_type AS "residencyType",
                to_char(p.residency_expiry, 'YYYY-MM-DD') AS "residencyExpiry", p.bank_name AS "bankName", p.bank_account_no AS "bankAccountNo",
                p.address, p.mother_name AS "motherName", p.marital_status AS "maritalStatus", p.education_level AS "educationLevel",
                p.blood_type AS "bloodType", p.residency_status AS "residencyStatus"
         FROM employees e LEFT JOIN employee_profiles p ON p.employee_id = e.id WHERE e.employee_no IN (:numbers)`, { numbers },
      ) : [];
      const byNo = new Map(existing.map((row) => [String(row.employeeNo), row]));
      for (const row of sheet.rows) {
        const employeeNo = text(at(row, 'employeeNo') as never).replace(/\.0+$/, '');
        if (!employeeNo || !/^[A-Za-z0-9-]{1,30}$/.test(employeeNo) || seen.has(employeeNo)) continue;
        seen.add(employeeNo);
        const values: Record<string, string> = {};
        for (const field of Object.keys(mapping) as ImportField[]) {
          if (['employeeNo', 'salary', 'currency', 'branch', 'department', 'jobTitle', 'employmentType'].includes(field)) continue;
          const value = normalizeValue(field, at(row, field));
          if (value) values[field] = value;
        }
        if (values.nationality || values.passportNo) values.residencyStatus = isIraqi(values.nationality ?? null) && !values.passportNo ? 'local' : (isIraqi(values.nationality ?? null) ? 'local' : 'foreign');
        const salaryAmount = amount(at(row, 'salary') as never);
        const currencyText = text(at(row, 'currency') as never).toUpperCase();
        const currency = /USD|\$|دولار/.test(currencyText) ? 'USD' : 'IQD';
        const current = byNo.get(employeeNo);
        if (current) {
          const changes: RowChange['changes'] = [];
          for (const [field, after] of Object.entries(values)) {
            const raw = current[field] as string | null;
            const before = ENCRYPTED.has(field) ? decryptField(raw) : raw;
            if (field === 'fullName' && before) continue;
            if ((before ?? '') !== after) changes.push({ field, label: LABELS[field] ?? field, before: ENCRYPTED.has(field) && before ? `••••${String(before).slice(-3)}` : before, after: ENCRYPTED.has(field) ? `••••${after.slice(-3)}` : after });
          }
          const pay = salaries.get(String(current.id));
          const salary = salaryAmount && salaryAmount > 0 && (!pay || Math.abs(pay.gross - salaryAmount) > 0.004 || pay.currency !== currency)
            ? { amount: salaryAmount, currency, before: pay?.gross ?? null } : undefined;
          if (salary) changes.push({ field: 'salary', label: 'الراتب', before: pay ? `${pay.gross} ${pay.currency}` : null, after: `${salaryAmount} ${currency}` });
          rows.push({ employeeId: String(current.id), employeeNo, name: String(current.fullName), action: changes.length ? 'update' : 'skip', reason: changes.length ? undefined : 'لا تغيير', changes, values, salary });
        } else {
          const name = values.fullName;
          const branchText = text(at(row, 'branch') as never);
          const branch = branchText ? branches.find((item) => branchText.includes(item.name) || item.name.includes(branchText) || branchText.includes(item.city)) : branches.length === 1 ? branches[0] : undefined;
          rows.push({
            employeeId: null, employeeNo, name: name ?? employeeNo, action: name && branch ? 'create' : 'skip',
            reason: !name ? 'لا يوجد اسم' : !branch ? `الفرع غير معروف (${branchText || 'فارغ'})` : undefined,
            changes: Object.entries(values).map(([field, after]) => ({ field, label: LABELS[field] ?? field, before: null, after: ENCRYPTED.has(field) ? `••••${after.slice(-3)}` : after })),
            values, branchId: branch?.id ?? null,
            salary: salaryAmount && salaryAmount > 0 ? { amount: salaryAmount, currency, before: null } : undefined,
          });
        }
      }
    }
    const summary = {
      sheets: mapped.plan.map((item) => ({ name: item.sheet.name, rows: item.sheet.total, columns: Object.fromEntries(Object.entries(item.mapping).map(([field, index]) => [field, item.sheet.headers[index!]])) })),
      update: rows.filter((row) => row.action === 'update').length,
      create: rows.filter((row) => row.action === 'create').length,
      skip: rows.filter((row) => row.action === 'skip').length,
      salaryChanges: rows.filter((row) => row.salary && row.action !== 'skip').length,
      notes: mapped.notes,
    };
    const id = randomUUID();
    await execute(
      `INSERT INTO ai_jobs (id, kind, file_name, status, engine, proposal, error, created_by) VALUES (:id, 'import', :fileName, 'proposed', :engine, :proposal::jsonb, :error, :userId)`,
      { id, fileName: (file.originalname || 'file.xlsx').slice(0, 250), engine: mapped.engine, proposal: JSON.stringify({ summary, rows }), error, userId: req.user!.id },
    );
    await recordAudit(req, null, 'ai.import_proposed', 'ai_job', id, { engine: mapped.engine, ...summary, notes: undefined });
    res.status(201).json({ data: { id, engine: mapped.engine, summary, rows: rows.filter((row) => row.action !== 'skip').slice(0, 300), skipped: rows.filter((row) => row.action === 'skip').slice(0, 100), error } });
  }

  static async apply(req: Request, res: Response): Promise<void> {
    const job = await selectOne<{ id: string; kind: string; status: string; proposal: any }>('SELECT id, kind, status, proposal FROM ai_jobs WHERE id = :id', { id: req.params.id });
    if (!job) throw notFound('الطلب غير موجود.');
    if (job.status !== 'proposed') throw conflict('طُبّق هذا الاقتراح أو أُلغي مسبقاً.');
    const input = body(req);
    let result: Record<string, unknown> = {};
    await transaction(async (tx) => {
      if (job.kind === 'attendance_rules') {
        const proposal = job.proposal as AttendanceProposal;
        const settings = normalizeSystemSettings((await SystemSetting.findByPk(SETTINGS_ID, { transaction: tx }))?.value);
        if (proposal.attendanceRules) settings.attendanceRules = { ...settings.attendanceRules, ...proposal.attendanceRules };
        for (const [key, change] of Object.entries(proposal.components ?? {})) {
          const id = COMPONENT_IDS[key as keyof typeof COMPONENT_IDS];
          settings.payrollRules.components = settings.payrollRules.components.map((component) => component.id === id ? { ...component, ...change } : component);
        }
        if (proposal.hourly) settings.leaveRules = { ...settings.leaveRules, ...proposal.hourly };
        await SystemSetting.upsert({ id: SETTINGS_ID, value: settings, updatedBy: req.user!.id }, { transaction: tx });
        let shifts = 0;
        if (proposal.shifts && Object.keys(proposal.shifts).length) {
          const rows = await execute(
            `UPDATE shifts SET grace_minutes = COALESCE(:grace, grace_minutes), early_leave_grace_minutes = COALESCE(:early, early_leave_grace_minutes), updated_at = now()
             WHERE is_active RETURNING id`,
            { grace: proposal.shifts.graceMinutes ?? null, early: proposal.shifts.earlyLeaveGraceMinutes ?? null }, tx,
          );
          shifts = rows.length;
        }
        result = { applied: true, shifts };
      } else {
        const rows = (job.proposal?.rows ?? []) as RowChange[];
        const onlyNos = Array.isArray(input.employeeNos) ? new Set((input.employeeNos as unknown[]).map(String)) : null;
        const effectiveFrom = typeof input.effectiveFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom) ? input.effectiveFrom : `${new Date().toISOString().slice(0, 7)}-01`;
        let updated = 0; let created = 0; let salaries = 0;
        for (const row of rows) {
          if (row.action === 'skip' || (onlyNos && !onlyNos.has(row.employeeNo))) continue;
          let employeeId = row.employeeId;
          if (row.action === 'create') {
            if (!row.branchId) continue;
            if (await selectOne('SELECT 1 FROM employees WHERE employee_no = :no', { no: row.employeeNo }, tx)) continue;
            const employee = await Employee.create({
              employeeNo: row.employeeNo, fullName: row.values.fullName ?? row.employeeNo, branchId: row.branchId, department: '', position: '',
              hireDate: row.values.hireDate ?? new Date().toISOString().slice(0, 10), phone: row.values.phone ?? null, email: row.values.email ?? null,
            }, { transaction: tx });
            employeeId = employee.id;
            created += 1;
          } else {
            const direct: Record<string, string> = {};
            for (const field of ['phone', 'email', 'hireDate'] as const) if (row.values[field]) direct[field] = row.values[field];
            if (Object.keys(direct).length) {
              await execute(
                `UPDATE employees SET phone = COALESCE(:phone, phone), email = COALESCE(:email, email), hire_date = COALESCE(:hireDate::date, hire_date), updated_at = now() WHERE id = :id`,
                { id: employeeId, phone: direct.phone ?? null, email: direct.email ?? null, hireDate: direct.hireDate ?? null }, tx,
              );
            }
            updated += 1;
          }
          const profile: Record<string, unknown> = {};
          for (const [field, column] of Object.entries(PROFILE_FIELDS)) {
            const value = row.values[field];
            if (value) profile[column!] = ENCRYPTED.has(field) ? encryptField(value) : value;
          }
          if (row.values.residencyStatus) profile.residency_status = row.values.residencyStatus;
          if (Object.keys(profile).length) {
            const columns = Object.keys(profile);
            await execute(
              `INSERT INTO employee_profiles (employee_id, ${columns.join(', ')}, updated_by, updated_at)
               VALUES (:employeeId, ${columns.map((column) => `:${column}`).join(', ')}, :userId, now())
               ON CONFLICT (employee_id) DO UPDATE SET ${columns.map((column) => `${column} = EXCLUDED.${column}`).join(', ')}, updated_by = EXCLUDED.updated_by, updated_at = now()`,
              { ...profile, employeeId, userId: req.user!.id }, tx,
            );
          }
          if (row.salary) {
            const inserted = await execute(
              `INSERT INTO employee_compensation (id, employee_id, effective_from, gross_salary, currency, reason, created_by, created_at)
               VALUES (:id, :employeeId, :effectiveFrom, :gross, :currency, :reason, :userId, now())
               ON CONFLICT (employee_id, effective_from) DO NOTHING RETURNING id`,
              { id: randomUUID(), employeeId, effectiveFrom, gross: row.salary.amount, currency: row.salary.currency, reason: 'من ملف Excel عبر المساعد', userId: req.user!.id }, tx,
            );
            salaries += inserted.length;
          }
        }
        result = { updated, created, salaries, effectiveFrom };
      }
      await execute(`UPDATE ai_jobs SET status = 'applied', applied_by = :userId, applied_at = now(), result = :result::jsonb WHERE id = :id`,
        { id: job.id, userId: req.user!.id, result: JSON.stringify(result) }, tx);
      await recordAudit(req, tx, 'ai.applied', 'ai_job', job.id, { kind: job.kind, ...result });
    });
    invalidateSettingsCache();
    res.json({ data: result });
  }

  static async discard(req: Request, res: Response): Promise<void> {
    const rows = await execute(`UPDATE ai_jobs SET status = 'discarded' WHERE id = :id AND status = 'proposed' RETURNING id`, { id: req.params.id });
    if (!rows.length) throw conflict('لا يمكن الإلغاء.');
    res.json({ data: { ok: true } });
  }

  /** Every employee's file against the documents required (local or foreign), priorities first, with agreed exceptions. */
  static async documentsCheck(req: Request, res: Response): Promise<void> {
    const settings = await getSettings();
    const rules = settings.hr.documentRules;
    const scope = employeeScopeSql(req);
    const employees = await select<{ id: string; employeeNo: string; name: string; branch: string; status: string; hasPhoto: boolean; docs: string[] | null }>(
      `SELECT e.id, e.employee_no AS "employeeNo", e.full_name AS name, b.name AS branch, COALESCE(p.residency_status, 'local') AS status,
              e.photo_document_id IS NOT NULL AS "hasPhoto",
              (SELECT array_agg(DISTINCT d.doc_type) FROM employee_documents d WHERE d.employee_id = e.id AND d.deleted_at IS NULL
                 AND (d.expiry_date IS NULL OR d.expiry_date >= CURRENT_DATE)) AS docs
       FROM employees e JOIN branches b ON b.id = e.branch_id LEFT JOIN employee_profiles p ON p.employee_id = e.id
       WHERE e.employment_status <> 'inactive'${scope.sql} ORDER BY e.employee_no`,
      scope.params,
    );
    const exempt = new Set(rules.exempt.map((item) => `${item.employeeId}:${item.docType}`));
    const priority = new Set(rules.priority);
    const rows = employees.map((employee) => {
      const required = employee.status === 'foreign' ? rules.foreign : rules.local;
      const have = new Set([...(employee.docs ?? []), ...(employee.hasPhoto ? ['photo'] : [])]);
      const missing = required.filter((type) => !have.has(type) && !exempt.has(`${employee.id}:${type}`));
      const exempted = required.filter((type) => exempt.has(`${employee.id}:${type}`));
      return { id: employee.id, employeeNo: employee.employeeNo, name: employee.name, branch: employee.branch, status: employee.status, missing, exempted, complete: !missing.length, priority: priority.has(employee.id) };
    }).sort((a, b) => Number(b.priority) - Number(a.priority) || b.missing.length - a.missing.length || a.employeeNo.localeCompare(b.employeeNo, 'en', { numeric: true }));
    res.json({ data: { rules, rows, complete: rows.filter((row) => row.complete).length, incomplete: rows.filter((row) => !row.complete).length } });
  }

  /** Mark a document as not required for one employee, or put an employee first in line. */
  static async documentRule(req: Request, res: Response): Promise<void> {
    const input = body(req);
    if (!isUuid(input.employeeId)) throw badRequest('الموظف غير صالح.');
    const employeeId = String(input.employeeId);
    await transaction(async (tx) => {
      const settings = normalizeSystemSettings((await SystemSetting.findByPk(SETTINGS_ID, { transaction: tx }))?.value);
      const rules = settings.hr.documentRules;
      if (typeof input.docType === 'string' && /^[a-z_]{2,30}$/.test(input.docType)) {
        const key = (item: { employeeId: string; docType: string }) => item.employeeId === employeeId && item.docType === input.docType;
        rules.exempt = input.exempt === false ? rules.exempt.filter((item) => !key(item)) : [...rules.exempt.filter((item) => !key(item)), { employeeId, docType: String(input.docType) }];
      }
      if (typeof input.priority === 'boolean') {
        rules.priority = input.priority ? [...new Set([...rules.priority, employeeId])] : rules.priority.filter((id) => id !== employeeId);
      }
      await SystemSetting.upsert({ id: SETTINGS_ID, value: settings, updatedBy: req.user!.id }, { transaction: tx });
      await recordAudit(req, tx, 'documents.rule_set', 'employee', employeeId, { docType: input.docType, exempt: input.exempt, priority: input.priority });
    });
    invalidateSettingsCache();
    res.json({ data: { ok: true } });
  }
}

export default AiController;
