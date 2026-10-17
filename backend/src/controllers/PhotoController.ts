import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Transaction } from 'sequelize';
import { execute, select, selectOne, transaction } from '../db/query';
import { employeeScopeSql } from '../services/access';
import { notifyEmployees, notifyPermission } from '../services/notify';
import { assertPortal } from '../services/portal';
import { openStoredFile, sniffFile, storedFileExists, storeFile } from '../services/storage';
import { recordAudit } from '../utils/audit';
import { sha256 } from '../utils/crypto';
import { assertOnlyKeys, badRequest, body, conflict, forbidden, notFound, requiredText } from '../utils/http';
import { isUuid } from '../utils/validation';

const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

interface Submission {
  id: string; employeeId: string; storageKey: string; mimeType: string; sizeBytes: number; sha256: string;
  status: string; employeeNo: string; fullName: string; photoDocumentId: string | null;
}

function ownEmployeeId(req: Request): string {
  if (!req.user?.employeeId) throw forbidden('حسابك غير مرتبط بملف موظف.');
  return req.user.employeeId;
}

async function submissionsInScope(req: Request, ids: string[] | null, tx?: Transaction): Promise<Submission[]> {
  const scope = employeeScopeSql(req, 'e');
  return select<Submission>(
    `SELECT s.id, s.employee_id AS "employeeId", s.storage_key AS "storageKey", s.mime_type AS "mimeType",
            s.size_bytes AS "sizeBytes", s.sha256, s.status, e.employee_no AS "employeeNo", e.full_name AS "fullName",
            e.photo_document_id AS "photoDocumentId"
     FROM employee_photo_submissions s JOIN employees e ON e.id = s.employee_id
     WHERE s.status = 'pending' ${ids ? 'AND s.id IN (:ids)' : ''}${scope.sql}
     ORDER BY s.submitted_at
     ${tx ? 'FOR UPDATE OF s' : ''}`,
    { ...(ids ? { ids } : {}), ...scope.params },
    tx,
  );
}

/**
 * The employee's own photo, sent from the portal and taken into the file by
 * HR: one by one, or every waiting photo with one click.
 */
export class PhotoController {
  /** The portal: send a photo. A newer one replaces a photo still waiting. */
  static async submit(req: Request, res: Response): Promise<void> {
    await assertPortal('photoUpload');
    const employeeId = ownEmployeeId(req);
    const file = req.file;
    if (!file) throw badRequest('اختر صورة لرفعها.');
    if (file.size > MAX_PHOTO_BYTES) throw badRequest('حجم الصورة يجب ألا يتجاوز 3 ميغابايت.');
    const kind = sniffFile(file.buffer, ['image/jpeg', 'image/png', 'image/webp']);
    const storageKey = await storeFile(`employees/${employeeId}/submitted`, file.buffer, kind.ext);
    const id = randomUUID();
    await transaction(async (tx) => {
      await execute(
        `UPDATE employee_photo_submissions SET status = 'replaced', decided_at = now()
         WHERE employee_id = :employeeId AND status = 'pending'`,
        { employeeId }, tx,
      );
      await execute(
        `INSERT INTO employee_photo_submissions (id, employee_id, storage_key, mime_type, size_bytes, sha256, submitted_by)
         VALUES (:id, :employeeId, :storageKey, :mime, :size, :hash, :userId)`,
        { id, employeeId, storageKey, mime: kind.mime, size: file.size, hash: sha256(file.buffer), userId: req.user!.id },
        tx,
      );
      const employee = await selectOne<{ fullName: string; employeeNo: string }>(
        'SELECT full_name AS "fullName", employee_no AS "employeeNo" FROM employees WHERE id = :employeeId', { employeeId }, tx,
      );
      await notifyPermission('employees.manage_profile', {
        kind: 'photo', title: 'صورة شخصية جديدة من بوابة الموظف',
        body: employee ? `${employee.fullName} (${employee.employeeNo})` : null, link: '/employees-import',
      }, tx, req.user!.id);
      await recordAudit(req, tx, 'employee.photo_submitted', 'employee', employeeId, { submissionId: id });
    });
    res.status(201).json({ data: { id, status: 'pending' } });
  }

