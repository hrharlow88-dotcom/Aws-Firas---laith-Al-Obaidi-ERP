import { Request, Response } from 'express';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execute, select, selectOne, transaction } from '../db/query';
import { employeeScopeSql } from '../services/access';
import { makeThumb, photoThumb, saveThumb } from '../services/employeePhotos';
import {
  claimStagedImport, discardStagedImport, loadStagedImport, PHOTO_ZIP_LIMITS, readStagedPhoto, saveStagedImport, scanPhotoZip,
  stagePhoto, StagedItem, STAGING_HOURS, sweepStagedImports, unstagePhoto, ZipAbandoned,
} from '../services/photoZip';
import { resolveKey, storeFile, uploadedName } from '../services/storage';
import { recordAudit } from '../utils/audit';
import { sha256 } from '../utils/crypto';
import { assertOnlyKeys, badRequest, body, conflict, HttpError, notFound } from '../utils/http';
import { isUuid } from '../utils/validation';

type ItemStatus = StagedItem['status'];

const STATUS_REASON: Partial<Record<ItemStatus, string>> = {
  ready: 'تُضاف إلى ملف الموظف',
  has_photo: 'لدى الموظف صورة حالية؛ تبقى إلا إذا اخترت الاستبدال',
  unmatched: 'لا يوجد موظف بهذا الرقم الوظيفي ضمن صلاحياتك',
};

const FAILED_STATUSES: ItemStatus[] = ['corrupt', 'too_large', 'encrypted', 'not_image'];

interface PreviewEmployee { id: string; employeeNo: string; fullName: string; branchName: string; hasPhoto: boolean }

function summarise(items: StagedItem[], ignored: number) {
  const count = (statuses: ItemStatus[]) => items.filter((item) => statuses.includes(item.status)).length;
  return {
    files: items.length,
    ready: count(['ready']),
    hasPhoto: count(['has_photo']),
    unmatched: count(['unmatched']),
    duplicate: count(['duplicate']),
    invalid: count(FAILED_STATUSES),
    ignored,
  };
}

/** A confirmation runs once even if the button is pressed twice (the manifest claim covers restarts too). */
const applying = new Set<string>();

type Outcome = { result: 'added' | 'replaced' | 'skipped' | 'failed'; reason: string | null; fullName: string | null };

/**
 * Employee photos for the people who manage employee files: thumbnails for lists and the
 * org chart, and photos in bulk from one ZIP named by employee number — checked, previewed,
 * then saved to the files on confirmation.
 */
