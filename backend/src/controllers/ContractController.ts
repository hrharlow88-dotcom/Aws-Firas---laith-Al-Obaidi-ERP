import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { execute, select, selectOne, transaction } from '../db/query';
import { employeeInScope } from '../services/access';
import { CONTRACT_FIELDS, fillTemplate, templateFields } from '../services/contracts';
import { getSettings } from '../services/settings';
import { contentDisposition, resolveKey, storeFile, uploadedName } from '../services/storage';
import { recordAudit } from '../utils/audit';
import { decryptField, sha256 } from '../utils/crypto';
import { assertOnlyKeys, badRequest, body, conflict, notFound, optionalText, requiredText } from '../utils/http';
import { isDateOnly, isUuid } from '../utils/validation';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const CONTRACT_TYPES = ['permanent', 'fixed_term', 'probation', 'daily', 'part_time', 'contractor'];
const WEEKDAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const CURRENCY_AR: Record<string, string> = { IQD: 'دينار عراقي', USD: 'دولار أمريكي' };

interface TemplateRow {
  id: string; name: string; contractType: string | null; storageKey: string; originalName: string; isActive: boolean;
}

async function templateOr404(id: string): Promise<TemplateRow> {
  if (!isUuid(id)) throw notFound('القالب غير موجود.');
  const row = await selectOne<TemplateRow>(
    `SELECT id, name, contract_type AS "contractType", storage_key AS "storageKey", original_name AS "originalName",
            is_active AS "isActive" FROM contract_templates WHERE id = :id`,
    { id },
  );
  if (!row) throw notFound('القالب غير موجود.');
  return row;
}

const dmy = (value: string | null | undefined) => (value ? value.slice(0, 10).split('-').reverse().join('/') : '');
const money = (value: number, currency: string) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: currency === 'IQD' ? 0 : 2 }).format(value);

function dateInput(input: Record<string, unknown>, key: string, required = false): string | null {
  const value = input[key];
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest('حدد تاريخ بداية العقد.');
    return null;
  }
  if (!isDateOnly(value)) throw badRequest('أدخل تاريخاً صحيحاً.', { field: key });
  return value;
}

export class ContractController {
  static async fields(_req: Request, res: Response): Promise<void> {
    res.json({ data: CONTRACT_FIELDS });
  }

