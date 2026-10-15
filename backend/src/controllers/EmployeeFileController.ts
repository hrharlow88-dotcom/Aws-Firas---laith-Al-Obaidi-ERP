import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { execute, insertRow, select, selectOne, setClause, transaction } from '../db/query';
import { employeeInScope, employeeScopeSql } from '../services/access';
import { can, getSettings } from '../services/settings';
import {
  contentDisposition, openStoredFile, sniffFile, storedFileExists, storeFile, uploadedName,
} from '../services/storage';
import { recordAudit, diffFields } from '../utils/audit';
import { decryptField, encryptField, maskTail, randomToken, sha256 } from '../utils/crypto';
import {
  assertOnlyKeys, badRequest, body, conflict, forbidden, notFound, optionalNumber, optionalText, requiredText,
} from '../utils/http';
import { isDateOnly, isUuid } from '../utils/validation';

export const DOCUMENT_TYPES = [
  'national_id', 'residence_card', 'passport', 'driving_license', 'contract',
  'cv', 'certificate', 'medical', 'photo', 'other',
] as const;

const CONTRACT_TYPES = ['permanent', 'fixed_term', 'probation', 'daily', 'part_time', 'contractor'];

const PROFILE_COLUMNS: Record<string, string> = {
  nameEn: 'name_en',
  motherName: 'mother_name',
  gender: 'gender',
  birthDate: 'birth_date',
  birthPlace: 'birth_place',
  nationality: 'nationality',
  maritalStatus: 'marital_status',
  dependentsCount: 'dependents_count',
  nationalIdNo: 'national_id_no',
  address: 'address',
  governorate: 'governorate',
  emergencyContactName: 'emergency_contact_name',
  emergencyContactPhone: 'emergency_contact_phone',
  emergencyContactRelation: 'emergency_contact_relation',
  educationLevel: 'education_level',
  educationMajor: 'education_major',
  bloodType: 'blood_type',
  socialSecurityNo: 'social_security_no',
  paymentMethod: 'payment_method',
  bankName: 'bank_name',
  bankAccountNo: 'bank_account_no',
  walletProvider: 'wallet_provider',
};

/** Bank and payment details are payroll data and need compensation.manage to change. */
const PAYMENT_FIELDS = ['paymentMethod', 'bankName', 'bankAccountNo', 'walletProvider'];

function optionalDate(input: Record<string, unknown>, key: string): string | null | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!isDateOnly(value)) throw badRequest('أدخل تاريخاً صحيحاً بصيغة سنة-شهر-يوم.', { field: key });
  return value;
}

function optionalChoice<T extends string>(input: Record<string, unknown>, key: string, choices: readonly T[]): T | null | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !choices.includes(value as T)) throw badRequest('قيمة غير صالحة.', { field: key });
  return value as T;
}

async function loadDocument(req: Request, id: string) {
  if (!isUuid(id)) throw notFound('المستند غير موجود.');
  const document = await selectOne<{
    id: string; employeeId: string; storageKey: string; originalName: string; mimeType: string; docType: string;
  }>(
    `SELECT id, employee_id AS "employeeId", storage_key AS "storageKey", original_name AS "originalName",
            mime_type AS "mimeType", doc_type AS "docType"
     FROM employee_documents WHERE id = :id AND deleted_at IS NULL`,
    { id },
  );
  if (!document) throw notFound('المستند غير موجود.');
  await employeeInScope(req, document.employeeId);
  return document;
}