export class EmployeePhotosController {
  /** Thumbnails for up to 200 employees in one request (lists and the org chart), within the user's scope. */
  static async thumbs(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['ids']);
    const ids = input.ids;
    if (!Array.isArray(ids) || ids.length > 200 || !ids.every(isUuid)) throw badRequest('أرسل أرقام الموظفين (حتى 200).');
    if (!ids.length) { res.json({ data: {} }); return; }
    const scope = employeeScopeSql(req, 'e');
    const rows = await select<{ id: string; documentId: string; storageKey: string }>(
      `SELECT e.id, d.id AS "documentId", d.storage_key AS "storageKey"
       FROM employees e JOIN employee_documents d ON d.id = e.photo_document_id AND d.deleted_at IS NULL
       WHERE e.id IN (:ids)${scope.sql}`,
      { ids, ...scope.params },
    );
    const data: Record<string, { v: string; src: string }> = {};
    for (const row of rows) {
      const thumb = await photoThumb(row.documentId, row.storageKey);
      if (thumb) data[row.id] = { v: row.documentId, src: `data:image/jpeg;base64,${thumb.toString('base64')}` };
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data });
  }

  /**
   * Reads the ZIP, matches each photo by employee number, and keeps the good ones waiting.
   * Saves nothing to the files. One archive at a time (photoZipTurn, before the upload is read).
   */
  static async zipPreview(req: Request, res: Response): Promise<void> {
    const file = req.file;
    if (!file) throw badRequest('اختر ملف ZIP يحتوي صور الموظفين.');
    await sweepStagedImports().catch(() => 0);
    const importId = randomUUID();
    let gone = false;
    res.on('close', () => { if (!res.writableFinished) gone = true; });
    let scan: Awaited<ReturnType<typeof scanPhotoZip>>;
    try {
      scan = await scanPhotoZip(file.buffer, {
        keep: async (index, photo) => ({ key: await stagePhoto(importId, index, photo), sha256: sha256(photo), bytes: photo.length }),
        stopped: () => gone,
      });
    } catch (error) {
      await discardStagedImport(importId);
      if (error instanceof ZipAbandoned) return;
      throw error;
    }
    const perNumber = new Map<string, number>();
    for (const photo of scan.photos) if (photo.status === 'ok' && photo.stem) perNumber.set(photo.stem, (perNumber.get(photo.stem) ?? 0) + 1);
    const numbers = [...perNumber.entries()].filter(([, count]) => count === 1).map(([number]) => number);
    const scope = employeeScopeSql(req, 'e');
    // The number as text, exactly: 010172 and 10172 are different people.
    const employees = numbers.length ? await select<PreviewEmployee>(
      `SELECT e.id, e.employee_no AS "employeeNo", e.full_name AS "fullName", b.name AS "branchName",
              e.photo_document_id IS NOT NULL AS "hasPhoto"
       FROM employees e JOIN branches b ON b.id = e.branch_id
       WHERE e.employee_no IN (:numbers)${scope.sql}`,
      { numbers, ...scope.params },
    ) : [];
    const byNumber = new Map(employees.map((employee) => [employee.employeeNo, employee]));
    const staged: StagedItem[] = [];
    const items = [];
    for (const [index, photo] of scan.photos.entries()) {
      let status: ItemStatus;
      let reason: string | null;
      let employee: PreviewEmployee | null = null;
      if (photo.status !== 'ok') {
        status = photo.status;
        reason = photo.reason;
      } else if (!photo.stem || (perNumber.get(photo.stem) ?? 0) > 1) {
        status = photo.stem ? 'duplicate' : 'unmatched';
        reason = photo.stem ? `الرقم مكرر في الملف (${perNumber.get(photo.stem)} صور)؛ أبقِ صورة واحدة لكل موظف` : STATUS_REASON.unmatched!;
      } else {
        employee = byNumber.get(photo.stem) ?? null;
        status = employee ? (employee.hasPhoto ? 'has_photo' : 'ready') : 'unmatched';
        reason = STATUS_REASON[status]!;
      }
      const waits = (status === 'ready' || status === 'has_photo') && photo.kept;
      if (photo.kept && !waits) await unstagePhoto(photo.kept.key);
      staged.push({
        index, entry: photo.entry, employeeNo: photo.stem, employeeId: employee?.id ?? null, status, reason,
        stagedKey: waits ? photo.kept!.key : null, sha256: waits ? photo.kept!.sha256 : null, bytes: waits ? photo.kept!.bytes : null,
      });
      items.push({
        index, entry: photo.entry, employeeNo: photo.stem, employee, status, reason,
        thumb: photo.thumb ? `data:image/jpeg;base64,${photo.thumb.toString('base64')}` : null,
        width: photo.width ?? null, height: photo.height ?? null,
      });
    }
    const createdAt = new Date();
    const fileName = uploadedName(file, 'photos.zip');
    await saveStagedImport({
      id: importId, userId: req.user!.id, createdAt: createdAt.toISOString(), fileName, zipSha256: sha256(file.buffer),
      ignored: scan.ignored, items: staged,
    });
    res.json({
      data: {
        importId, fileName, expiresAt: new Date(createdAt.getTime() + STAGING_HOURS * 3600_000).toISOString(),
        summary: summarise(staged, scan.ignored), items,
        limits: { zipMb: PHOTO_ZIP_LIMITS.zipBytes / 1048576, images: PHOTO_ZIP_LIMITS.images, imageMb: PHOTO_ZIP_LIMITS.imageBytes / 1048576 },
      },
    });
  }

  /** Saves the previewed photos to the employees' files, once. Current photos are replaced only when asked. */
  static async zipApply(req: Request, res: Response): Promise<void> {
    const importId = req.params.importId;
    if (!isUuid(importId)) throw notFound('المعاينة غير موجودة.');
    const input = body(req);
    assertOnlyKeys(input, ['replace']);
    if (input.replace !== undefined && typeof input.replace !== 'boolean') throw badRequest('خيار الاستبدال غير صالح.');
    const replace = input.replace === true;
    if (applying.has(importId)) throw conflict('هذه الصور تُحفظ الآن.');
    applying.add(importId);
    try {
      const staged = await claimStagedImport(importId, req.user!.id);
      if (!staged) throw new HttpError(410, 'انتهت صلاحية المعاينة أو استُخدمت أو لم تعد متاحة. ارفع ملف ZIP من جديد.');
      const scope = employeeScopeSql(req, 'e');
      const items: Array<{ entry: string; employeeNo: string } & Outcome> = [];
      for (const item of staged.items) {
        const base = { entry: item.entry, employeeNo: item.employeeNo };
        if (item.status !== 'ready' && item.status !== 'has_photo') {
          items.push({ ...base, result: FAILED_STATUSES.includes(item.status) ? 'failed' : 'skipped', reason: item.reason, fullName: null });
          continue;
        }
        if (item.status === 'has_photo' && !replace) {
          items.push({ ...base, result: 'skipped', reason: 'لديه صورة حالية وبقيت كما هي (لم يُختر الاستبدال)', fullName: null });
          continue;
        }
        items.push({ ...base, ...await saveOne(req, scope, item, replace, importId) });
      }
      const summary = {
        added: items.filter((item) => item.result === 'added').length,
        replaced: items.filter((item) => item.result === 'replaced').length,
        skipped: items.filter((item) => item.result === 'skipped').length,
        failed: items.filter((item) => item.result === 'failed').length,
      };
      await recordAudit(req, null, 'employee.photos_zip_imported', 'employee', null, {
        importId, file: staged.fileName, zipSha256: staged.zipSha256, replace, ...summary,
      }).catch(() => undefined);
      await discardStagedImport(importId);
      res.json({ data: { fileName: staged.fileName, summary, items } });
    } finally {
      applying.delete(importId);
    }
  }

  /** Drops a preview the person cancelled. */
  static async zipDiscard(req: Request, res: Response): Promise<void> {
    const importId = req.params.importId;
    if (!isUuid(importId)) throw notFound('المعاينة غير موجودة.');
    const staged = await loadStagedImport(importId, req.user!.id);
    if (staged) await discardStagedImport(importId);
    res.json({ data: { discarded: Boolean(staged) } });
  }
}

