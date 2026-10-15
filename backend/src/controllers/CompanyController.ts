import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { execute, select, selectOne, transaction } from '../db/query';
import { getSettings } from '../services/settings';
import { openStoredFile, sniffFile, storeFile, storedFileExists } from '../services/storage';
import { recordAudit } from '../utils/audit';
import { assertOnlyKeys, badRequest, body, notFound, optionalText, requiredText } from '../utils/http';

const FIELDS = ['code', 'nameAr', 'nameEn', 'legalName', 'registrationNo', 'taxNo', 'address', 'phone', 'email', 'brandIds', 'sortOrder', 'isActive'];

/** The companies of the group: each has its branches, its brands and its logo. */
export class CompanyController {
  static async list(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT c.id, c.code, c.name_ar AS "nameAr", c.name_en AS "nameEn", c.legal_name AS "legalName", c.registration_no AS "registrationNo",
              c.tax_no AS "taxNo", c.address, c.phone, c.email, c.brand_ids AS "brandIds", c.sort_order AS "sortOrder", c.is_active AS "isActive",
              c.logo_key IS NOT NULL AS "hasLogo", substr(md5(COALESCE(c.logo_key, '')), 1, 8) AS "logoVersion",
              (SELECT count(*) FROM branches b WHERE b.company_id = c.id)::int AS branches,
              (SELECT count(*) FROM employees e JOIN branches b ON b.id = e.branch_id WHERE b.company_id = c.id AND e.employment_status <> 'inactive')::int AS employees
       FROM companies c ORDER BY c.sort_order, c.name_ar`,
    );
    res.json({ data: rows });
  }

  static async save(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, FIELDS);
    const settings = await getSettings();
    const brandIds = Array.isArray(input.brandIds) ? input.brandIds.filter((id) => typeof id === 'string' && settings.ui.brands.some((brand) => brand.id === id)) : [];
    const values = {
      code: requiredText(input, 'code', 24, 'رمز الشركة').toUpperCase(), nameAr: requiredText(input, 'nameAr', 160, 'اسم الشركة'),
      nameEn: optionalText(input, 'nameEn', 160) ?? null, legalName: optionalText(input, 'legalName', 200) ?? null,
      registrationNo: optionalText(input, 'registrationNo', 80) ?? null, taxNo: optionalText(input, 'taxNo', 80) ?? null,
      address: optionalText(input, 'address', 240) ?? null, phone: optionalText(input, 'phone', 40) ?? null,
      email: optionalText(input, 'email', 254) ?? null, brandIds: `{${brandIds.map((id) => `"${id}"`).join(',')}}`,
      sortOrder: Number.isInteger(input.sortOrder) ? Number(input.sortOrder) : 0, isActive: input.isActive !== false,
    };
    const id = req.params.id ?? randomUUID();
    await transaction(async (tx) => {
      if (req.params.id) {
        const rows = await execute(
          `UPDATE companies SET code = :code, name_ar = :nameAr, name_en = :nameEn, legal_name = :legalName, registration_no = :registrationNo,
             tax_no = :taxNo, address = :address, phone = :phone, email = :email, brand_ids = :brandIds::text[], sort_order = :sortOrder,
             is_active = :isActive, updated_at = now() WHERE id = :id RETURNING id`,
          { id, ...values }, tx,
        );
        if (!rows.length) throw notFound('الشركة غير موجودة.');
      } else {
        await execute(
          `INSERT INTO companies (id, code, name_ar, name_en, legal_name, registration_no, tax_no, address, phone, email, brand_ids, sort_order, is_active)
           VALUES (:id, :code, :nameAr, :nameEn, :legalName, :registrationNo, :taxNo, :address, :phone, :email, :brandIds::text[], :sortOrder, :isActive)`,
          { id, ...values }, tx,
        );
      }
      await recordAudit(req, tx, req.params.id ? 'company.updated' : 'company.created', 'company', id, { code: values.code, name: values.nameAr });
    });
    res.status(req.params.id ? 200 : 201).json({ data: { id } });
  }

  static async uploadLogo(req: Request, res: Response): Promise<void> {
    if (!req.file) throw badRequest('اختر صورة الشعار.');
    const kind = sniffFile(req.file.buffer, ['image/png', 'image/jpeg', 'image/webp']);
    const key = await storeFile('companies', req.file.buffer, kind.ext);
    const rows = await execute('UPDATE companies SET logo_key = :key, updated_at = now() WHERE id = :id RETURNING id', { key, id: req.params.id });
    if (!rows.length) throw notFound('الشركة غير موجودة.');
    await recordAudit(req, null, 'company.logo_uploaded', 'company', req.params.id);
    res.json({ data: { ok: true } });
  }

  /** Public: a company logo for the login page. */
  static async logo(req: Request, res: Response): Promise<void> {
    const row = await selectOne<{ key: string | null }>('SELECT logo_key AS key FROM companies WHERE id = :id AND is_active', { id: req.params.id });
    if (!row?.key || !(await storedFileExists(row.key))) throw notFound('لا يوجد شعار.');
    const ext = row.key.split('.').pop();
    res.type(ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    openStoredFile(row.key).pipe(res);
  }
}

export default CompanyController;