export class EmployeeFileController {
  /** One employee with their organizational context. */
  static async detail(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const showContact = ['super_admin', 'hr_manager', 'hr_staff', 'branch_manager', 'line_manager'].includes(req.user!.role);
    const row = await selectOne<Record<string, unknown>>(
      `SELECT e.id, e.employee_no AS "employeeNo", e.full_name AS "fullName",
              ${showContact ? 'e.email, e.phone,' : ''}
              e.branch_id AS "branchId", b.name AS "branchName", b.city AS "branchCity",
              e.department_id AS "departmentId", COALESCE(d.name, e.department) AS "department",
              e.job_title_id AS "jobTitleId", COALESCE(j.name, e."position") AS "position", j.grade AS "grade",
              e.manager_id AS "managerId", m.full_name AS "managerName",
              e.hire_date AS "hireDate", e.termination_date AS "terminationDate",
              e.employment_status AS "employmentStatus", e.employment_type AS "employmentType",
              e.attendance_pin AS "attendancePin", e.shift_id AS "shiftId", s.name AS "shiftName",
              e.photo_document_id IS NOT NULL AS "hasPhoto", e.card_issued_at AS "cardIssuedAt",
              (SELECT count(*)::int FROM employees r WHERE r.manager_id = e.id AND r.employment_status <> 'inactive') AS "directReports"
       FROM employees e
       JOIN branches b ON b.id = e.branch_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN job_titles j ON j.id = e.job_title_id
       LEFT JOIN employees m ON m.id = e.manager_id
       LEFT JOIN shifts s ON s.id = e.shift_id
       WHERE e.id = :id`,
      { id: employee.id },
    );
    res.json({ data: row });
  }

  static async getProfile(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const row = await selectOne<Record<string, unknown>>(
      `SELECT ${Object.entries(PROFILE_COLUMNS).map(([field, column]) => `${column} AS "${field}"`).join(', ')},
              p.updated_at AS "updatedAt", u.name AS "updatedByName"
       FROM employee_profiles p JOIN users u ON u.id = p.updated_by
       WHERE p.employee_id = :id`,
      { id: employee.id },
    );
    if (!row) {
      res.json({ data: null });
      return;
    }
    const canSeePay = await can(req, 'compensation.view');
    row.nationalIdNo = decryptField(row.nationalIdNo as string | null);
    const bank = decryptField(row.bankAccountNo as string | null);
    row.bankAccountNo = canSeePay ? bank : maskTail(bank);
    res.json({ data: row });
  }

  static async updateProfile(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const input = body(req);
    assertOnlyKeys(input, Object.keys(PROFILE_COLUMNS));
    if (Object.keys(input).some((field) => PAYMENT_FIELDS.includes(field)) && !(await can(req, 'compensation.manage'))) {
      throw forbidden('تعديل طريقة الدفع والحساب المصرفي يتطلب صلاحية إدارة الرواتب.');
    }
    const bloodType = optionalText(input, 'bloodType', 4);
    if (bloodType && !/^(A|B|AB|O)[+-]$/.test(bloodType)) throw badRequest('فصيلة الدم غير صالحة.', { field: 'bloodType' });
    const values: Record<string, unknown> = {
      nameEn: optionalText(input, 'nameEn', 180),
      motherName: optionalText(input, 'motherName', 180),
      gender: optionalChoice(input, 'gender', ['male', 'female'] as const),
      birthDate: optionalDate(input, 'birthDate'),
      birthPlace: optionalText(input, 'birthPlace', 120),
      nationality: optionalText(input, 'nationality', 80),
      maritalStatus: optionalChoice(input, 'maritalStatus', ['single', 'married', 'divorced', 'widowed'] as const),
      dependentsCount: optionalNumber(input, 'dependentsCount', { min: 0, max: 30, integer: true }),
      nationalIdNo: encryptField(optionalText(input, 'nationalIdNo', 40)),
      address: optionalText(input, 'address', 400),
      governorate: optionalText(input, 'governorate', 80),
      emergencyContactName: optionalText(input, 'emergencyContactName', 180),
      emergencyContactPhone: optionalText(input, 'emergencyContactPhone', 40),
      emergencyContactRelation: optionalText(input, 'emergencyContactRelation', 60),
      educationLevel: optionalText(input, 'educationLevel', 80),
      educationMajor: optionalText(input, 'educationMajor', 120),
      bloodType,
      socialSecurityNo: optionalText(input, 'socialSecurityNo', 40),
      paymentMethod: optionalChoice(input, 'paymentMethod', ['bank', 'cash', 'wallet'] as const) ?? undefined,
      bankName: optionalText(input, 'bankName', 120),
      bankAccountNo: encryptField(optionalText(input, 'bankAccountNo', 60)),
      walletProvider: optionalText(input, 'walletProvider', 60),
    };
    const before = await selectOne<Record<string, unknown>>(
      `SELECT ${Object.entries(PROFILE_COLUMNS).map(([field, column]) => `${column} AS "${field}"`).join(', ')}
       FROM employee_profiles WHERE employee_id = :id`,
      { id: employee.id },
    );
    await transaction(async (tx) => {
      if (before) {
        const { sql, params } = setClause(values, PROFILE_COLUMNS);
        if (!sql) throw badRequest('أرسل حقلاً واحداً على الأقل لتحديثه.');
        await execute(
          `UPDATE employee_profiles SET ${sql}, updated_by = :userId, updated_at = now() WHERE employee_id = :id`,
          { ...params, id: employee.id, userId: req.user!.id },
          tx,
        );
      } else {
        await insertRow(
          'employee_profiles',
          { ...values, employeeId: employee.id, updatedBy: req.user!.id },
          { ...PROFILE_COLUMNS, employeeId: 'employee_id', updatedBy: 'updated_by' },
          tx,
        );
      }
      const changed = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
      await recordAudit(req, tx, 'employee.profile_updated', 'employee', employee.id, {
        changes: diffFields(before || {}, changed, ['nationalIdNo', 'bankAccountNo']),
      });
    });
    res.json({ data: { employeeId: employee.id } });
  }

