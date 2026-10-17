import { Request, Response } from 'express';
import { Transaction } from 'sequelize';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { execute, select, selectOne, transaction } from '../db/query';
import { employeeInScope, employeeScopeSql } from '../services/access';
import {
  buildRunLines, linesFingerprint, loadRun, periodBounds, recomputeRunAttendance, replaceRunLines, RunRow, storedLines,
} from '../services/payroll';
import { can, getSettings } from '../services/settings';
import { moveToBin, snapshot } from '../services/recycleBin';
import { notifyEmployees, notifyPermission } from '../services/notify';
import { recordAudit } from '../utils/audit';
import { STEPS, STEP_LABELS, SignStep, addSignoff, liveSignoffs, userSignature, voidSignoffs } from '../services/signatures';
import { decryptField } from '../utils/crypto';
import {
  assertOnlyKeys, badRequest, body, conflict, forbidden, notFound, optionalNumber, optionalText, queryText, requiredText,
} from '../utils/http';
import { isUuid } from '../utils/validation';
import { isXlsx } from '../services/punchParser';
import { uploadedName } from '../services/storage';
import { loadWorkbook } from '../services/xlsx';

async function runOr404(id: string): Promise<RunRow> {
  if (!isUuid(id)) throw notFound('مسير الرواتب غير موجود.');
  const run = await loadRun(id);
  if (!run) throw notFound('مسير الرواتب غير موجود.');
  return run;
}

