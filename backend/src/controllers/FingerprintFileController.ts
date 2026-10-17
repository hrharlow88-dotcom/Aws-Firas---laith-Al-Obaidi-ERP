import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { execute, transaction } from '../db/query';
import { branchScope } from '../services/access';
import { computeAttendance, ingestPunches, recomputeAfterIngest } from '../services/attendance';
import { addDays } from '../services/attendanceRules';
import {
  FILE_KINDS, FileKind, FilePlan, ImportOptions, planFile, savePins, writeLeaves, writeTasks,
} from '../services/fingerprintImport';
import { getSettings } from '../services/settings';
import { SheetFormatError } from '../services/sheetRead';
import { uploadedName } from '../services/storage';
import { recordAudit } from '../utils/audit';
import { badRequest } from '../utils/http';
import { isUuid } from '../utils/validation';

const KIND_LABEL: Record<FileKind, string> = { attendance: 'الحضور', leaves: 'الإجازات', tasks: 'المهام' };

function jsonField<T>(value: unknown, check: (parsed: unknown) => parsed is T): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    const parsed = JSON.parse(String(value));
    if (check(parsed)) return parsed;
  } catch { /* falls through */ }
  throw badRequest('إعدادات الأعمدة غير صالحة. أعد اختيار الملف.');
}

const isMapping = (value: unknown): value is Record<string, number> => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.entries(value as object).every(([key, column]) => /^[a-zA-Z]{1,20}$/.test(key) && Number.isInteger(column) && (column as number) >= -1 && (column as number) < 200);
const isTypeMap = (value: unknown): value is Record<string, string> => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.entries(value as object).length <= 200 &&
  Object.entries(value as object).every(([key, type]) => key.length <= 200 && typeof type === 'string' && (type === 'skip' || isUuid(type)));

function options(req: Request): ImportOptions {
  const input = (req.body ?? {}) as Record<string, unknown>;
  const kind = String(input.kind ?? '') as FileKind;
  if (!FILE_KINDS.includes(kind)) throw badRequest('حدد نوع الملف: الحضور أو الإجازات أو المهام.');
  const headerIndex = input.headerIndex === undefined || input.headerIndex === '' ? undefined : Number(input.headerIndex);
  if (headerIndex !== undefined && (!Number.isInteger(headerIndex) || headerIndex < 0 || headerIndex > 50)) throw badRequest('صف العناوين غير صالح.');
  const defaultTypeId = typeof input.defaultTypeId === 'string' && isUuid(input.defaultTypeId) ? input.defaultTypeId : null;
  return {
    kind,
    dateOrder: input.dateOrder === 'mdy' ? 'mdy' : 'dmy',
    mapping: jsonField(input.mapping, isMapping),
    headerIndex,
    typeMap: jsonField(input.typeMap, isTypeMap),
    defaultTypeId,
    branchId: branchScope(req),
    ownEmployeeId: req.user?.employeeId ?? null,
  };
}

async function readPlan(req: Request, tx?: import('sequelize').Transaction): Promise<FilePlan> {
  const file = req.file;
  if (!file) throw badRequest('اختر الملف.');
  try {
    return await planFile(file.buffer, options(req), await getSettings(), tx);
  } catch (error) {
    if (error instanceof SheetFormatError) throw badRequest(error.message);
    throw error;
  }
}

function publicPlan(plan: FilePlan) {
  return {
    kind: plan.kind, format: plan.format, headerIndex: plan.headerIndex, header: plan.header, sample: plan.sample, top: plan.top,
    mapping: plan.mapping, fields: plan.fields, leaveTypes: plan.leaveTypes, summary: plan.summary,
    rows: plan.rows.slice(0, 1500),
    rowsShown: Math.min(plan.rows.length, 1500),
  };
}

/**
 * The fingerprint system's three exports — attendance, leave, app tasks —
 * each previewed and then applied on its own.
 */
export class FingerprintFileController {
  static async preview(req: Request, res: Response): Promise<void> {
    res.json({ data: publicPlan(await readPlan(req)) });
  }

