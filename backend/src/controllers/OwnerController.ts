import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { Transaction } from 'sequelize';
import { SystemSetting } from '../models';
import { normalizeSystemSettings, SystemSettings } from '../config/systemSettings';
import { execute, select, selectOne, transaction } from '../db/query';
import { getSettings, invalidateSettingsCache, SETTINGS_ID } from '../services/settings';
import { openStoredFile, sniffFile, storeFile, storedFileExists } from '../services/storage';
import { recordAudit } from '../utils/audit';
import { badRequest, notFound } from '../utils/http';

async function saveSettings(next: SystemSettings, userId: string, tx: Transaction): Promise<void> {
  await SystemSetting.upsert({ id: SETTINGS_ID, value: next, updatedBy: userId }, { transaction: tx });
}

const TEMPLATE_FORMAT = 'lo-erp.company-template';

/**
 * Owner (super_admin) controls: brand logos shown under the system name, and
 * the company template used to start the system for another company.
 */
export class OwnerController {
  /** Login page branding: no sign-in needed, nothing private. */
  static async publicBranding(_req: Request, res: Response): Promise<void> {
    const settings = await getSettings();
    res.set('Cache-Control', 'no-cache');
    res.json({
      data: {
        company: settings.company.displayName,
        brands: settings.ui.brands.map((brand) => ({
          id: brand.id, name: brand.name,
          logo: brand.logoKey ? `/api/public/brands/${brand.id}/logo?v=${encodeURIComponent(brand.logoKey.slice(7, 15))}` : null,
        })),
      },
    });
  }