  static async listTemplates(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT t.id, t.name, t.contract_type AS "contractType", t.description, t.original_name AS "originalName",
              t.size_bytes AS "sizeBytes", t.fields, t.is_active AS "isActive", t.created_at AS "createdAt",
              u.name AS "uploadedByName",
              (SELECT count(*)::int FROM employee_contracts c WHERE c.template_id = t.id) AS "usedCount"
       FROM contract_templates t JOIN users u ON u.id = t.uploaded_by
       ORDER BY t.is_active DESC, t.name`,
    );
    res.json({ data: rows });
  }

  static async uploadTemplate(req: Request, res: Response): Promise<void> {
    const file = req.file;
    if (!file) throw badRequest('اختر ملف Word (.docx).');
    const input = body(req);
    assertOnlyKeys(input, ['name', 'contractType', 'description']);
    const name = requiredText(input, 'name', 120, 'اسم القالب');
    const contractType = optionalText(input, 'contractType', 20) || null;
    if (contractType && !CONTRACT_TYPES.includes(contractType)) throw badRequest('نوع العقد غير صالح.');
    let fields: string[];
    try {
      fields = await templateFields(file.buffer);
    } catch {
      throw badRequest('الملف ليس مستند Word بصيغة .docx.');
    }
    const known = new Set(CONTRACT_FIELDS.map((field) => field.key));
    const unknown = fields.filter((field) => !known.has(field));
    if (unknown.length) {
      throw badRequest(`حقول غير معروفة في القالب: ${unknown.map((item) => `{{${item}}}`).join('، ')}`, { unknown });
    }
    if (!fields.length) throw badRequest('القالب لا يحتوي أي حقل مثل {{اسم_الموظف}}. أضف الحقول في أماكن الفراغات.');
    const storageKey = await storeFile('contract-templates', file.buffer, 'docx');
    const id = randomUUID();
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO contract_templates (id, name, contract_type, description, storage_key, original_name, size_bytes, sha256, fields, uploaded_by)
         VALUES (:id, :name, :contractType, :description, :storageKey, :originalName, :size, :hash, :fields::jsonb, :userId)`,
        {
          id, name, contractType, description: optionalText(input, 'description', 500) ?? null, storageKey,
          originalName: uploadedName(file, 'template.docx'), size: file.size, hash: sha256(file.buffer),
          fields: JSON.stringify(fields), userId: req.user!.id,
        },
        tx,
      );
      await recordAudit(req, tx, 'contract.template_uploaded', 'contract_template', id, { name, fields });
    });
    res.status(201).json({ data: { id, fields } });
  }

  static async downloadTemplate(req: Request, res: Response): Promise<void> {
    const template = await templateOr404(req.params.id);
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', contentDisposition(template.originalName, false));
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await fsp.readFile(resolveKey(template.storageKey)));
  }

  static async setTemplateActive(req: Request, res: Response): Promise<void> {
    const template = await templateOr404(req.params.id);
    const input = body(req);
    assertOnlyKeys(input, ['isActive']);
    if (typeof input.isActive !== 'boolean') throw badRequest('حدد حالة القالب.');
    await transaction(async (tx) => {
      await execute('UPDATE contract_templates SET is_active = :active, updated_at = now() WHERE id = :id', { id: template.id, active: input.isActive }, tx);
      await recordAudit(req, tx, input.isActive ? 'contract.template_enabled' : 'contract.template_disabled', 'contract_template', template.id);
    });
    res.json({ data: { id: template.id } });
  }

  /** Data a template would be filled with, so HR can see what is missing before generating. */
  static async preview(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const values = await contractValues(employee.id, { startsOn: null, endsOn: null, probationEndsOn: null, contractNo: null });
    res.json({ data: CONTRACT_FIELDS.map((field) => ({ ...field, value: values[field.key] ?? '' })) });
  }

  /**
   * Fills a template for one employee, files the result in the employee's
   * documents and records a draft contract pointing at it.
   */
  static async generate(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const input = body(req);
    assertOnlyKeys(input, ['templateId', 'contractType', 'startsOn', 'endsOn', 'probationEndsOn', 'contractNo']);
    const template = await templateOr404(String(input.templateId ?? ''));
    if (!template.isActive) throw conflict('القالب موقوف.');
    const startsOn = dateInput(input, 'startsOn', true)!;
    const endsOn = dateInput(input, 'endsOn');
    const probationEndsOn = dateInput(input, 'probationEndsOn');
    if (endsOn && endsOn < startsOn) throw badRequest('نهاية العقد قبل بدايته.');
    const contractType = String(input.contractType || template.contractType || 'fixed_term');
    if (!CONTRACT_TYPES.includes(contractType)) throw badRequest('نوع العقد غير صالح.');
    const contractNo = optionalText(input, 'contractNo', 60) || null;

    const values = await contractValues(employee.id, { startsOn, endsOn, probationEndsOn, contractNo });
    const filled = await fillTemplate(await fsp.readFile(resolveKey(template.storageKey)), values);
    const storageKey = await storeFile(`employees/${employee.id}`, filled, 'docx');
    const documentId = randomUUID();
    const contractId = randomUUID();
    const fileName = `عقد ${values.name || employee.employeeNo} ${startsOn}.docx`.replace(/[\\/:*?"<>|]/g, '-');
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO employee_documents (id, employee_id, doc_type, title, doc_number, issue_date, storage_key, original_name,
           mime_type, size_bytes, sha256, uploaded_by)
         VALUES (:documentId, :employeeId, 'contract', :title, :contractNo, :issueDate, :storageKey, :fileName, :mime, :size, :hash, :userId)`,
        {
          documentId, employeeId: employee.id, title: `${template.name} (مسودة للتوقيع)`.slice(0, 160), contractNo,
          issueDate: new Date().toISOString().slice(0, 10), storageKey, fileName, mime: DOCX_MIME, size: filled.length,
          hash: sha256(filled), userId: req.user!.id,
        },
        tx,
      );
      await execute(
        `INSERT INTO employee_contracts (id, employee_id, contract_no, contract_type, starts_on, ends_on, probation_ends_on, status,
           document_id, template_id, created_by)
         VALUES (:contractId, :employeeId, :contractNo, :contractType, :startsOn, :endsOn, :probationEndsOn, 'draft',
           :documentId, :templateId, :userId)`,
        { contractId, employeeId: employee.id, contractNo, contractType, startsOn, endsOn, probationEndsOn, documentId, templateId: template.id, userId: req.user!.id },
        tx,
      );
      await recordAudit(req, tx, 'employee.contract_generated', 'employee', employee.id, {
        contractId, documentId, template: template.name, startsOn, endsOn,
      });
    });
    res.status(201).json({ data: { contractId, documentId } });
  }
}

async function contractValues(
  employeeId: string,
  terms: { startsOn: string | null; endsOn: string | null; probationEndsOn: string | null; contractNo: string | null },
): Promise<Record<string, string>> {
  const row = await selectOne<Record<string, string | number | null>>(
    `SELECT e.employee_no AS "employeeNo", e.full_name AS "fullName", e.phone, to_char(e.hire_date, 'YYYY-MM-DD') AS "hireDate",
            e.employment_type AS "employmentType", COALESCE(j.name, e."position") AS position,
            COALESCE(d.name, e.department) AS department, b.name AS "branchName", b.city AS "branchCity",
            p.name_en AS "nameEn", p.gender, p.nationality, p.national_id_no AS "nationalIdNo",
            to_char(p.birth_date, 'YYYY-MM-DD') AS "birthDate", p.address, p.governorate,
            c.gross_salary::float AS gross, c.currency
     FROM employees e
     JOIN branches b ON b.id = e.branch_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN job_titles j ON j.id = e.job_title_id
     LEFT JOIN employee_profiles p ON p.employee_id = e.id
     LEFT JOIN LATERAL (
       SELECT gross_salary, currency FROM employee_compensation WHERE employee_id = e.id ORDER BY effective_from DESC LIMIT 1
     ) c ON true
     WHERE e.id = :employeeId`,
    { employeeId },
  );
  if (!row) throw notFound('الموظف غير موجود.');
  const settings = await getSettings();
  const text = (value: unknown) => (value === null || value === undefined ? '' : String(value));
  const currency = text(row.currency) || settings.payrollRules.baseCurrency;
  const gross = Number(row.gross ?? 0);
  const isDaily = row.employmentType === 'daily';
  const today = new Date().toISOString().slice(0, 10);
  const female = row.gender === 'female';
  return {
    employee_no: text(row.employeeNo),
    name: text(row.fullName),
    name_en: text(row.nameEn) || text(row.fullName),
    title_ar: female ? 'السيدة' : 'السيد',
    title_en: female ? 'Mrs' : 'Mr',
    nationality: text(row.nationality),
    id_number: decryptField(row.nationalIdNo as string | null) ?? '',
    birth_date: dmy(text(row.birthDate)),
    address: [text(row.address), text(row.governorate)].filter(Boolean).join(' - '),
    phone: text(row.phone),
    position: text(row.position),
    department: text(row.department),
    branch: text(row.branchName),
    work_location: text(row.branchName).includes(text(row.branchCity))
      ? text(row.branchName)
      : [text(row.branchName), text(row.branchCity)].filter(Boolean).join(' - '),
    hire_date: dmy(text(row.hireDate)),
    start_date: dmy(terms.startsOn),
    end_date: dmy(terms.endsOn),
    probation_end: dmy(terms.probationEndsOn),
    salary: gross ? money(isDaily ? gross * settings.payrollRules.monthlyDivisor : gross, currency) : '',
    daily_wage: gross ? money(isDaily ? gross : gross / settings.payrollRules.monthlyDivisor, currency) : '',
    currency,
    currency_ar: CURRENCY_AR[currency] ?? currency,
    contract_no: terms.contractNo ?? '',
    contract_date: dmy(today),
    contract_day: WEEKDAYS[new Date(`${today}T00:00:00Z`).getUTCDay()],
    company: settings.company.legalName || settings.company.displayName,
  };
}

export default ContractController;
