import { createHash, randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { execute, select, selectOne, transaction } from '../db/query';
import { parsePayrollArchive, ParsedArchive } from '../services/payrollArchive';
import { getSettings } from '../services/settings';
import { employeeInScope, employeeScopeSql } from '../services/access';
import { contentDisposition, openStoredFile, storeFile, storedFileExists, uploadedName } from '../services/storage';
import { moveToBin, snapshot } from '../services/recycleBin';
import { recordAudit } from '../utils/audit';
import { badRequest, body, conflict, notFound, optionalText } from '../utils/http';
import { isUuid } from '../utils/validation';

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

interface Prepared {
  parsed: ParsedArchive;
  period: string;
  hash: string;
  matched: Map<string, string>;
  totals: Record<string, { employees: number; net: number; gross: number }>;
}

async function prepare(req: Request): Promise<Prepared> {
  const file = req.file;
  if (!file) throw badRequest('اختر ملف رواتب الشهر (Excel).');
  if (file.buffer.subarray(0, 2).toString('latin1') !== 'PK') throw badRequest('الملف يجب أن يكون Excel بصيغة xlsx.');
  const settings = await getSettings();
  let parsed: ParsedArchive;
  try {
    parsed = await parsePayrollArchive(file.buffer, settings.payrollRules.baseCurrency);
  } catch {
    throw badRequest('لم أجد في الملف ورقة فيها عمود رقم الموظف وعمود الصافي.');
  }
  const input = body(req);
  const period = typeof input.period === 'string' && input.period ? input.period : parsed.period;
  if (!period || !PERIOD.test(period)) throw badRequest('حدد شهر الرواتب (YYYY-MM)؛ لم يُذكر في الملف.');
  if (parsed.period && input.period && parsed.period !== input.period) {
    throw badRequest(`الملف لشهر ${parsed.period} وليس ${String(input.period)}.`);
  }
  const launch = settings.payrollRules.launchPeriod;
  if (launch && period > launch) {
    throw badRequest(`الأرشيف للأشهر حتى شهر انطلاق النظام (${launch}). الأشهر بعده تُحتسب بمسيرات النظام.`);
  }
  const codes = [...new Set(parsed.lines.map((line) => line.employeeNo))];
  const employees = await select<{ id: string; employeeNo: string }>(
    'SELECT id, employee_no AS "employeeNo" FROM employees WHERE employee_no IN (:codes)', { codes: codes.length ? codes : [''] },
  );
  const matched = new Map(employees.map((employee) => [employee.employeeNo, employee.id]));
  const totals: Prepared['totals'] = {};
  for (const line of parsed.lines) {
    const total = (totals[line.currency] ??= { employees: 0, net: 0, gross: 0 });
    total.employees += 1;
    total.net = Math.round((total.net + line.netPay) * 100) / 100;
    total.gross = Math.round((total.gross + (line.gross ?? line.totalEarnings ?? 0)) * 100) / 100;
  }
  return { parsed, period, hash: createHash('sha256').update(file.buffer).digest('hex'), matched, totals };
}

/**
 * The payroll archive: the months paid outside the system (from January
 * 2026 up to the launch month), kept file by file with each employee's line.
 */
export class PayrollArchiveController {
  static async preview(req: Request, res: Response): Promise<void> {
    const prepared = await prepare(req);
    const duplicate = await selectOne<{ id: string }>(
      'SELECT id FROM payroll_archive_months WHERE period = :period AND sha256 = :hash AND withdrawn_at IS NULL',
      { period: prepared.period, hash: prepared.hash },
    );
    res.json({
      data: {
        format: prepared.parsed.format, sheet: prepared.parsed.sheet, period: prepared.period, duplicate: Boolean(duplicate),
        lines: prepared.parsed.lines.length, skipped: prepared.parsed.skipped, totals: prepared.totals,
        matched: prepared.matched.size,
        unmatched: prepared.parsed.lines.filter((line) => !prepared.matched.has(line.employeeNo))
          .map((line) => ({ employeeNo: line.employeeNo, employeeName: line.employeeName })).slice(0, 100),
        sample: prepared.parsed.lines.slice(0, 15),
      },
    });
  }

  static async save(req: Request, res: Response): Promise<void> {
    const prepared = await prepare(req);
    const input = body(req);
    const label = optionalText(input, 'label', 120) || `رواتب ${prepared.period}`;
    const branchId = isUuid(input.branchId) ? String(input.branchId) : null;
    const id = randomUUID();
    const storageKey = await storeFile('payroll-archive', req.file!.buffer, 'xlsx');
    await transaction(async (tx) => {
      const duplicate = await selectOne('SELECT 1 FROM payroll_archive_months WHERE period = :period AND sha256 = :hash AND withdrawn_at IS NULL',
        { period: prepared.period, hash: prepared.hash }, tx);
      if (duplicate) throw conflict('هذا الملف مؤرشف مسبقاً لنفس الشهر.');
      await execute(
        `INSERT INTO payroll_archive_months (id, period, label, branch_id, storage_key, original_name, sha256, employee_count, totals, notes, uploaded_by)
         VALUES (:id, :period, :label, :branchId, :storageKey, :name, :hash, :count, :totals, :notes, :userId)`,
        {
          id, period: prepared.period, label, branchId, storageKey, name: uploadedName(req.file!, 'payroll.xlsx'), hash: prepared.hash,
          count: prepared.parsed.lines.length, totals: JSON.stringify(prepared.totals), notes: optionalText(input, 'notes', 500) ?? null,
          userId: req.user!.id,
        },
        tx,
      );
      const rows = prepared.parsed.lines.map((line) => ({ ...line, employeeId: prepared.matched.get(line.employeeNo) ?? null, details: line.details }));
      for (let index = 0; index < rows.length; index += 500) {
        await execute(
          `INSERT INTO payroll_archive_lines (month_id, employee_id, employee_no, employee_name, currency, gross, total_earnings, total_deductions, net_pay, details)
           SELECT :monthId, x."employeeId", x."employeeNo", x."employeeName", x.currency, x.gross, x."totalEarnings", x."totalDeductions", x."netPay", x.details
           FROM jsonb_to_recordset(:rows::jsonb) AS x("employeeId" uuid, "employeeNo" varchar, "employeeName" varchar, currency char(3),
             gross numeric, "totalEarnings" numeric, "totalDeductions" numeric, "netPay" numeric, details jsonb)`,
          { monthId: id, rows: JSON.stringify(rows.slice(index, index + 500)) },
          tx,
        );
      }
      await recordAudit(req, tx, 'payroll_archive.saved', 'payroll_archive_month', id, {
        period: prepared.period, lines: rows.length, totals: prepared.totals,
      });
    });
    res.status(201).json({ data: { id } });
  }

  /** Months in order, each with its files and totals; launchPeriod tells where the system takes over. */
  static async list(_req: Request, res: Response): Promise<void> {
    const settings = await getSettings();
    const rows = await select(
      `SELECT m.id, m.period, m.label, m.original_name AS "originalName", m.employee_count AS "employeeCount", m.totals, m.notes,
              m.created_at AS "createdAt", u.name AS "uploadedByName", b.name AS "branchName",
              (SELECT count(*) FROM payroll_archive_lines l WHERE l.month_id = m.id AND l.employee_id IS NULL) AS unmatched
       FROM payroll_archive_months m JOIN users u ON u.id = m.uploaded_by LEFT JOIN branches b ON b.id = m.branch_id
       WHERE m.withdrawn_at IS NULL ORDER BY m.period DESC, m.created_at`,
    );
    res.json({ data: { months: rows, launchPeriod: settings.payrollRules.launchPeriod ?? null } });
  }

  static async lines(req: Request, res: Response): Promise<void> {
    const scope = employeeScopeSql(req);
    const month = await selectOne('SELECT id, period, label FROM payroll_archive_months WHERE id = :id AND withdrawn_at IS NULL', { id: req.params.id });
    if (!month) throw notFound('الشهر غير موجود في الأرشيف.');
    const rows = await select(
      `SELECT l.id, l.employee_no AS "employeeNo", COALESCE(e.full_name, l.employee_name) AS "employeeName", l.employee_id AS "employeeId",
              l.currency, l.gross::float AS gross, l.total_earnings::float AS "totalEarnings", l.total_deductions::float AS "totalDeductions",
              l.net_pay::float AS "netPay", l.details
       FROM payroll_archive_lines l LEFT JOIN employees e ON e.id = l.employee_id
       WHERE l.month_id = :id AND (l.employee_id IS NULL OR EXISTS (SELECT 1 FROM employees e WHERE e.id = l.employee_id${scope.sql}))
       ORDER BY l.employee_no`,
      { id: req.params.id, ...scope.params },
    );
    res.json({ data: { month, lines: rows } });
  }

  static async file(req: Request, res: Response): Promise<void> {
    const month = await selectOne<{ storageKey: string; originalName: string }>(
      'SELECT storage_key AS "storageKey", original_name AS "originalName" FROM payroll_archive_months WHERE id = :id AND withdrawn_at IS NULL',
      { id: req.params.id },
    );
    if (!month || !(await storedFileExists(month.storageKey))) throw notFound('الملف غير موجود.');
    await recordAudit(req, null, 'payroll_archive.downloaded', 'payroll_archive_month', req.params.id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', contentDisposition(month.originalName, false));
    res.setHeader('Cache-Control', 'private, no-store');
    openStoredFile(month.storageKey).pipe(res);
  }

  /** One employee's months: the archive up to launch, then the system's own runs. */
  static async employeeHistory(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const archived = await select(
      `SELECT m.period, m.label, l.currency, l.gross::float AS gross, l.total_deductions::float AS "totalDeductions",
              l.net_pay::float AS "netPay", 'archive' AS source, m.id AS "monthId"
       FROM payroll_archive_lines l JOIN payroll_archive_months m ON m.id = l.month_id AND m.withdrawn_at IS NULL
       WHERE l.employee_id = :id ORDER BY m.period`,
      { id: employee.id },
    );
    const system = await select(
      `SELECT r.period, r.currency, l.total_earnings::float AS gross, l.total_deductions::float AS "totalDeductions",
              l.net_pay::float AS "netPay", 'system' AS source, r.id AS "runId", r.status
       FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
       WHERE l.employee_id = :id AND r.status IN ('approved','posted') ORDER BY r.period`,
      { id: employee.id },
    );
    res.json({ data: [...archived, ...system].sort((a, b) => String((a as { period: string }).period).localeCompare(String((b as { period: string }).period))) });
  }

  static async withdraw(req: Request, res: Response): Promise<void> {
    const reason = optionalText(body(req), 'reason', 300) ?? null;
    await transaction(async (tx) => {
      const copy = await snapshot('payroll_archive_months', req.params.id, tx);
      if (!copy || copy.withdrawn_at) throw notFound('الشهر غير موجود في الأرشيف.');
      await execute('UPDATE payroll_archive_months SET withdrawn_at = now(), withdrawn_by = :userId WHERE id = :id', { id: req.params.id, userId: req.user!.id }, tx);
      await moveToBin(req, tx, {
        entityType: 'payroll_archive_month', entityId: req.params.id, module: 'payroll', payload: copy, reason,
        title: `أرشيف رواتب ${String(copy.period)} — ${String(copy.label)}`,
      });
      await recordAudit(req, tx, 'payroll_archive.withdrawn', 'payroll_archive_month', req.params.id, { reason });
    });
    res.json({ data: { ok: true } });
  }
}

export default PayrollArchiveController;