  static async apply(req: Request, res: Response): Promise<void> {
    const kind = options(req).kind;
    const fileName = uploadedName(req.file!, `${kind}.xlsx`);
    if (kind === 'attendance') {
      const plan = await readPlan(req);
      if (plan.summary.problem) throw badRequest(String(plan.summary.problem));
      if (!plan.writes.punches.length) throw badRequest('لا توجد بصمات في الملف بالأعمدة المحددة.');
      const saved = await transaction(async (tx) => {
        const list = await savePins(plan.writes.assign, tx);
        for (const item of list) await recordAudit(req, tx, 'attendance.pin_assigned', 'employee', item.employeeId, { pin: item.pin, from: 'attendance_file' });
        return list;
      });
      const result = await ingestPunches(plan.writes.punches.map(({ pin, at }) => ({ pin, at })), {
        source: 'file', fileName, userId: req.user!.id, invalid: Number(plan.summary.error ?? 0),
      });
      await execute('UPDATE attendance_imports SET kind = \'attendance\', summary = :summary::jsonb WHERE id = :id',
        { id: result.importId, summary: JSON.stringify({ ...plan.summary, pinsSaved: saved.length }) });
      await recordAudit(req, null, 'attendance.imported', 'attendance_import', result.importId, {
        file: fileName, kind, imported: result.imported, duplicate: result.duplicate, unmatched: result.unmatched, pinsSaved: saved.length,
      });
      await recomputeAfterIngest(result);
      if (saved.length && result.from && result.to) {
        await computeAttendance({ from: addDays(result.from, -1), to: result.to, employeeIds: saved.map((item) => item.employeeId) });
      }
      res.status(201).json({ data: { kind, imported: result.imported, duplicate: result.duplicate, unmatched: result.unmatched, pinsSaved: saved.length, from: result.from, to: result.to } });
      return;
    }

    const outcome = await transaction(async (tx) => {
      // Re-read inside the transaction so what is written matches the database now.
      const plan = await readPlan(req, tx);
      if (plan.summary.problem) throw badRequest(String(plan.summary.problem));
      const nothing = kind === 'leaves' ? !plan.writes.leaves.length : !plan.writes.tasks.length;
      if (nothing) throw badRequest(`لا توجد ${KIND_LABEL[kind]} جديدة لاعتمادها في الملف.`);
      const saved = await savePins(plan.writes.assign, tx);
      for (const item of saved) await recordAudit(req, tx, 'attendance.pin_assigned', 'employee', item.employeeId, { pin: item.pin, from: `${kind}_file` });
      const importId = randomUUID();
      await execute(
        `INSERT INTO attendance_imports (id, source, kind, file_name, rows_total, rows_imported, rows_duplicate, rows_unmatched, rows_invalid, created_by, summary)
         VALUES (:id, 'file', :kind, :fileName, :total, 0, :duplicate, 0, :invalid, :userId, :summary::jsonb)`,
        {
          id: importId, kind, fileName, total: plan.rows.length, duplicate: Number(plan.summary.duplicate ?? 0),
          invalid: Number(plan.summary.error ?? 0), userId: req.user!.id, summary: JSON.stringify({ ...plan.summary, pinsSaved: saved.length }),
        },
        tx,
      );
      let written: { leaves?: number; tasks?: number; punches?: number };
      if (kind === 'leaves') {
        const ids = await writeLeaves(plan, importId, { id: req.user!.id, role: req.user!.role }, tx);
        for (const [index, id] of ids.entries()) {
          const leave = plan.writes.leaves[index];
          await recordAudit(req, tx, 'leave.imported', 'leave_request', id, {
            importId, employeeId: leave.employeeId, leaveTypeId: leave.typeId, startsOn: leave.startsOn, endsOn: leave.endsOn, quantity: leave.quantity,
          });
        }
        written = { leaves: ids.length };
      } else {
        written = await writeTasks(plan, importId, req.user!.id, tx);
      }
      const imported = written.leaves ?? written.tasks ?? 0;
      await execute('UPDATE attendance_imports SET rows_imported = :imported WHERE id = :id', { id: importId, imported }, tx);
      await recordAudit(req, tx, 'attendance.imported', 'attendance_import', importId, { file: fileName, kind, ...written, pinsSaved: saved.length });
      const employeeIds = [...new Set(kind === 'leaves' ? plan.writes.leaves.map((item) => item.employeeId) : plan.writes.tasks.map((item) => item.employeeId))];
      return { importId, written, employeeIds, from: plan.summary.from as string | null, to: plan.summary.to as string | null, pinsSaved: saved.length };
    });
    if (outcome.from && outcome.to && outcome.employeeIds.length) {
      await computeAttendance({ from: addDays(outcome.from, -1), to: outcome.to, employeeIds: outcome.employeeIds });
    }
    res.status(201).json({ data: { kind, ...outcome.written, pinsSaved: outcome.pinsSaved, from: outcome.from, to: outcome.to } });
  }
}