  static async brandLogo(req: Request, res: Response): Promise<void> {
    const settings = await getSettings();
    const brand = settings.ui.brands.find((item) => item.id === req.params.brandId);
    if (!brand?.logoKey || !(await storedFileExists(brand.logoKey))) throw notFound('لا يوجد شعار لهذه العلامة.');
    const ext = brand.logoKey.split('.').pop();
    res.type(ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    openStoredFile(brand.logoKey).pipe(res);
  }

  static async uploadBrandLogo(req: Request, res: Response): Promise<void> {
    if (!req.file) throw badRequest('اختر صورة الشعار.');
    const kind = sniffFile(req.file.buffer, ['image/png', 'image/jpeg', 'image/webp']);
    const key = await storeFile('brands', req.file.buffer, kind.ext);
    await transaction(async (tx) => {
      const settings = normalizeSystemSettings((await SystemSetting.findByPk(SETTINGS_ID, { transaction: tx }))?.value);
      const index = settings.ui.brands.findIndex((brand) => brand.id === req.params.brandId);
      if (index < 0) throw notFound('العلامة غير موجودة.');
      settings.ui.brands[index] = { ...settings.ui.brands[index], logoKey: key };
      await saveSettings(settings, req.user!.id, tx);
      await recordAudit(req, tx, 'owner.brand_logo_uploaded', 'system_settings', SETTINGS_ID, { brand: req.params.brandId });
    });
    invalidateSettingsCache();
    res.json({ data: { ok: true } });
  }

  static async removeBrandLogo(req: Request, res: Response): Promise<void> {
    await transaction(async (tx) => {
      const settings = normalizeSystemSettings((await SystemSetting.findByPk(SETTINGS_ID, { transaction: tx }))?.value);
      const index = settings.ui.brands.findIndex((brand) => brand.id === req.params.brandId);
      if (index < 0) throw notFound('العلامة غير موجودة.');
      settings.ui.brands[index] = { ...settings.ui.brands[index], logoKey: null };
      await saveSettings(settings, req.user!.id, tx);
      await recordAudit(req, tx, 'owner.brand_logo_removed', 'system_settings', SETTINGS_ID, { brand: req.params.brandId });
    });
    invalidateSettingsCache();
    res.json({ data: { ok: true } });
  }

  /**
   * Everything needed to start the same system for another company: settings
   * (rules, roles, components, leave types), branches, departments, job titles
   * and shifts. No people, salaries, files or secrets.
   */
  static async exportTemplate(req: Request, res: Response): Promise<void> {
    const settings = await getSettings();
    const [branches, departments, jobTitles, shifts] = await Promise.all([
      select('SELECT code, name, city, address, phone FROM branches WHERE is_active ORDER BY code'),
      select(`SELECT d.code, d.name, p.code AS "parentCode", d.cost_center_code AS "costCenter", d.sort_order AS "sortOrder"
              FROM departments d LEFT JOIN departments p ON p.id = d.parent_id WHERE d.is_active ORDER BY d.sort_order, d.code`),
      select(`SELECT j.code, j.name, d.code AS "departmentCode", j.grade, j.description
              FROM job_titles j LEFT JOIN departments d ON d.id = j.department_id WHERE j.is_active ORDER BY j.code`),
      select(`SELECT code, name, to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime",
                     break_minutes AS "breakMinutes", grace_minutes AS "graceMinutes",
                     early_leave_grace_minutes AS "earlyLeaveGraceMinutes", working_days AS "workingDays", is_default AS "isDefault"
              FROM shifts WHERE is_active ORDER BY code`),
    ]);
    const template = {
      format: TEMPLATE_FORMAT, version: 1, exportedAt: new Date().toISOString(),
      settings: { ...settings, ui: { ...settings.ui, brands: settings.ui.brands.map((brand) => ({ ...brand, logoKey: null })) } },
      branches, departments, jobTitles, shifts,
    };
    await recordAudit(req, null, 'owner.template_exported', 'system_settings', SETTINGS_ID);
    res.set('Content-Disposition', `attachment; filename="company-template-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(template);
  }

  /** Applies a template to a fresh installation (no employees yet). */
  static async importTemplate(req: Request, res: Response): Promise<void> {
    const input = req.body as Record<string, unknown>;
    if (!input || input.format !== TEMPLATE_FORMAT || input.version !== 1) throw badRequest('الملف ليس قالب شركة صادراً من النظام.');
    const employees = await selectOne<{ count: string }>('SELECT count(*) AS count FROM employees');
    if (Number(employees?.count) > 0) throw badRequest('يُطبَّق القالب على نسخة جديدة فقط (لا يوجد فيها موظفون).');
    const list = (key: string) => (Array.isArray(input[key]) ? input[key] as Array<Record<string, unknown>> : []);
    const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
    const counts = await transaction(async (tx) => {
      const settings = normalizeSystemSettings(input.settings as SystemSettings);
      await saveSettings(settings, req.user!.id, tx);
      for (const branch of list('branches')) {
        const code = text(branch.code, 24);
        const name = text(branch.name, 120);
        if (!code || !name) continue;
        await execute(
          `INSERT INTO branches (id, code, name, city, address, phone, is_active, created_at, updated_at)
           VALUES (:id, :code, :name, :city, :address, :phone, true, now(), now()) ON CONFLICT (code) DO NOTHING`,
          { id: randomUUID(), code, name, city: text(branch.city, 80) ?? '-', address: text(branch.address, 240), phone: text(branch.phone, 40) },
          tx,
        );
      }
      for (const department of list('departments')) {
        const code = text(department.code, 24);
        const name = text(department.name, 120);
        if (!code || !name) continue;
        await execute(
          `INSERT INTO departments (id, code, name, cost_center_code, sort_order) VALUES (:id, :code, :name, :cost, :sort)
           ON CONFLICT (code) DO NOTHING`,
          { id: randomUUID(), code, name, cost: text(department.costCenter, 40), sort: Number(department.sortOrder) || 0 },
          tx,
        );
      }
      for (const department of list('departments')) {
        const parent = text(department.parentCode, 24);
        if (!parent) continue;
        await execute(
          `UPDATE departments d SET parent_id = p.id FROM departments p WHERE d.code = :code AND p.code = :parent AND d.id <> p.id`,
          { code: text(department.code, 24), parent },
          tx,
        );
      }
      for (const job of list('jobTitles')) {
        const code = text(job.code, 24);
        const name = text(job.name, 120);
        if (!code || !name) continue;
        await execute(
          `INSERT INTO job_titles (id, code, name, department_id, grade, description)
           VALUES (:id, :code, :name, (SELECT id FROM departments WHERE code = :dept), :grade, :description) ON CONFLICT (code) DO NOTHING`,
          { id: randomUUID(), code, name, dept: text(job.departmentCode, 24), grade: text(job.grade, 20), description: text(job.description, 2000) },
          tx,
        );
      }
      for (const shift of list('shifts')) {
        const code = text(shift.code, 24);
        const name = text(shift.name, 120);
        const days = Array.isArray(shift.workingDays) ? shift.workingDays.filter((day) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6) : [];
        if (!code || !name || !/^\d{2}:\d{2}$/.test(String(shift.startTime)) || !/^\d{2}:\d{2}$/.test(String(shift.endTime)) || !days.length) continue;
        await execute(
          `INSERT INTO shifts (id, code, name, start_time, end_time, break_minutes, grace_minutes, early_leave_grace_minutes, working_days, is_default)
           VALUES (:id, :code, :name, :start, :end, :brk, :grace, :early, :days::smallint[], :isDefault) ON CONFLICT (code) DO NOTHING`,
          {
            id: randomUUID(), code, name, start: shift.startTime, end: shift.endTime, brk: Number(shift.breakMinutes) || 0,
            grace: Number(shift.graceMinutes) || 0, early: Number(shift.earlyLeaveGraceMinutes) || 0, days: `{${days.join(',')}}`,
            isDefault: shift.isDefault === true,
          },
          tx,
        );
      }
      await recordAudit(req, tx, 'owner.template_imported', 'system_settings', SETTINGS_ID);
      return {
        branches: list('branches').length, departments: list('departments').length,
        jobTitles: list('jobTitles').length, shifts: list('shifts').length,
      };
    });
    invalidateSettingsCache();
    res.json({ data: counts });
  }
}

export default OwnerController;