/**
 * One photo into one file, under a row lock: scope, the employee number and the current
 * photo are checked again at this moment, so a number changed after the preview links nothing.
 */
async function saveOne(
  req: Request, scope: { sql: string; params: Record<string, unknown> }, item: StagedItem, replace: boolean, importId: string,
): Promise<Outcome> {
  let photo: Buffer;
  try {
    photo = await readStagedPhoto(item.stagedKey!);
    if (sha256(photo) !== item.sha256) throw new Error('changed');
  } catch {
    return { result: 'failed', reason: 'تعذرت قراءة الصورة المحفوظة للمعاينة؛ ارفع الملف من جديد', fullName: null };
  }
  const written: { key: string | null } = { key: null };
  let outcome: Outcome & { documentId?: string };
  try {
    outcome = await transaction(async (tx): Promise<Outcome & { documentId?: string }> => {
      const employee = await selectOne<{ id: string; fullName: string; employeeNo: string; photoDocumentId: string | null }>(
        `SELECT e.id, e.full_name AS "fullName", e.employee_no AS "employeeNo", e.photo_document_id AS "photoDocumentId"
         FROM employees e WHERE e.id = :id${scope.sql} FOR UPDATE OF e`,
        { id: item.employeeId, ...scope.params }, tx,
      );
      if (!employee) return { result: 'failed', reason: 'الموظف لم يعد ضمن صلاحياتك', fullName: null };
      if (employee.employeeNo !== item.employeeNo) {
        return { result: 'failed', reason: 'تغيّر الرقم الوظيفي لهذا الموظف بعد المعاينة؛ ارفع الملف من جديد', fullName: employee.fullName };
      }
      if (employee.photoDocumentId && !replace) {
        return { result: 'skipped', reason: 'أُضيفت له صورة بعد المعاينة؛ بقيت كما هي', fullName: employee.fullName };
      }
      written.key = await storeFile(`employees/${employee.id}`, photo, 'jpg');
      const documentId = randomUUID();
      if (employee.photoDocumentId) {
        await execute('UPDATE employee_documents SET deleted_at = now(), deleted_by = :userId WHERE id = :id AND deleted_at IS NULL',
          { id: employee.photoDocumentId, userId: req.user!.id }, tx);
      }
      await execute(
        `INSERT INTO employee_documents (id, employee_id, doc_type, title, storage_key, original_name, mime_type, size_bytes, sha256, uploaded_by)
         VALUES (:id, :employeeId, 'photo', 'الصورة الشخصية', :storageKey, :originalName, 'image/jpeg', :size, :hash, :userId)`,
        {
          id: documentId, employeeId: employee.id, storageKey: written.key, originalName: `${item.employeeNo}.jpg`,
          size: photo.length, hash: item.sha256, userId: req.user!.id,
        },
        tx,
      );
      await execute('UPDATE employees SET photo_document_id = :documentId, updated_at = now() WHERE id = :employeeId',
        { documentId, employeeId: employee.id }, tx);
      await recordAudit(req, tx, 'employee.photo_updated', 'employee', employee.id, {
        documentId, source: 'zip', importId, entry: item.entry, replaced: Boolean(employee.photoDocumentId),
      });
      return { result: employee.photoDocumentId ? 'replaced' : 'added', reason: null, fullName: employee.fullName, documentId };
    });
  } catch {
    // Nothing was committed: the file written for it, if any, goes too.
    await removeStored(written.key);
    return { result: 'failed', reason: 'تعذر حفظ الصورة؛ أعد المحاولة', fullName: null };
  }
  // Committed from here: the photo is in the file whatever happens to its thumbnail (made again when first asked for).
  if (outcome.documentId) {
    const documentId = outcome.documentId;
    await makeThumb(photo).then((thumb) => saveThumb(documentId, thumb)).catch(() => undefined);
  }
  return { result: outcome.result, reason: outcome.reason, fullName: outcome.fullName };
}

async function removeStored(key: string | null): Promise<void> {
  if (key) await fsp.rm(resolveKey(key), { force: true }).catch(() => undefined);
}
