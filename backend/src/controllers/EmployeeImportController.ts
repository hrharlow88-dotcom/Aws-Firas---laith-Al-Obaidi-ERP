import { Request, Response } from 'express';
import { transaction } from '../db/query';
import { accessScope } from '../services/access';
import { localToday } from '../services/attendance';
import {
  applyEmployeePlan, defaultShift, EmployeeSheetError, employeeTemplate, ImportAccess, planEmployeeImport,
} from '../services/employeeImport';
import { getSettings, userPermissions } from '../services/settings';
import { SheetFormatError } from '../services/sheetRead';
import { uploadedName } from '../services/storage';
import { recordAudit } from '../utils/audit';
import { badRequest, forbidden } from '../utils/http';

async function importAccess(req: Request): Promise<ImportAccess> {
  const scope = accessScope(req);
  if (scope.kind !== 'all' && scope.kind !== 'branch') throw forbidden('استيراد بيانات الموظفين لمن يدير الموظفين على مستوى الشركة أو الفرع.');
  const [granted, settings] = await Promise.all([userPermissions(req), getSettings()]);
  return {
    canCreate: granted.includes('employees.create'),
    canUpdate: granted.includes('employees.update'),
    canSeeSalary: granted.includes('compensation.view'),
    canChangeSalary: granted.includes('compensation.manage'),
    branchId: scope.kind === 'branch' ? scope.branchId : null,
    monthStart: `${localToday(settings.company.timeZone).slice(0, 7)}-01`,
    baseCurrency: settings.payrollRules.baseCurrency,
    requiredCustomFields: settings.employeeFields.filter((field) => field.enabled && field.required).map((field) => field.label || field.key),
  };
}

async function readPlan(req: Request, tx?: import('sequelize').Transaction) {
  const file = req.file;
  if (!file) throw badRequest('اختر ملف Excel أو CSV.');
  try {
    return await planEmployeeImport(file.buffer, await importAccess(req), tx);
  } catch (error) {
    if (error instanceof EmployeeSheetError || error instanceof SheetFormatError) throw badRequest(error.message);
    throw error;
  }
}

/**
 * The employees' master sheet: download with today's data, upload, preview
 * every change, apply in one transaction (refused while any row has an error).
 */
export class EmployeeImportController {
  static async template(req: Request, res: Response): Promise<void> {
    const access = await importAccess(req);
    const workbook = await employeeTemplate(access);
    await recordAudit(req, null, 'employees.template_exported', 'employee', null, { withSalaries: access.canSeeSalary });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="employees.xlsx"');
    res.setHeader('Cache-Control', 'private, no-store');
    await workbook.xlsx.write(res);
    res.end();
  }

  static async preview(req: Request, res: Response): Promise<void> {
    const plan = await readPlan(req);
    res.json({ data: { columns: plan.columns, rows: plan.rows, newJobTitles: plan.newJobTitles, summary: plan.summary } });
  }

  static async apply(req: Request, res: Response): Promise<void> {
    const result = await transaction(async (tx) => {
      // Re-read inside the transaction so the plan reflects what is in the database now.
      const plan = await readPlan(req, tx);
      if (plan.summary.errors) throw badRequest(`في الملف ${plan.summary.errors} سطر بأخطاء. صححها ثم أعد المعاينة.`);
      if (!plan.creates.length && !plan.updates.size && !plan.managers.size && !plan.salaries.length) {
        throw badRequest('لا توجد تغييرات لاعتمادها.');
      }
      const applied = await applyEmployeePlan(plan, req.user!.id, await defaultShift(tx), tx);
      for (const row of plan.rows.filter((item) => item.changes.length && item.action !== 'error')) {
        const id = row.employeeId ?? plan.creates.find((item) => item.employeeNo === row.employeeNo)?.id ?? null;
        await recordAudit(req, tx, row.action === 'create' ? 'employee.created' : 'employee.updated', 'employee', id, {
          source: 'excel', changes: row.changes.map((change) => ({ field: change.field, from: change.from, to: change.to })),
        });
      }
      await recordAudit(req, tx, 'employees.imported', 'employee', null, {
        file: uploadedName(req.file!, 'employees.xlsx'), created: applied.created, updated: applied.updated,
        salaries: applied.salaries, newJobTitles: plan.newJobTitles,
      });
      return applied;
    });
    res.json({ data: { created: result.created, updated: result.updated, salaries: result.salaries } });
  }
}