  /** The portal: the state of my last photo. */
  static async mine(req: Request, res: Response): Promise<void> {
    const employeeId = ownEmployeeId(req);
    const row = await selectOne(
      `SELECT id, status, submitted_at AS "submittedAt", decided_at AS "decidedAt", decision_note AS "decisionNote"
       FROM employee_photo_submissions WHERE employee_id = :employeeId AND status <> 'replaced'
       ORDER BY submitted_at DESC LIMIT 1`,
      { employeeId },
    );
    res.json({ data: row ?? null });
  }

  /** HR: photos waiting, within the user's scope. */
  static async list(req: Request, res: Response): Promise<void> {
    const scope = employeeScopeSql(req, 'e');
    const rows = await select(
      `SELECT s.id, s.employee_id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "fullName",
              b.name AS "branchName", s.submitted_at AS "submittedAt", s.size_bytes AS "sizeBytes",
              e.photo_document_id IS NOT NULL AS "hasPhoto"
       FROM employee_photo_submissions s
       JOIN employees e ON e.id = s.employee_id
       JOIN branches b ON b.id = e.branch_id
       WHERE s.status = 'pending'${scope.sql}
       ORDER BY s.submitted_at`,
      scope.params,
    );
    res.json({ data: rows });
  }

  static async file(req: Request, res: Response): Promise<void> {
    if (!isUuid(req.params.id)) throw notFound('الصورة غير موجودة.');
    const scope = employeeScopeSql(req, 'e');
    const row = await selectOne<{ storageKey: string; mimeType: string }>(
      `SELECT s.storage_key AS "storageKey", s.mime_type AS "mimeType"
       FROM employee_photo_submissions s JOIN employees e ON e.id = s.employee_id
       WHERE s.id = :id${scope.sql}`,
      { id: req.params.id, ...scope.params },
    );
    if (!row || !(await storedFileExists(row.storageKey))) throw notFound('الصورة غير موجودة.');
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    openStoredFile(row.storageKey).pipe(res);
  }

