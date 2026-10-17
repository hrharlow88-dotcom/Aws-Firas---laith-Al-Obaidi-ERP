import { createHash, randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { execute, select, selectOne, transaction } from '../db/query';
import { employeeInScope, employeeScopeSql } from '../services/access';
import { can } from '../services/settings';
import { contentDisposition, inlineSafeType, openStoredFile, safeExtension, storeFile, storedFileExists, uploadedName } from '../services/storage';
import { moveToBin, snapshot } from '../services/recycleBin';
import { notifyEmployees } from '../services/notify';
import { recordAudit } from '../utils/audit';
import { assertOnlyKeys, badRequest, body, notFound, optionalText, requiredText } from '../utils/http';
import { isDateOnly, isUuid } from '../utils/validation';

export const ARCHIVE_CATEGORIES = [
  'correspondence', 'contract', 'decision', 'policy', 'payroll', 'finance', 'legal', 'hr', 'report', 'certificate', 'other',
] as const;
const SEPARATION_REASONS = ['resignation', 'termination', 'end_of_contract', 'retirement', 'death', 'absconded', 'other'];

const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Company document archive (any file type up to 50 MB, optionally tied to an
 * employee or a department) and the former-employees archive.
 */
export class ArchiveController {
  static async list(req: Request, res: Response): Promise<void> {
    const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const category = (ARCHIVE_CATEGORIES as readonly string[]).includes(String(req.query.category)) ? String(req.query.category) : null;
    const employeeId = isUuid(req.query.employeeId) ? String(req.query.employeeId) : null;
    const seeConfidential = await can(req, 'archive.manage');
    const scope = employeeScopeSql(req);
    const rows = await select(
      `SELECT a.id, a.title, a.category, a.doc_date AS "docDate", a.reference, a.tags, a.notes, a.original_name AS "originalName",
              a.mime_type AS "mimeType", a.size_bytes::float AS "sizeBytes", a.sha256, a.confidential, a.created_at AS "createdAt",
              u.name AS "uploadedByName", e.id AS "employeeId", e.full_name AS "employeeName", e.employee_no AS "employeeNo",
              d.name AS "departmentName"
       FROM archive_documents a JOIN users u ON u.id = a.uploaded_by
       LEFT JOIN employees e ON e.id = a.employee_id LEFT JOIN departments d ON d.id = a.department_id
       WHERE a.withdrawn_at IS NULL
         AND (:seeConfidential OR NOT a.confidential)
         AND (a.employee_id IS NULL OR EXISTS (SELECT 1 FROM employees e WHERE e.id = a.employee_id${scope.sql}))
         AND (:category::text IS NULL OR a.category = :category::text)
         AND (:employeeId::uuid IS NULL OR a.employee_id = :employeeId::uuid)
         AND (:search = '' OR a.title ILIKE :like OR a.reference ILIKE :like OR a.tags ILIKE :like OR a.original_name ILIKE :like
              OR e.full_name ILIKE :like OR e.employee_no ILIKE :like)
       ORDER BY a.created_at DESC LIMIT 500`,
      { ...scope.params, seeConfidential, category, employeeId, search, like: `%${search}%` },
    );
    res.json({ data: rows });
  }

  static async upload(req: Request, res: Response): Promise<void> {
    const file = req.file;
    if (!file) throw badRequest('اختر ملفاً لرفعه.');
    const input = body(req);
    assertOnlyKeys(input, ['title', 'category', 'employeeId', 'departmentId', 'docDate', 'reference', 'tags', 'notes', 'confidential']);
    const category = String(input.category || 'other');
    if (!(ARCHIVE_CATEGORIES as readonly string[]).includes(category)) throw badRequest('تصنيف غير معروف.');
    const employeeId = input.employeeId ? String(input.employeeId) : null;
    if (employeeId) await employeeInScope(req, employeeId);
    const departmentId = input.departmentId ? String(input.departmentId) : null;
    if (departmentId && (!isUuid(departmentId) || !(await selectOne('SELECT 1 FROM departments WHERE id = :id', { id: departmentId })))) {
      throw badRequest('القسم غير موجود.');
    }
    const docDate = input.docDate ? String(input.docDate) : null;
    if (docDate && !isDateOnly(docDate)) throw badRequest('تاريخ المستند غير صالح.');
    const originalName = uploadedName(file, 'file');
    const title = optionalText(input, 'title', 200) || originalName;
    const storageKey = await storeFile('archive', file.buffer, safeExtension(originalName));
    const id = randomUUID();
    const mime = inlineSafeType(file.buffer)?.mime ?? (file.mimetype || 'application/octet-stream').slice(0, 120);
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO archive_documents (id, title, category, employee_id, department_id, doc_date, reference, tags, notes,
           storage_key, original_name, mime_type, size_bytes, sha256, confidential, uploaded_by)
         VALUES (:id, :title, :category, :employeeId, :departmentId, :docDate, :reference, :tags, :notes,
           :storageKey, :originalName, :mime, :size, :hash, :confidential, :userId)`,
        {
          id, title, category, employeeId, departmentId, docDate,
          reference: optionalText(input, 'reference', 80) ?? null, tags: optionalText(input, 'tags', 300) ?? null,
          notes: optionalText(input, 'notes', 1000) ?? null, storageKey, originalName, mime, size: file.size,
          hash: sha256(file.buffer), confidential: input.confidential === 'true' || input.confidential === true, userId: req.user!.id,
        },
        tx,
      );
      await recordAudit(req, tx, 'archive.uploaded', 'archive_document', id, { title, category, employeeId, size: file.size });
    });
    res.status(201).json({ data: { id } });
  }

  static async download(req: Request, res: Response): Promise<void> {
    const seeConfidential = await can(req, 'archive.manage');
    const doc = await selectOne<{ id: string; storageKey: string; originalName: string; mimeType: string; employeeId: string | null; confidential: boolean }>(
      `SELECT id, storage_key AS "storageKey", original_name AS "originalName", mime_type AS "mimeType",
              employee_id AS "employeeId", confidential
       FROM archive_documents WHERE id = :id AND withdrawn_at IS NULL`,
      { id: req.params.id },
    );
    if (!doc || (doc.confidential && !seeConfidential)) throw notFound('المستند غير موجود.');
    if (doc.employeeId) await employeeInScope(req, doc.employeeId);
    if (!(await storedFileExists(doc.storageKey))) throw notFound('ملف المستند غير موجود على الخادم.');
    await recordAudit(req, null, 'archive.viewed', 'archive_document', doc.id);
    const inline = req.query.inline === '1' && ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(doc.mimeType);
    res.setHeader('Content-Type', inline ? doc.mimeType : 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(doc.originalName, inline));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    openStoredFile(doc.storageKey).pipe(res);
  }

  /** Moves a document to the recycle bin (restorable). */
  static async withdraw(req: Request, res: Response): Promise<void> {
    const reason = optionalText(body(req), 'reason', 300) ?? null;
    await transaction(async (tx) => {
      const copy = await snapshot('archive_documents', req.params.id, tx);
      if (!copy || copy.withdrawn_at) throw notFound('المستند غير موجود.');
      await execute('UPDATE archive_documents SET withdrawn_at = now(), withdrawn_by = :userId, withdraw_reason = :reason WHERE id = :id',
        { id: req.params.id, userId: req.user!.id, reason }, tx);
      await moveToBin(req, tx, { entityType: 'archive_document', entityId: req.params.id, module: 'archive', title: `أرشيف: ${String(copy.title)}`, payload: copy, reason });
      await recordAudit(req, tx, 'archive.withdrawn', 'archive_document', req.params.id, { reason });
    });
    res.json({ data: { ok: true } });
  }

  // --- Former employees -----------------------------------------------------

  static async former(req: Request, res: Response): Promise<void> {
    const scope = employeeScopeSql(req);
    const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const rows = await select(
      `SELECT e.id, e.employee_no AS "employeeNo", e.full_name AS "fullName", e.department, e.position, b.name AS "branchName",
              to_char(e.hire_date, 'YYYY-MM-DD') AS "hireDate", to_char(e.termination_date, 'YYYY-MM-DD') AS "terminationDate",
              e.separation_reason AS "separationReason", e.separation_note AS "separationNote", e.separated_at AS "separatedAt",
              u.name AS "separatedByName", e.employment_status::text AS status,
              (SELECT count(*) FROM archive_documents a WHERE a.employee_id = e.id AND a.withdrawn_at IS NULL) AS documents
       FROM employees e JOIN branches b ON b.id = e.branch_id LEFT JOIN users u ON u.id = e.separated_by
       WHERE (e.termination_date IS NOT NULL AND e.termination_date <= CURRENT_DATE OR e.employment_status = 'inactive')${scope.sql}
         AND (:search = '' OR e.full_name ILIKE :like OR e.employee_no ILIKE :like)
       ORDER BY e.termination_date DESC NULLS LAST, e.full_name LIMIT 1000`,
      { ...scope.params, search, like: `%${search}%` },
    );
    res.json({ data: rows });
  }

  static async separate(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const input = body(req);
    assertOnlyKeys(input, ['terminationDate', 'reason', 'note', 'disableAccount']);
    const date = String(input.terminationDate || '');
    if (!isDateOnly(date)) throw badRequest('حدد تاريخ آخر يوم عمل.');
    if (date < employee.hireDate) throw badRequest('تاريخ الانفكاك قبل تاريخ المباشرة.');
    const reason = String(input.reason || '');
    if (!SEPARATION_REASONS.includes(reason)) throw badRequest('حدد سبب الانفكاك.');
    const note = optionalText(input, 'note', 1000) ?? null;
    await transaction(async (tx) => {
      await execute(
        `UPDATE employees SET termination_date = :date, separation_reason = :reason, separation_note = :note,
           separated_by = :userId, separated_at = now(),
           employment_status = CASE WHEN :date::date <= CURRENT_DATE THEN 'inactive'::enum_employees_employment_status ELSE employment_status END,
           updated_at = now()
         WHERE id = :id`,
        { id: employee.id, date, reason, note, userId: req.user!.id },
        tx,
      );
      if (input.disableAccount !== false) {
        await execute(
          `UPDATE users SET is_active = false, token_version = token_version + 1, updated_at = now()
           WHERE employee_id = :id AND role = 'employee'`,
          { id: employee.id }, tx,
        );
      }
      await recordAudit(req, tx, 'employee.separated', 'employee', employee.id, { date, reason });
    });
    res.json({ data: { ok: true } });
  }

  static async reinstate(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const note = requiredText(body(req), 'note', 500, 'سبب الإرجاع');
    await transaction(async (tx) => {
      await execute(
        `UPDATE employees SET termination_date = NULL, separation_reason = NULL, separation_note = NULL, separated_by = NULL,
           separated_at = NULL, employment_status = 'active', updated_at = now() WHERE id = :id`,
        { id: employee.id }, tx,
      );
      await recordAudit(req, tx, 'employee.reinstated', 'employee', employee.id, { note });
      await notifyEmployees([employee.id], { kind: 'employee', title: 'أُعيد تفعيل ملفك الوظيفي', link: '/my' }, tx);
    });
    res.json({ data: { ok: true } });
  }
}

export default ArchiveController;