/** Variable amounts are frozen once an approved run has paid them. */
async function assertInputsOpen(period: string, employeeId: string): Promise<void> {
  const locked = await selectOne(
    `SELECT 1 FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
     WHERE r.period = :period AND l.employee_id = :employeeId AND r.status IN ('approved','posted') LIMIT 1`,
    { period, employeeId },
  );
  if (locked) throw conflict('رواتب هذا الشهر للموظف معتمدة؛ أضف المبلغ إلى الشهر التالي.');
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  // Leading = + - @ would be run as formulas by spreadsheet programs.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One payslip as shown and printed; shared by HR screens and employee self-service. */
export async function payslipData(run: RunRow, employeeId: string): Promise<Record<string, unknown>> {
  const line = await selectOne<Record<string, unknown>>(
    `SELECT l.*, e.employee_no AS "employeeNo", e.full_name AS "employeeName", b.name AS "branchName",
            COALESCE(d.name, e.department) AS "department", COALESCE(j.name, e."position") AS "position",
            p.bank_name AS "bankName", p.bank_account_no AS "bankAccountNo"
     FROM payroll_lines l
     JOIN employees e ON e.id = l.employee_id
     JOIN branches b ON b.id = l.branch_id
     LEFT JOIN departments d ON d.id = l.department_id
     LEFT JOIN job_titles j ON j.id = e.job_title_id
     LEFT JOIN employee_profiles p ON p.employee_id = e.id
     WHERE l.run_id = :runId AND l.employee_id = :employeeId`,
    { runId: run.id, employeeId },
  );
  if (!line) throw notFound('لا توجد قسيمة لهذا الموظف في المسير.');
  const account = decryptField(line.bankAccountNo as string | null);
  const settings = await getSettings();
  return {
    company: settings.company,
    period: run.period,
    status: run.status,
    currency: run.currency,
    employeeNo: line.employeeNo,
    employeeName: line.employeeName,
    branchName: line.branchName,
    department: line.department,
    position: line.position,
    grossSalary: Number(line.gross_salary),
    periodDays: line.period_days,
    employedDays: line.employed_days,
    payableDays: line.payable_days === null ? null : Number(line.payable_days),
    presentDays: line.present_days,
    absentDays: line.absent_days,
    unpaidLeaveDays: line.unpaid_leave_days,
    lateMinutes: line.late_minutes,
    overtimeMinutes: line.overtime_minutes,
    attendanceTracked: line.attendance_tracked,
    earnings: line.earnings,
    deductions: line.deductions,
    totalEarnings: Number(line.total_earnings),
    totalDeductions: Number(line.total_deductions),
    netPay: Number(line.net_pay),
    paymentMethod: line.payment_method,
    bankName: line.bankName,
    bankAccountTail: account ? account.slice(-4) : null,
    warnings: line.warnings,
  };
}

/**
 * Approval: the run is recalculated from current data and must match what
 * was reviewed; anything changed since then sends it back for recalculation.
 * `inside` runs in the same transaction (the executive's sign-off).
 */
async function approveRun(req: Request, run: RunRow, inside?: (tx: Transaction) => Promise<void>): Promise<void> {
  if (run.status !== 'calculated') throw conflict('يجب احتساب المسير قبل اعتماده.');
  if (run.calculatedBy === req.user!.id || run.createdBy === req.user!.id) {
    throw forbidden('يعتمد المسير شخص غير الذي أعدّه أو احتسبه (فصل المهام).');
  }
  await recomputeRunAttendance(run);
  await transaction(async (tx) => {
    const locked = await loadRun(run.id, tx, true);
    if (!locked || locked.status !== 'calculated') throw conflict('تغيرت حالة المسير. حدّث الصفحة.');
    const fresh = await buildRunLines(locked, tx);
    const stored = await storedLines(run.id, tx);
    if (linesFingerprint(fresh) !== linesFingerprint(stored)) {
      throw conflict('تغيرت بيانات الحضور أو الرواتب منذ الاحتساب. أعد احتساب المسير وراجعه قبل الاعتماد.');
    }
    const blocking = fresh.filter((line) => line.warnings.some((warning) => warning.blocking));
    if (blocking.length) {
      throw conflict(`يوجد ${blocking.length} موظف بتنبيهات تمنع الاعتماد (صافي سالب أو أجر يومي بلا حضور).`, {
        employees: blocking.map((line) => line.employeeId),
      });
    }
    await execute(
      `UPDATE payroll_runs SET status = 'approved', approved_by = :userId, approved_at = now(), updated_at = now() WHERE id = :id`,
      { id: run.id, userId: req.user!.id },
      tx,
    );
    await execute(
      `UPDATE attendance_days SET payroll_run_id = :id
       WHERE work_date BETWEEN :start AND :end AND payroll_run_id IS NULL
         AND employee_id IN (SELECT employee_id FROM payroll_lines WHERE run_id = :id)`,
      { id: run.id, start: run.startsOn, end: run.endsOn },
      tx,
    );
    // Advances repaid in full by this run close; direct-deduction advances are archived at once.
    await execute(
      `UPDATE employee_loans l SET status = 'closed', closed_at = now(), updated_at = now(),
         archived_at = CASE WHEN l.kind = 'direct' THEN now() ELSE l.archived_at END
       WHERE l.status = 'active' AND l.id IN (SELECT loan_id FROM loan_repayments WHERE run_id = :id)
         AND l.principal - l.paid_before - COALESCE((SELECT SUM(x.amount) FROM loan_repayments x JOIN payroll_runs r ON r.id = x.run_id
                                                     WHERE x.loan_id = l.id AND r.status IN ('approved','posted')), 0) <= 0.004`,
      { id: run.id },
      tx,
    );
    if (inside) await inside(tx);
    await recordAudit(req, tx, 'payroll.run_approved', 'payroll_run', run.id, { period: run.period });
  });
}

export class PayrollController {
  static async listRuns(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT r.id, r.period, r.status, r.currency, r.branch_id AS "branchId", b.name AS "branchName",
              r.governorate_id AS "governorateId", COALESCE(g.name_ar, bg.name_ar) AS "governorateName",
              r.employee_count AS "employeeCount", r.total_earnings::float AS "totalEarnings",
              r.total_deductions::float AS "totalDeductions", r.total_net::float AS "totalNet", r.warning_count AS "warningCount",
              r.calculated_at AS "calculatedAt", r.approved_at AS "approvedAt", r.posted_at AS "postedAt",
              cu.name AS "createdByName", ca.name AS "calculatedByName", ap.name AS "approvedByName",
              je.status AS "journalStatus", r.paid_at AS "paidAt",
              COALESCE((SELECT array_agg(s.step::text) FROM payroll_run_signoffs s WHERE s.run_id = r.id AND s.voided_at IS NULL), '{}') AS "signedSteps"
       FROM payroll_runs r
       LEFT JOIN branches b ON b.id = r.branch_id
       LEFT JOIN governorates g ON g.id = r.governorate_id
       LEFT JOIN governorates bg ON bg.id = b.governorate_id
       JOIN users cu ON cu.id = r.created_by
       LEFT JOIN users ca ON ca.id = r.calculated_by
       LEFT JOIN users ap ON ap.id = r.approved_by
       LEFT JOIN journal_entries je ON je.source_type = 'payroll' AND je.source_id = r.id AND je.status <> 'cancelled'
       ORDER BY r.period DESC, r.created_at DESC LIMIT 240`,
    );
    res.json({ data: rows });
  }

  static async createRun(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['period', 'branchId', 'governorateId', 'currency', 'notes']);
    const period = requiredText(input, 'period', 7, 'الشهر');
    const { start, end } = periodBounds(period);
    const settings = await getSettings();
    const launch = settings.payrollRules.launchPeriod;
    if (launch && period <= launch) {
      throw badRequest(`شهر ${period} قبل انطلاق النظام (${launch}) ورواتبه في أرشيف المسيرات.`);
    }
    const currency = (optionalText(input, 'currency', 3) || settings.payrollRules.baseCurrency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw badRequest('رمز العملة غير صالح.');
    const branchId = input.branchId ? String(input.branchId) : null;
    const branch = branchId && isUuid(branchId)
      ? await selectOne<{ governorateId: string | null }>('SELECT governorate_id AS "governorateId" FROM branches WHERE id = :id', { id: branchId })
      : null;
    if (branchId && !branch) throw badRequest('الفرع غير موجود.');
    // Each governorate (Baghdad, Mosul, Erbil) has its own payroll file; a branch run belongs to its governorate.
    const governorateId = branchId ? null : (input.governorateId ? String(input.governorateId) : null);
    if (governorateId && (!isUuid(governorateId) || !(await selectOne('SELECT 1 FROM governorates WHERE id = :id', { id: governorateId })))) {
      throw badRequest('المحافظة غير موجودة.');
    }
    // Runs of one month and currency must not cover the same employees.
    const overlapping = await selectOne<{ label: string | null }>(
      `SELECT COALESCE(b.name, g.name_ar) AS label FROM payroll_runs r
       LEFT JOIN branches b ON b.id = r.branch_id LEFT JOIN governorates g ON g.id = r.governorate_id
       WHERE r.period = :period AND r.currency = :currency AND r.status <> 'cancelled'
         AND (
           (r.branch_id IS NULL AND r.governorate_id IS NULL)
           OR (:branchId::uuid IS NULL AND :governorateId::uuid IS NULL)
           OR r.branch_id = :branchId::uuid
           OR r.governorate_id = :governorateId::uuid
           OR (r.governorate_id IS NOT NULL AND r.governorate_id = :branchGovernorate::uuid)
           OR (r.branch_id IS NOT NULL AND b.governorate_id = :governorateId::uuid)
         ) LIMIT 1`,
      { period, currency, branchId, governorateId, branchGovernorate: branch?.governorateId ?? null },
    );
    if (overlapping) {
      throw conflict(`يوجد مسير ${overlapping.label ? `لـ ${overlapping.label}` : 'لكل الفروع'} لهذا الشهر بنفس العملة.`);
    }
    const id = randomUUID();
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO payroll_runs (id, period, starts_on, ends_on, branch_id, governorate_id, currency, notes, created_by)
         VALUES (:id, :period, :start, :end, :branchId, :governorateId, :currency, :notes, :userId)`,
        { id, period, start, end, branchId, governorateId, currency, notes: optionalText(input, 'notes', 1000) ?? null, userId: req.user!.id },
        tx,
      );
      await recordAudit(req, tx, 'payroll.run_created', 'payroll_run', id, { period, branchId, governorateId, currency });
    });
    res.status(201).json({ data: { id } });
  }

  static async getRun(req: Request, res: Response): Promise<void> {
    const run = await runOr404(req.params.id);
    const summary = await selectOne<Record<string, unknown>>(
      `SELECT r.id, r.period, r.status, r.currency, to_char(r.starts_on, 'YYYY-MM-DD') AS "startsOn",
              to_char(r.ends_on, 'YYYY-MM-DD') AS "endsOn", r.branch_id AS "branchId", b.name AS "branchName",
              r.employee_count AS "employeeCount", r.total_earnings::float AS "totalEarnings",
              r.total_deductions::float AS "totalDeductions", r.total_net::float AS "totalNet", r.warning_count AS "warningCount",
              r.notes, r.cancelled_reason AS "cancelledReason", r.created_by AS "createdBy", r.calculated_by AS "calculatedBy",
              r.calculated_at AS "calculatedAt", r.approved_at AS "approvedAt", r.posted_at AS "postedAt",
              cu.name AS "createdByName", ca.name AS "calculatedByName", ap.name AS "approvedByName",
              je.id AS "journalId", je.status AS "journalStatus",
              r.governorate_id AS "governorateId", COALESCE(g.name_ar, bg.name_ar) AS "governorateName"
       FROM payroll_runs r
       LEFT JOIN branches b ON b.id = r.branch_id
       LEFT JOIN governorates g ON g.id = r.governorate_id
       LEFT JOIN governorates bg ON bg.id = b.governorate_id
       JOIN users cu ON cu.id = r.created_by
       LEFT JOIN users ca ON ca.id = r.calculated_by
       LEFT JOIN users ap ON ap.id = r.approved_by
       LEFT JOIN journal_entries je ON je.source_type = 'payroll' AND je.source_id = r.id AND je.status <> 'cancelled'
       WHERE r.id = :id`,
      { id: run.id },
    );
    const lines = await select(
      `SELECT l.employee_id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "employeeName",
              b.name AS "branchName", COALESCE(d.name, e.department) AS "department", l.department_id AS "departmentId",
              l.branch_id AS "branchId", gv.name_ar AS "governorateName",
              l.gross_salary::float AS "grossSalary", l.employed_days AS "employedDays", l.present_days AS "presentDays",
              l.payable_days::float AS "payableDays",
              l.absent_days AS "absentDays", l.unpaid_leave_days AS "unpaidLeaveDays", l.late_minutes AS "lateMinutes",
              l.overtime_minutes AS "overtimeMinutes", l.attendance_tracked AS "attendanceTracked",
              l.earnings, l.deductions, l.total_earnings::float AS "totalEarnings",
              l.total_deductions::float AS "totalDeductions", l.net_pay::float AS "netPay",
              l.payment_method AS "paymentMethod", l.warnings
       FROM payroll_lines l
       JOIN employees e ON e.id = l.employee_id
       JOIN branches b ON b.id = l.branch_id
       LEFT JOIN governorates gv ON gv.id = b.governorate_id
       LEFT JOIN departments d ON d.id = l.department_id
       WHERE l.run_id = :id ORDER BY e.employee_no`,
      { id: run.id },
    );
    const settings = await getSettings();
    const paid = await selectOne<{ paidAt: string | null; paidByName: string | null }>(
      `SELECT r.paid_at AS "paidAt", u.name AS "paidByName" FROM payroll_runs r LEFT JOIN users u ON u.id = r.paid_by WHERE r.id = :id`,
      { id: run.id },
    );
    res.json({ data: { ...summary, ...paid, approvalChain: Boolean(settings.payrollRules.approvalChain), signoffs: await liveSignoffs(run.id), lines } });
  }

  static async calculate(req: Request, res: Response): Promise<void> {
    const run = await runOr404(req.params.id);
    if (!['draft', 'calculated'].includes(run.status)) throw conflict('لا يمكن إعادة احتساب مسير معتمد أو ملغى.');
    await recomputeRunAttendance(run);
    await transaction(async (tx) => {
      const locked = await loadRun(run.id, tx, true);
      if (!locked || !['draft', 'calculated'].includes(locked.status)) throw conflict('تغيرت حالة المسير. حدّث الصفحة.');
      const lines = await buildRunLines(locked, tx);
      await replaceRunLines(locked, lines, req.user!.id, tx);
      await voidSignoffs(run.id, 'أُعيد احتساب المسير', tx);
      await recordAudit(req, tx, 'payroll.run_calculated', 'payroll_run', run.id, {
        employees: lines.length, totalNet: lines.reduce((sum, line) => sum + line.netPay, 0),
      });
    });
    res.json({ data: { id: run.id } });
  }

  /**
   * Approval by a second person. The run is recalculated from current data
   * and must match what the preparer reviewed; anything changed since then
   * (a punch, a salary, a variable amount) sends it back for recalculation.
   */
  static async approve(req: Request, res: Response): Promise<void> {
    const run = await runOr404(req.params.id);
    if ((await getSettings()).payrollRules.approvalChain) {
      throw conflict('الاعتماد يمر بسلسلة التواقيع: الموارد البشرية ← التدقيق ← المدير التنفيذي ← المالية.');
    }
    await approveRun(req, run);
    res.json({ data: { id: run.id } });
  }

  /**
   * One step of the approval chain, signed with the person's saved e-signature:
   * HR → audit → chief executive (approves the run) → finance (records payment).
   * Steps go in order and one person signs one step only.
   */
  static async sign(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['step', 'note']);
    const step = input.step as SignStep;
    if (!STEPS.includes(step)) throw badRequest('خطوة الاعتماد غير صالحة.');
    const note = optionalText(input, 'note', 500) ?? null;
    const run = await runOr404(req.params.id);
    const settings = await getSettings();
    if (!settings.payrollRules.approvalChain) throw conflict('سلسلة الاعتماد غير مفعّلة في إعدادات الرواتب.');
    const permission = { hr: 'payroll.prepare', audit: 'payroll.audit', ceo: 'payroll.approve', finance: 'payroll.disburse' }[step];
    if (!(await can(req, permission as Parameters<typeof can>[1]))) throw forbidden(`لا تملك صلاحية توقيع خطوة «${STEP_LABELS[step]}».`);
    const signature = await userSignature(req.user!.id);
    if (!signature) throw badRequest('ارسم توقيعك الإلكتروني أولاً من «أمان الحساب ← توقيعي».');
    const ip = (req.ip || '').slice(0, 64) || null;
    const signed = await liveSignoffs(run.id);
    if (signed.some((item) => item.step === step)) throw conflict(`خطوة «${STEP_LABELS[step]}» موقّعة مسبقاً.`);
    if (signed.some((item) => item.userId === req.user!.id)) throw forbidden('وقّعت خطوة أخرى من هذا المسير؛ كل خطوة يوقّعها شخص مختلف.');
    const previous = STEPS[STEPS.indexOf(step) - 1];
    if (previous && !signed.some((item) => item.step === previous)) throw conflict(`بانتظار توقيع «${STEP_LABELS[previous]}» أولاً.`);

    if (step === 'ceo') {
      await approveRun(req, run, async (tx) => {
        await addSignoff(run.id, step, req.user!.id, signature, note, ip, tx);
      });
    } else if (step === 'finance') {
      if (!['approved', 'posted'].includes(run.status)) throw conflict('يُصرف المسير بعد اعتماده من المدير التنفيذي.');
      await transaction(async (tx) => {
        await addSignoff(run.id, step, req.user!.id, signature, note, ip, tx);
        await execute('UPDATE payroll_runs SET paid_at = now(), paid_by = :userId, updated_at = now() WHERE id = :id', { id: run.id, userId: req.user!.id }, tx);
        await recordAudit(req, tx, 'payroll.run_paid', 'payroll_run', run.id, { period: run.period });
      });
    } else {
      if (run.status !== 'calculated') throw conflict('يُوقّع المسير بعد احتسابه وقبل اعتماده.');
      await transaction(async (tx) => {
        const locked = await loadRun(run.id, tx, true);
        if (!locked || locked.status !== 'calculated') throw conflict('تغيرت حالة المسير. حدّث الصفحة.');
        await addSignoff(run.id, step, req.user!.id, signature, note, ip, tx);
        await recordAudit(req, tx, `payroll.run_signed_${step}`, 'payroll_run', run.id, { period: run.period, note });
      });
    }
    // Tell whoever signs next, and the employees once the month is paid.
    const next = STEPS[STEPS.indexOf(step) + 1];
    const nextPermission = next ? ({ hr: 'payroll.prepare', audit: 'payroll.audit', ceo: 'payroll.approve', finance: 'payroll.disburse' } as const)[next] : null;
    if (nextPermission) {
      await notifyPermission(nextPermission, {
        kind: 'approval', title: `مسير ${run.period} بانتظار توقيع «${STEP_LABELS[next]}»`,
        body: `وقّع ${req.user!.name} خطوة «${STEP_LABELS[step]}».`, link: `/payroll/${run.id}`,
      }, null, req.user!.id).catch(() => 0);
    }
    if (step === 'finance') {
      const staff = await select<{ employeeId: string }>('SELECT employee_id AS "employeeId" FROM payroll_lines WHERE run_id = :id', { id: run.id });
      await notifyEmployees(staff.map((line) => line.employeeId), {
        kind: 'payslip', title: `صُرف راتب شهر ${run.period}`, body: 'قسيمة الراتب متاحة في بوابتك.', link: '/my',
      }).catch(() => 0);
    }
    res.json({ data: { id: run.id, signoffs: await liveSignoffs(run.id) } });
  }

  /** Sends a run back before approval; the sign-offs so far stop counting. */
  static async returnRun(req: Request, res: Response): Promise<void> {
    const run = await runOr404(req.params.id);
    if (run.status !== 'calculated') throw conflict('يُعاد المسير قبل اعتماده فقط؛ بعد الاعتماد استخدم «إعادة فتح».');
    const reason = requiredText(body(req), 'reason', 500, 'سبب الإرجاع');
    await transaction(async (tx) => {
      const count = await voidSignoffs(run.id, `أُرجع: ${reason}`, tx);
      await recordAudit(req, tx, 'payroll.run_returned', 'payroll_run', run.id, { reason, voided: count });
    });
    res.json({ data: { id: run.id } });
  }

  static async reopen(req: Request, res: Response): Promise<void> {
    const run = await runOr404(req.params.id);
    if (run.status === 'posted') throw conflict('المسير مرحّل إلى المالية. ألغِ القيد أولاً أو عالج الفروقات في الشهر التالي.');
    if (run.status !== 'approved') throw conflict('يُعاد فتح المسيرات المعتمدة فقط.');
    const reason = requiredText(body(req), 'reason', 500, 'سبب إعادة الفتح');
    await transaction(async (tx) => {
      const pending = await selectOne(
        `SELECT 1 FROM journal_entries WHERE source_type = 'payroll' AND source_id = :id AND status IN ('queued','posting','posted')`,
        { id: run.id }, tx,
      );
      if (pending) throw conflict('قيد هذا المسير في طابور الترحيل أو مرحّل. ألغِ القيد أولاً.');
      await execute(`UPDATE journal_entries SET status = 'cancelled', updated_at = now()
                     WHERE source_type = 'payroll' AND source_id = :id AND status IN ('draft','failed')`, { id: run.id }, tx);
      await execute(`UPDATE payroll_runs SET status = 'calculated', approved_by = NULL, approved_at = NULL,
                       paid_at = NULL, paid_by = NULL, updated_at = now() WHERE id = :id`,
        { id: run.id }, tx);
      await voidSignoffs(run.id, `أُعيد فتح المسير: ${reason}`, tx);
      await execute('UPDATE attendance_days SET payroll_run_id = NULL WHERE payroll_run_id = :id', { id: run.id }, tx);
      // Advances this run had closed are open again until it is approved once more.
      await execute(
        `UPDATE employee_loans SET status = 'active', closed_at = NULL, archived_at = NULL, updated_at = now()
         WHERE status = 'closed' AND closed_at IS NOT NULL AND id IN (SELECT loan_id FROM loan_repayments WHERE run_id = :id)`,
        { id: run.id }, tx,
      );
      await recordAudit(req, tx, 'payroll.run_reopened', 'payroll_run', run.id, { reason });
    });
    res.json({ data: { id: run.id } });
  }

  static async cancel(req: Request, res: Response): Promise<void> {
    const run = await runOr404(req.params.id);
    if (!['draft', 'calculated'].includes(run.status)) throw conflict('لا يُلغى إلا مسير غير معتمد.');
    const reason = requiredText(body(req), 'reason', 500, 'سبب الإلغاء');
    await transaction(async (tx) => {
      await execute(`UPDATE payroll_runs SET status = 'cancelled', cancelled_reason = :reason, updated_at = now() WHERE id = :id`,
        { id: run.id, reason }, tx);
      await recordAudit(req, tx, 'payroll.run_cancelled', 'payroll_run', run.id, { reason });
    });
    res.json({ data: { id: run.id } });
  }

  static async payslip(req: Request, res: Response): Promise<void> {
    const run = await runOr404(req.params.id);
    const employee = await employeeInScope(req, req.params.employeeId);
    res.json({ data: await payslipData(run, employee.id) });
  }

  /** Full payroll register as an Excel workbook. */
  static async exportRegister(req: Request, res: Response): Promise<void> {
    const run = await runOr404(req.params.id);
    if (run.status === 'draft' || run.status === 'cancelled') throw conflict('احسب المسير أولاً.');
    const settings = await getSettings();
    const lines = await select<{
      employeeNo: string; employeeName: string; branchName: string; department: string; costCenterCode: string | null;
      grossSalary: number; employedDays: number; absentDays: number; unpaidLeaveDays: number; lateMinutes: number;
      overtimeMinutes: number; earnings: Array<{ componentId: string; amount: number }>;
      deductions: Array<{ componentId: string; amount: number }>; totalEarnings: number; totalDeductions: number; netPay: number;
    }>(
      `SELECT e.employee_no AS "employeeNo", e.full_name AS "employeeName", b.name AS "branchName",
              COALESCE(d.name, e.department) AS department, l.cost_center_code AS "costCenterCode",
              l.gross_salary::float AS "grossSalary", l.employed_days AS "employedDays", l.payable_days::float AS "payableDays",
              l.absent_days AS "absentDays",
              l.unpaid_leave_days AS "unpaidLeaveDays", l.late_minutes AS "lateMinutes", l.overtime_minutes AS "overtimeMinutes",
              l.earnings, l.deductions, l.total_earnings::float AS "totalEarnings",
              l.total_deductions::float AS "totalDeductions", l.net_pay::float AS "netPay"
       FROM payroll_lines l JOIN employees e ON e.id = l.employee_id JOIN branches b ON b.id = l.branch_id
       LEFT JOIN departments d ON d.id = l.department_id
       WHERE l.run_id = :id ORDER BY b.name, e.employee_no`,
      { id: run.id },
    );
    const components = settings.payrollRules.components.filter((component) =>
      lines.some((line) => [...line.earnings, ...line.deductions].some((item) => item.componentId === component.id)));
    const earningComponents = components.filter((component) => component.category === 'earning');
    const deductionComponents = components.filter((component) => component.category === 'deduction');

    const workbook = new ExcelJS.Workbook();
    workbook.creator = settings.company.displayName;
    const sheet = workbook.addWorksheet(`رواتب ${run.period}`, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'رقم الموظف', key: 'employeeNo', width: 12 },
      { header: 'الاسم', key: 'employeeName', width: 28 },
      { header: 'الفرع', key: 'branchName', width: 16 },
      { header: 'القسم', key: 'department', width: 18 },
      { header: 'مركز الكلفة', key: 'costCenterCode', width: 12 },
      { header: 'الراتب الإجمالي', key: 'grossSalary', width: 14 },
      { header: 'أيام الخدمة', key: 'employedDays', width: 10 },
      { header: 'أيام الاستحقاق', key: 'payableDays', width: 10 },
      { header: 'غياب', key: 'absentDays', width: 8 },
      { header: 'إجازة بدون راتب', key: 'unpaidLeaveDays', width: 10 },
      { header: 'دقائق تأخير', key: 'lateMinutes', width: 10 },
      { header: 'دقائق إضافي', key: 'overtimeMinutes', width: 10 },
      ...earningComponents.map((component) => ({ header: component.name, key: `e_${component.id}`, width: 14 })),
      { header: 'مجموع الاستحقاقات', key: 'totalEarnings', width: 16 },
      ...deductionComponents.map((component) => ({ header: component.name, key: `d_${component.id}`, width: 14 })),
      { header: 'مجموع الاستقطاعات', key: 'totalDeductions', width: 16 },
      { header: 'الصافي', key: 'netPay', width: 16 },
    ];
    for (const line of lines) {
      const row: Record<string, unknown> = { ...line };
      for (const item of line.earnings) row[`e_${item.componentId}`] = item.amount;
      for (const item of line.deductions) row[`d_${item.componentId}`] = item.amount;
      sheet.addRow(row);
    }
    const totalRow = sheet.addRow({ employeeName: 'المجموع' });
    sheet.columns.forEach((column, index) => {
      if (index >= 5 && column.key && !['employedDays', 'payableDays', 'absentDays', 'unpaidLeaveDays', 'lateMinutes', 'overtimeMinutes'].includes(column.key)) {
        const letter = sheet.getColumn(index + 1).letter;
        totalRow.getCell(index + 1).value = { formula: `SUM(${letter}2:${letter}${lines.length + 1})` };
      }
      if (index >= 5) column.numFmt = '#,##0.##';
    });
    totalRow.font = { bold: true };
    sheet.getRow(1).font = { bold: true };
    await recordAudit(req, null, 'payroll.register_exported', 'payroll_run', run.id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="payroll-${run.period}-${run.currency}.xlsx"`);
    res.setHeader('Cache-Control', 'private, no-store');
    await workbook.xlsx.write(res);
    res.end();
  }

  /** Bank transfer list for an approved run; account numbers are decrypted here only. */
  static async bankFile(req: Request, res: Response): Promise<void> {
    const run = await runOr404(req.params.id);
    if (!['approved', 'posted'].includes(run.status)) throw conflict('ملف التحويل المصرفي متاح بعد الاعتماد فقط.');
    if (!(await can(req, 'compensation.view'))) throw forbidden();
    const rows = await select<{ employeeNo: string; employeeName: string; bankName: string | null; account: string | null; netPay: number; method: string }>(
      `SELECT e.employee_no AS "employeeNo", e.full_name AS "employeeName", p.bank_name AS "bankName",
              p.bank_account_no AS account, l.net_pay::float AS "netPay", l.payment_method AS method
       FROM payroll_lines l JOIN employees e ON e.id = l.employee_id LEFT JOIN employee_profiles p ON p.employee_id = e.id
       WHERE l.run_id = :id AND l.net_pay > 0 ORDER BY p.bank_name NULLS LAST, e.employee_no`,
      { id: run.id },
    );
    const lines = ['employee_no,name,payment_method,bank,account_no,amount,currency'];
    for (const row of rows) {
      lines.push([row.employeeNo, row.employeeName, row.method, row.bankName, decryptField(row.account), row.netPay.toFixed(2), run.currency]
        .map(csvCell).join(','));
    }
    await recordAudit(req, null, 'payroll.bank_file_exported', 'payroll_run', run.id, { rows: rows.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bank-${run.period}-${run.currency}.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  }

  static async employeeHistory(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const rows = await select(
      `SELECT r.id AS "runId", r.period, r.status, r.currency, l.total_earnings::float AS "totalEarnings",
              l.total_deductions::float AS "totalDeductions", l.net_pay::float AS "netPay"
       FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
       WHERE l.employee_id = :id AND r.status <> 'cancelled' ORDER BY r.period DESC LIMIT 36`,
      { id: employee.id },
    );
    res.json({ data: rows });
  }

  // --- Variable inputs ----------------------------------------------------

  static async listInputs(req: Request, res: Response): Promise<void> {
    const period = queryText(req, 'period');
    periodBounds(period);
    const scope = employeeScopeSql(req);
    const rows = await select(
      `SELECT i.id, i.period, i.employee_id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "employeeName",
              i.component_id AS "componentId", i.amount::float AS amount, i.note, i.created_at AS "createdAt", u.name AS "createdByName"
       FROM payroll_inputs i JOIN employees e ON e.id = i.employee_id JOIN users u ON u.id = i.created_by
       WHERE i.period = :period${scope.sql}
       ORDER BY e.employee_no, i.created_at`,
      { period, ...scope.params },
    );
    res.json({ data: rows });
  }

  static async addInput(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['period', 'employeeId', 'componentId', 'amount', 'note']);
    const period = requiredText(input, 'period', 7, 'الشهر');
    periodBounds(period);
    const employee = await employeeInScope(req, input.employeeId);
    const settings = await getSettings();
    const component = settings.payrollRules.components.find((item) => item.id === input.componentId);
    if (!component || component.calculation !== 'manual') throw badRequest('اختر مكوناً يُدخل يدوياً (عمولة، مكافأة، سلفة…).');
    const amount = optionalNumber(input, 'amount', { min: 0.01, max: 1e12 });
    if (!amount) throw badRequest('أدخل مبلغاً موجباً.');
    await assertInputsOpen(period, employee.id);
    const id = randomUUID();
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO payroll_inputs (id, period, employee_id, component_id, amount, note, created_by)
         VALUES (:id, :period, :employeeId, :componentId, :amount, :note, :userId)`,
        { id, period, employeeId: employee.id, componentId: component.id, amount, note: optionalText(input, 'note', 500) ?? null, userId: req.user!.id },
        tx,
      );
      await recordAudit(req, tx, 'payroll.input_added', 'employee', employee.id, { inputId: id, period, component: component.name, amount });
    });
    res.status(201).json({ data: { id } });
  }

  static async deleteInput(req: Request, res: Response): Promise<void> {
    const row = await selectOne<{ id: string; period: string; employeeId: string; amount: number }>(
      'SELECT id, period, employee_id AS "employeeId", amount::float AS amount FROM payroll_inputs WHERE id = :id',
      { id: req.params.id },
    );
    if (!row) throw notFound('المبلغ غير موجود.');
    await employeeInScope(req, row.employeeId);
    await assertInputsOpen(row.period, row.employeeId);
    await transaction(async (tx) => {
      const copy = await snapshot('payroll_inputs', row.id, tx);
      const name = await selectOne<{ name: string }>('SELECT full_name AS name FROM employees WHERE id = :id', { id: row.employeeId }, tx);
      await moveToBin(req, tx, {
        entityType: 'payroll_input', entityId: row.id, module: 'payroll', payload: copy ?? {},
        title: `مبلغ ${row.amount} لـ ${name?.name ?? ''} — ${row.period}`,
      });
      await execute('DELETE FROM payroll_inputs WHERE id = :id', { id: row.id }, tx);
      await recordAudit(req, tx, 'payroll.input_removed', 'employee', row.employeeId, { inputId: row.id, period: row.period, amount: row.amount });
    });
    res.json({ data: { id: row.id } });
  }

  // --- Payable / absence days set by HR -----------------------------------

  static async listAdjustments(req: Request, res: Response): Promise<void> {
    const period = queryText(req, 'period');
    periodBounds(period);
    const scope = employeeScopeSql(req);
    const rows = await select(
      `SELECT a.employee_id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "employeeName",
              a.payable_days::float AS "payableDays", a.absence_days::float AS "absenceDays", a.note,
              a.updated_at AS "updatedAt", u.name AS "updatedByName"
       FROM payroll_day_adjustments a JOIN employees e ON e.id = a.employee_id JOIN users u ON u.id = a.updated_by
       WHERE a.period = :period${scope.sql}
       ORDER BY e.employee_no`,
      { period, ...scope.params },
    );
    res.json({ data: rows });
  }

  static async setAdjustment(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['period', 'employeeId', 'payableDays', 'absenceDays', 'note']);
    const period = requiredText(input, 'period', 7, 'الشهر');
    periodBounds(period);
    const employee = await employeeInScope(req, input.employeeId);
    const payableDays = input.payableDays === null || input.payableDays === '' || input.payableDays === undefined
      ? null : optionalNumber(input, 'payableDays', { min: 0, max: 31 });
    const absenceDays = optionalNumber(input, 'absenceDays', { min: 0, max: 31 }) ?? 0;
    await assertInputsOpen(period, employee.id);
    await transaction(async (tx) => {
      if (payableDays === null && !absenceDays) {
        await execute('DELETE FROM payroll_day_adjustments WHERE period = :period AND employee_id = :employeeId',
          { period, employeeId: employee.id }, tx);
      } else {
        await execute(
          `INSERT INTO payroll_day_adjustments (period, employee_id, payable_days, absence_days, note, updated_by)
           VALUES (:period, :employeeId, :payableDays, :absenceDays, :note, :userId)
           ON CONFLICT (period, employee_id) DO UPDATE SET payable_days = EXCLUDED.payable_days,
             absence_days = EXCLUDED.absence_days, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          { period, employeeId: employee.id, payableDays, absenceDays, note: optionalText(input, 'note', 500) ?? null, userId: req.user!.id },
          tx,
        );
      }
      await recordAudit(req, tx, 'payroll.days_adjusted', 'employee', employee.id, { period, payableDays, absenceDays });
    });
    res.json({ data: { employeeId: employee.id } });
  }

  /** Imports variable amounts from Excel: employee number, component name, amount, note. */
  static async importInputs(req: Request, res: Response): Promise<void> {
    const file = req.file;
    if (!file || !isXlsx(file.buffer)) throw badRequest('ارفع ملف Excel بالأعمدة: رقم الموظف، المكون، المبلغ، ملاحظة.');
    const period = requiredText(body(req), 'period', 7, 'الشهر');
    periodBounds(period);
    const settings = await getSettings();
    const manual = settings.payrollRules.components.filter((item) => item.calculation === 'manual');
    const workbook = await loadWorkbook(file.buffer);
    const sheet = workbook.worksheets[0];
    const errors: Array<{ row: number; message: string }> = [];
    const rows: Array<{ employeeId: string; componentId: string; amount: number; note: string | null; row: number }> = [];
    const scope = employeeScopeSql(req);
    const employees = new Map((await select<{ id: string; employeeNo: string }>(
      `SELECT e.id, e.employee_no AS "employeeNo" FROM employees e WHERE true${scope.sql}`, scope.params,
    )).map((item) => [item.employeeNo, item.id]));
    sheet?.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const values = (row.values as ExcelJS.CellValue[]).slice(1).map((value) =>
        (value && typeof value === 'object' && 'result' in value ? value.result : value));
      const employeeId = employees.get(String(values[0] ?? '').trim());
      const component = manual.find((item) => item.name === String(values[1] ?? '').trim());
      const amount = Number(values[2]);
      if (!employeeId) errors.push({ row: rowNumber, message: 'رقم الموظف غير موجود' });
      else if (!component) errors.push({ row: rowNumber, message: 'اسم المكون غير معروف أو ليس يدوياً' });
      else if (!Number.isFinite(amount) || amount <= 0) errors.push({ row: rowNumber, message: 'المبلغ غير صالح' });
      else rows.push({ employeeId, componentId: component.id, amount, note: values[3] ? String(values[3]).slice(0, 500) : null, row: rowNumber });
    });
    if (errors.length) throw badRequest('صحح الأخطاء في الملف ثم أعد رفعه. لم يُحفظ أي سطر.', { errors: errors.slice(0, 100) });
    if (!rows.length) throw badRequest('الملف لا يحتوي على مبالغ.');
    for (const row of rows) await assertInputsOpen(period, row.employeeId);
    await transaction(async (tx) => {
      for (const row of rows) {
        await execute(
          `INSERT INTO payroll_inputs (id, period, employee_id, component_id, amount, note, created_by)
           VALUES (:id, :period, :employeeId, :componentId, :amount, :note, :userId)`,
          { id: randomUUID(), period, ...row, userId: req.user!.id },
          tx,
        );
      }
      await recordAudit(req, tx, 'payroll.inputs_imported', 'payroll_inputs', null, { period, rows: rows.length, file: uploadedName(file, 'inputs.xlsx') });
    });
    res.status(201).json({ data: { imported: rows.length } });
  }
}

export default PayrollController;