  /** HR: take the listed photos (or every waiting photo) into the employees' files. */
  static async accept(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['ids']);
    const ids = input.ids === undefined ? null : input.ids;
    if (ids !== null && (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every(isUuid))) {
      throw badRequest('حدد الصور المراد اعتمادها.');
    }
    const accepted = await transaction(async (tx) => {
      const rows = await submissionsInScope(req, ids as string[] | null, tx);
      for (const row of rows) {
        const documentId = randomUUID();
        if (row.photoDocumentId) {
          await execute('UPDATE employee_documents SET deleted_at = now(), deleted_by = :userId WHERE id = :id AND deleted_at IS NULL',
            { id: row.photoDocumentId, userId: req.user!.id }, tx);
        }
        await execute(
          `INSERT INTO employee_documents (id, employee_id, doc_type, title, storage_key, original_name, mime_type, size_bytes, sha256, uploaded_by)
           VALUES (:id, :employeeId, 'photo', 'الصورة الشخصية', :storageKey, :originalName, :mime, :size, :hash, :userId)`,
          {
            id: documentId, employeeId: row.employeeId, storageKey: row.storageKey,
            originalName: `photo.${row.mimeType.split('/')[1] === 'jpeg' ? 'jpg' : row.mimeType.split('/')[1]}`,
            mime: row.mimeType, size: row.sizeBytes, hash: row.sha256, userId: req.user!.id,
          },
          tx,
        );
        await execute('UPDATE employees SET photo_document_id = :documentId, updated_at = now() WHERE id = :employeeId',
          { documentId, employeeId: row.employeeId }, tx);
        await execute(
          `UPDATE employee_photo_submissions SET status = 'accepted', decided_by = :userId, decided_at = now(), document_id = :documentId
           WHERE id = :id`,
          { id: row.id, userId: req.user!.id, documentId }, tx,
        );
        await recordAudit(req, tx, 'employee.photo_updated', 'employee', row.employeeId, { documentId, fromPortal: row.id });
      }
      if (rows.length) {
        await notifyEmployees(rows.map((row) => row.employeeId), {
          kind: 'photo', title: 'اعتُمدت صورتك الشخصية', body: 'تظهر الآن في ملفك وبطاقتك.', link: '/my',
        }, tx);
      }
      return rows.length;
    });
    if (ids && accepted !== ids.length) {
      res.status(accepted ? 200 : 409).json({
        data: { accepted },
        ...(accepted ? {} : { message: 'لا توجد صور بانتظار الاعتماد ضمن نطاقك بهذه الأرقام.' }),
      });
      return;
    }
    res.json({ data: { accepted } });
  }

  static async reject(req: Request, res: Response): Promise<void> {
    if (!isUuid(req.params.id)) throw notFound('الصورة غير موجودة.');
    const input = body(req);
    assertOnlyKeys(input, ['note']);
    const note = requiredText(input, 'note', 500, 'سبب الرفض');
    await transaction(async (tx) => {
      const [row] = await submissionsInScope(req, [req.params.id], tx);
      if (!row) throw conflict('الصورة ليست بانتظار الاعتماد أو خارج نطاقك.');
      await execute(
        `UPDATE employee_photo_submissions SET status = 'rejected', decided_by = :userId, decided_at = now(), decision_note = :note
         WHERE id = :id`,
        { id: row.id, userId: req.user!.id, note }, tx,
      );
      await notifyEmployees([row.employeeId], { kind: 'photo', title: 'لم تُعتمد صورتك الشخصية', body: note, link: '/my' }, tx);
      await recordAudit(req, tx, 'employee.photo_rejected', 'employee', row.employeeId, { submissionId: row.id, note });
    });
    res.json({ data: { id: req.params.id } });
  }

  /**
   * Bulk photos named after the employee number or fingerprint number
   * (10123.jpg): tells which employee each name belongs to before uploading.
   */
  static async match(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['names']);
    const names = input.names;
    if (!Array.isArray(names) || !names.length || names.length > 1000 || !names.every((name) => typeof name === 'string' && name.length <= 255)) {
      throw badRequest('أرسل أسماء الملفات.');
    }
    const keys = names.map((name) => {
      const stem = String(name).replace(/\.[^.]+$/, '').trim();
      const leading = stem.match(/^[A-Za-z0-9_-]+/)?.[0] ?? stem;
      return leading.replace(/^0+(?=\d)/, '');
    });
    const scope = employeeScopeSql(req, 'e');
    const candidates = await select<{ key: string; id: string; employeeNo: string; fullName: string; hasPhoto: boolean; rank: number }>(
      `SELECT k.key, e.id, e.employee_no AS "employeeNo", e.full_name AS "fullName", e.photo_document_id IS NOT NULL AS "hasPhoto",
              CASE WHEN e.employee_no = k.key THEN 1 ELSE 2 END AS rank
       FROM unnest(ARRAY[:keys]::text[]) AS k(key)
       JOIN employees e ON e.employee_no = k.key OR e.attendance_pin = k.key
       WHERE true${scope.sql}`,
      { keys: keys.length ? keys : [''], ...scope.params },
    );
    const best = new Map<string, (typeof candidates)[number]>();
    for (const row of candidates) {
      const current = best.get(row.key);
      if (!current || row.rank < current.rank) best.set(row.key, row);
    }
    res.json({
      data: names.map((name, index) => {
        const hit = best.get(keys[index]);
        return { name, key: keys[index], employee: hit ? { id: hit.id, employeeNo: hit.employeeNo, fullName: hit.fullName, hasPhoto: hit.hasPhoto } : null };
      }),
    });
  }
}