  static async listCompensation(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const rows = await select(
      `SELECT c.id, c.effective_from AS "effectiveFrom", c.gross_salary::float AS "grossSalary", c.currency,
              c.component_overrides AS "componentOverrides", c.social_security_base::float AS "socialSecurityBase",
              c.reason, c.created_at AS "createdAt", u.name AS "createdByName"
       FROM employee_compensation c JOIN users u ON u.id = c.created_by
       WHERE c.employee_id = :id ORDER BY c.effective_from DESC`,
      { id: employee.id },
    );
    res.json({ data: rows });
  }

  static async addCompensation(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const input = body(req);
    assertOnlyKeys(input, ['effectiveFrom', 'grossSalary', 'currency', 'componentOverrides', 'socialSecurityBase', 'reason']);
    const effectiveFrom = optionalDate(input, 'effectiveFrom');
    if (!effectiveFrom) throw badRequest('حدد تاريخ سريان الراتب.');
    const grossSalary = optionalNumber(input, 'grossSalary', { min: 0, max: 1e12 });
    if (grossSalary === null || grossSalary === undefined) throw badRequest('أدخل الراتب الإجمالي.');
    const settings = await getSettings();
    const currency = (optionalText(input, 'currency', 3) || settings.payrollRules.baseCurrency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw badRequest('رمز العملة غير صالح.');
    const reason = requiredText(input, 'reason', 500, 'سبب التعديل');
    const socialSecurityBase = optionalNumber(input, 'socialSecurityBase', { min: 0, max: 1e12 }) ?? null;

    const overrides = input.componentOverrides ?? {};
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) throw badRequest('تحقق من المبالغ الثابتة للمكونات.');
    const componentIds = new Set(settings.payrollRules.components.map((item) => item.id));
    for (const [componentId, amount] of Object.entries(overrides)) {
      if (!componentIds.has(componentId) || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        throw badRequest('تحقق من المبالغ الثابتة للمكونات.', { componentId });
      }
    }
    // A salary that payroll has already paid out must not change retroactively.
    const locked = await selectOne<{ period: string }>(
      `SELECT r.period FROM payroll_runs r JOIN payroll_lines l ON l.run_id = r.id
       WHERE l.employee_id = :id AND r.status IN ('approved','posted') AND r.ends_on >= :effectiveFrom
       ORDER BY r.ends_on DESC LIMIT 1`,
      { id: employee.id, effectiveFrom },
    );
    if (locked) {
      throw conflict(`لا يمكن أن يسري التعديل قبل نهاية مسير ${locked.period} المعتمد. اختر تاريخاً لاحقاً وأضف الفرق كمبلغ متغير.`);
    }
    const id = randomUUID();
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO employee_compensation (id, employee_id, effective_from, gross_salary, currency, component_overrides,
           social_security_base, reason, created_by)
         VALUES (:id, :employeeId, :effectiveFrom, :grossSalary, :currency, :overrides::jsonb, :socialSecurityBase, :reason, :userId)`,
        {
          id, employeeId: employee.id, effectiveFrom, grossSalary, currency, overrides: JSON.stringify(overrides),
          socialSecurityBase, reason, userId: req.user!.id,
        },
        tx,
      );
      await recordAudit(req, tx, 'employee.compensation_added', 'employee', employee.id, {
        compensationId: id, effectiveFrom, grossSalary, currency, socialSecurityBase, reason,
      });
    });
    res.status(201).json({ data: { id } });
  }

  static async listContracts(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const rows = await select(
      `SELECT c.id, c.contract_no AS "contractNo", c.contract_type AS "contractType", c.starts_on AS "startsOn",
              c.ends_on AS "endsOn", c.probation_ends_on AS "probationEndsOn", c.status, c.document_id AS "documentId",
              c.notes, c.created_at AS "createdAt"
       FROM employee_contracts c WHERE c.employee_id = :id ORDER BY c.starts_on DESC`,
      { id: employee.id },
    );
    res.json({ data: rows });
  }

  static async saveContract(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const contractId = req.params.contractId;
    const input = body(req);
    assertOnlyKeys(input, ['contractNo', 'contractType', 'startsOn', 'endsOn', 'probationEndsOn', 'status', 'documentId', 'notes']);
    const values = {
      contractNo: optionalText(input, 'contractNo', 60),
      contractType: optionalChoice(input, 'contractType', CONTRACT_TYPES),
      startsOn: optionalDate(input, 'startsOn'),
      endsOn: optionalDate(input, 'endsOn'),
      probationEndsOn: optionalDate(input, 'probationEndsOn'),
      status: optionalChoice(input, 'status', ['draft', 'active', 'expired', 'terminated'] as const),
      documentId: input.documentId === undefined ? undefined : (input.documentId || null) as string | null,
      notes: optionalText(input, 'notes', 1000),
    };
    if (values.documentId) {
      if (!isUuid(values.documentId) || !(await selectOne(
        'SELECT 1 FROM employee_documents WHERE id = :id AND employee_id = :employeeId AND deleted_at IS NULL',
        { id: values.documentId, employeeId: employee.id },
      ))) throw badRequest('المستند المرتبط غير موجود ضمن ملف الموظف.');
    }
    const columns = {
      contractNo: 'contract_no', contractType: 'contract_type', startsOn: 'starts_on', endsOn: 'ends_on',
      probationEndsOn: 'probation_ends_on', status: 'status', documentId: 'document_id', notes: 'notes',
    };
    if (contractId) {
      if (!isUuid(contractId) || !(await selectOne('SELECT 1 FROM employee_contracts WHERE id = :id AND employee_id = :employeeId', { id: contractId, employeeId: employee.id }))) {
        throw notFound('العقد غير موجود.');
      }
      const { sql, params } = setClause(values, columns);
      if (!sql) throw badRequest('أرسل حقلاً واحداً على الأقل لتحديثه.');
      await transaction(async (tx) => {
        await execute(`UPDATE employee_contracts SET ${sql}, updated_at = now() WHERE id = :id`, { ...params, id: contractId }, tx);
        await recordAudit(req, tx, 'employee.contract_updated', 'employee', employee.id, { contractId, ...values });
      });
      res.json({ data: { id: contractId } });
      return;
    }
    if (!values.contractType || !values.startsOn) throw badRequest('حدد نوع العقد وتاريخ بدايته.');
    if (values.endsOn && values.endsOn < values.startsOn) throw badRequest('تاريخ نهاية العقد قبل بدايته.');
    const id = randomUUID();
    await transaction(async (tx) => {
      await insertRow('employee_contracts', { id, employeeId: employee.id, createdBy: req.user!.id, ...values },
        { id: 'id', employeeId: 'employee_id', createdBy: 'created_by', ...columns }, tx);
      await recordAudit(req, tx, 'employee.contract_added', 'employee', employee.id, { contractId: id, ...values });
    });
    res.status(201).json({ data: { id } });
  }

  static async listDocuments(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const rows = await select(
      `SELECT d.id, d.doc_type AS "docType", d.title, d.doc_number AS "docNumber", d.issue_date AS "issueDate",
              d.expiry_date AS "expiryDate", d.original_name AS "originalName", d.mime_type AS "mimeType",
              d.size_bytes AS "sizeBytes", d.created_at AS "createdAt", u.name AS "uploadedByName"
       FROM employee_documents d JOIN users u ON u.id = d.uploaded_by
       WHERE d.employee_id = :id AND d.deleted_at IS NULL AND d.doc_type <> 'photo'
       ORDER BY d.created_at DESC`,
      { id: employee.id },
    );
    res.json({ data: rows });
  }

  static async uploadDocument(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const file = req.file;
    if (!file) throw badRequest('اختر ملفاً لرفعه.');
    const input = body(req);
    assertOnlyKeys(input, ['docType', 'title', 'docNumber', 'issueDate', 'expiryDate']);
    const docType = optionalChoice(input, 'docType', DOCUMENT_TYPES);
    if (!docType || docType === 'photo') throw badRequest('حدد نوع المستند.');
    const title = requiredText(input, 'title', 160, 'عنوان المستند');
    const issueDate = optionalDate(input, 'issueDate') ?? null;
    const expiryDate = optionalDate(input, 'expiryDate') ?? null;
    if (issueDate && expiryDate && expiryDate < issueDate) throw badRequest('تاريخ الانتهاء قبل تاريخ الإصدار.');
    const kind = sniffFile(file.buffer, ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
    const storageKey = await storeFile(`employees/${employee.id}`, file.buffer, kind.ext);
    const id = randomUUID();
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO employee_documents (id, employee_id, doc_type, title, doc_number, issue_date, expiry_date,
           storage_key, original_name, mime_type, size_bytes, sha256, uploaded_by)
         VALUES (:id, :employeeId, :docType, :title, :docNumber, :issueDate, :expiryDate,
           :storageKey, :originalName, :mimeType, :size, :hash, :userId)`,
        {
          id, employeeId: employee.id, docType, title, docNumber: optionalText(input, 'docNumber', 80) ?? null,
          issueDate, expiryDate, storageKey, originalName: uploadedName(file, `document.${kind.ext}`),
          mimeType: kind.mime, size: file.size, hash: sha256(file.buffer), userId: req.user!.id,
        },
        tx,
      );
      await recordAudit(req, tx, 'employee.document_uploaded', 'employee', employee.id, { documentId: id, docType, title });
    });
    res.status(201).json({ data: { id } });
  }

  static async downloadDocument(req: Request, res: Response): Promise<void> {
    const document = await loadDocument(req, req.params.documentId);
    if (!(await storedFileExists(document.storageKey))) throw notFound('ملف المستند غير موجود على الخادم.');
    await recordAudit(req, null, 'employee.document_viewed', 'employee', document.employeeId, { documentId: document.id });
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader('Content-Disposition', contentDisposition(document.originalName, req.query.inline === '1'));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    openStoredFile(document.storageKey).pipe(res);
  }

  /** Documents are retired rather than erased so the audit trail stays intact. */
  static async deleteDocument(req: Request, res: Response): Promise<void> {
    const document = await loadDocument(req, req.params.documentId);
    await transaction(async (tx) => {
      await execute('UPDATE employee_documents SET deleted_at = now(), deleted_by = :userId WHERE id = :id',
        { id: document.id, userId: req.user!.id }, tx);
      await recordAudit(req, tx, 'employee.document_removed', 'employee', document.employeeId, { documentId: document.id });
    });
    res.json({ data: { id: document.id } });
  }

  static async uploadPhoto(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const file = req.file;
    if (!file) throw badRequest('اختر صورة لرفعها.');
    if (file.size > 3 * 1024 * 1024) throw badRequest('حجم الصورة يجب ألا يتجاوز 3 ميغابايت.');
    const kind = sniffFile(file.buffer, ['image/jpeg', 'image/png', 'image/webp']);
    const storageKey = await storeFile(`employees/${employee.id}`, file.buffer, kind.ext);
    const id = randomUUID();
    await transaction(async (tx) => {
      if (employee.photoDocumentId) {
        await execute('UPDATE employee_documents SET deleted_at = now(), deleted_by = :userId WHERE id = :id',
          { id: employee.photoDocumentId, userId: req.user!.id }, tx);
      }
      await execute(
        `INSERT INTO employee_documents (id, employee_id, doc_type, title, storage_key, original_name, mime_type, size_bytes, sha256, uploaded_by)
         VALUES (:id, :employeeId, 'photo', 'الصورة الشخصية', :storageKey, :originalName, :mimeType, :size, :hash, :userId)`,
        {
          id, employeeId: employee.id, storageKey, originalName: `photo.${kind.ext}`, mimeType: kind.mime,
          size: file.size, hash: sha256(file.buffer), userId: req.user!.id,
        },
        tx,
      );
      await execute('UPDATE employees SET photo_document_id = :id, updated_at = now() WHERE id = :employeeId', { id, employeeId: employee.id }, tx);
      await recordAudit(req, tx, 'employee.photo_updated', 'employee', employee.id, { documentId: id });
    });
    res.status(201).json({ data: { id } });
  }

  static async photo(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    if (!employee.photoDocumentId) throw notFound('لا توجد صورة للموظف.');
    const photo = await selectOne<{ storageKey: string; mimeType: string }>(
      'SELECT storage_key AS "storageKey", mime_type AS "mimeType" FROM employee_documents WHERE id = :id AND deleted_at IS NULL',
      { id: employee.photoDocumentId },
    );
    if (!photo || !(await storedFileExists(photo.storageKey))) throw notFound('لا توجد صورة للموظف.');
    res.setHeader('Content-Type', photo.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    openStoredFile(photo.storageKey).pipe(res);
  }

  /** Card data for printing, including the verification token for the QR code. */
  static async card(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    const row = await selectOne<Record<string, unknown>>(
      `SELECT e.id, e.employee_no AS "employeeNo", e.full_name AS "fullName", p.name_en AS "nameEn",
              COALESCE(j.name, e."position") AS "jobTitle", COALESCE(d.name, e.department) AS "department",
              b.name AS "branchName", e.hire_date AS "hireDate", p.blood_type AS "bloodType",
              e.card_token AS "cardToken", e.card_issued_at AS "cardIssuedAt",
              e.photo_document_id IS NOT NULL AS "hasPhoto", e.employment_status AS "employmentStatus"
       FROM employees e
       JOIN branches b ON b.id = e.branch_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN job_titles j ON j.id = e.job_title_id
       LEFT JOIN employee_profiles p ON p.employee_id = e.id
       WHERE e.id = :id`,
      { id: employee.id },
    );
    res.json({ data: row });
  }

  /** Issues a card token; reissuing invalidates any previously printed card. */
  static async issueCard(req: Request, res: Response): Promise<void> {
    const employee = await employeeInScope(req, req.params.id);
    if (employee.employmentStatus === 'inactive') throw conflict('لا تصدر بطاقة لموظف غير نشط.');
    const token = randomToken(18);
    await transaction(async (tx) => {
      await execute('UPDATE employees SET card_token = :token, card_issued_at = now(), updated_at = now() WHERE id = :id',
        { id: employee.id, token }, tx);
      await recordAudit(req, tx, employee.cardIssuedAt ? 'employee.card_reissued' : 'employee.card_issued', 'employee', employee.id);
    });
    res.status(201).json({ data: { cardToken: token } });
  }

  /** Public endpoint behind the QR code: confirms a card without exposing personal data. */
  static async verifyCard(req: Request, res: Response): Promise<void> {
    const token = typeof req.params.token === 'string' ? req.params.token : '';
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw notFound('البطاقة غير صالحة.');
    const row = await selectOne<Record<string, unknown>>(
      `SELECT e.employee_no AS "employeeNo", e.full_name AS "fullName", COALESCE(j.name, e."position") AS "jobTitle",
              b.name AS "branchName", e.employment_status AS "employmentStatus", e.card_issued_at AS "cardIssuedAt"
       FROM employees e JOIN branches b ON b.id = e.branch_id LEFT JOIN job_titles j ON j.id = e.job_title_id
       WHERE e.card_token = :token`,
      { token },
    );
    if (!row) throw notFound('البطاقة غير صالحة أو أُلغيت.');
    const settings = await getSettings();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      data: {
        ...row,
        valid: row.employmentStatus === 'active' || row.employmentStatus === 'on_leave',
        company: settings.company.displayName,
      },
    });
  }

  /** Documents and contracts expiring soon, and probations ending soon. */
  static async alerts(req: Request, res: Response): Promise<void> {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 45));
    const scope = employeeScopeSql(req);
    const [documents, contracts] = await Promise.all([
      select(
        `SELECT d.id, d.employee_id AS "employeeId", e.full_name AS "employeeName", e.employee_no AS "employeeNo",
                d.doc_type AS "docType", d.title, d.expiry_date AS "expiryDate",
                (d.expiry_date - CURRENT_DATE) AS "daysLeft"
         FROM employee_documents d JOIN employees e ON e.id = d.employee_id
         WHERE d.deleted_at IS NULL AND d.expiry_date IS NOT NULL AND e.employment_status <> 'inactive'
           AND d.expiry_date <= CURRENT_DATE + :days * INTERVAL '1 day'${scope.sql}
         ORDER BY d.expiry_date`,
        { days, ...scope.params },
      ),
      select(
        `SELECT c.id, c.employee_id AS "employeeId", e.full_name AS "employeeName", e.employee_no AS "employeeNo",
                CASE WHEN c.probation_ends_on IS NOT NULL AND c.probation_ends_on BETWEEN CURRENT_DATE AND CURRENT_DATE + :days * INTERVAL '1 day'
                     THEN 'probation' ELSE 'contract' END AS "kind",
                CASE WHEN c.probation_ends_on IS NOT NULL AND c.probation_ends_on BETWEEN CURRENT_DATE AND CURRENT_DATE + :days * INTERVAL '1 day'
                     THEN c.probation_ends_on ELSE c.ends_on END AS "dueDate"
         FROM employee_contracts c JOIN employees e ON e.id = c.employee_id
         WHERE c.status = 'active' AND e.employment_status <> 'inactive'${scope.sql}
           AND ((c.ends_on IS NOT NULL AND c.ends_on <= CURRENT_DATE + :days * INTERVAL '1 day')
             OR (c.probation_ends_on IS NOT NULL AND c.probation_ends_on BETWEEN CURRENT_DATE AND CURRENT_DATE + :days * INTERVAL '1 day'))
         ORDER BY 6`,
        { days, ...scope.params },
      ),
    ]);
    res.json({ data: { documents, contracts } });
  }
}

export default EmployeeFileController;
