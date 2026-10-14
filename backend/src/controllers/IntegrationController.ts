import { NextFunction, Request, Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { execute, select, selectOne, transaction } from '../db/query';
import { EFFECTIVE_DAY_COLUMNS } from '../services/attendance';
import { recordAudit } from '../utils/audit';
import { randomToken, sha256 } from '../utils/crypto';
import { assertOnlyKeys, badRequest, body, conflict, notFound, pageParams, queryText, requiredText } from '../utils/http';
import { isDateOnly, isUuid } from '../utils/validation';

/**
 * Read-only API for the group's other systems (e.g. the job-description and
 * KPI portal) to pull employees, the org structure and attendance totals.
 * Keys are shown once, stored only as SHA-256 hashes, scoped and revocable.
 */
export const INTEGRATION_SCOPES = ['employees.read', 'org.read', 'attendance.read'] as const;
type Scope = (typeof INTEGRATION_SCOPES)[number];

declare global {
  namespace Express {
    interface Request {
      integration?: { id: string; name: string; scopes: Scope[] };
    }
  }
}

export function requireApiKey(scope: Scope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.header('x-api-key') || '';
    const match = key.match(/^lo_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{20,})$/);
    if (!match) {
      res.status(401).json({ message: 'مفتاح الربط مفقود أو غير صالح.' });
      return;
    }
    void selectOne<{ id: string; name: string; keyHash: string; scopes: Scope[] }>(
      `SELECT id, name, key_hash AS "keyHash", scopes FROM integration_api_keys WHERE key_prefix = :prefix AND revoked_at IS NULL`,
      { prefix: match[1] },
    ).then(async (row) => {
      const expected = row ? Buffer.from(row.keyHash, 'hex') : Buffer.alloc(32);
      const actual = Buffer.from(sha256(key), 'hex');
      if (!row || !timingSafeEqual(expected, actual)) {
        res.status(401).json({ message: 'مفتاح الربط مفقود أو غير صالح.' });
        return;
      }
      if (!row.scopes.includes(scope)) {
        res.status(403).json({ message: 'المفتاح لا يملك صلاحية هذا المورد.' });
        return;
      }
      req.integration = { id: row.id, name: row.name, scopes: row.scopes };
      await execute('UPDATE integration_api_keys SET last_used_at = now() WHERE id = :id', { id: row.id });
      next();
    }).catch(next);
  };
}

export class IntegrationController {
  static async listKeys(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT k.id, k.name, k.key_prefix AS "keyPrefix", k.scopes, k.created_at AS "createdAt",
              k.last_used_at AS "lastUsedAt", k.revoked_at AS "revokedAt", u.name AS "createdByName"
       FROM integration_api_keys k JOIN users u ON u.id = k.created_by ORDER BY k.created_at DESC`,
    );
    res.json({ data: rows });
  }

  static async createKey(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['name', 'scopes']);
    const name = requiredText(input, 'name', 120, 'اسم النظام المرتبط');
    const scopes = input.scopes;
    if (!Array.isArray(scopes) || !scopes.length || !scopes.every((item) => (INTEGRATION_SCOPES as readonly unknown[]).includes(item))) {
      throw badRequest('اختر صلاحيات المفتاح.');
    }
    const id = randomUUID();
    const prefix = randomToken(12).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).padEnd(8, '0');
    const key = `lo_${prefix}_${randomToken(32)}`;
    await transaction(async (tx) => {
      await execute(
        `INSERT INTO integration_api_keys (id, name, key_prefix, key_hash, scopes, created_by)
         VALUES (:id, :name, :prefix, :hash, :scopes::jsonb, :userId)`,
        { id, name, prefix, hash: sha256(key), scopes: JSON.stringify([...new Set(scopes)]), userId: req.user!.id },
        tx,
      );
      await recordAudit(req, tx, 'integration.key_created', 'integration_api_key', id, { name, scopes });
    });
    res.status(201).json({ data: { id, key, note: 'انسخ المفتاح الآن؛ لن يظهر مرة أخرى.' } });
  }

  static async revokeKey(req: Request, res: Response): Promise<void> {
    const id = req.params.id;
    const row = isUuid(id) ? await selectOne<{ revokedAt: string | null }>(
      'SELECT revoked_at AS "revokedAt" FROM integration_api_keys WHERE id = :id', { id },
    ) : null;
    if (!row) throw notFound('المفتاح غير موجود.');
    if (row.revokedAt) throw conflict('المفتاح ملغى مسبقاً.');
    await transaction(async (tx) => {
      await execute('UPDATE integration_api_keys SET revoked_at = now() WHERE id = :id', { id }, tx);
      await recordAudit(req, tx, 'integration.key_revoked', 'integration_api_key', id);
    });
    res.json({ data: { id } });
  }

  // --- Read API for other systems ---------------------------------------

  static async employees(req: Request, res: Response): Promise<void> {
    const { page, pageSize, offset } = pageParams(req, 200, 500);
    const updatedSince = queryText(req, 'updatedSince');
    const since = updatedSince && !Number.isNaN(Date.parse(updatedSince)) ? updatedSince : null;
    const rows = await select(
      `SELECT e.id, e.employee_no AS "employeeNo", e.full_name AS "fullName", e.email,
              e.employment_status AS "employmentStatus", e.employment_type AS "employmentType",
              to_char(e.hire_date, 'YYYY-MM-DD') AS "hireDate", to_char(e.termination_date, 'YYYY-MM-DD') AS "terminationDate",
              e.branch_id AS "branchId", b.code AS "branchCode", b.name AS "branchName",
              e.department_id AS "departmentId", d.code AS "departmentCode", COALESCE(d.name, e.department) AS "department",
              e.job_title_id AS "jobTitleId", j.code AS "jobTitleCode", COALESCE(j.name, e."position") AS "jobTitle",
              e.manager_id AS "managerId", m.employee_no AS "managerEmployeeNo", e.updated_at AS "updatedAt"
       FROM employees e
       JOIN branches b ON b.id = e.branch_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN job_titles j ON j.id = e.job_title_id
       LEFT JOIN employees m ON m.id = e.manager_id
       ${since ? 'WHERE e.updated_at >= :since' : ''}
       ORDER BY e.employee_no LIMIT :limit OFFSET :offset`,
      { since, limit: pageSize, offset },
    );
    res.json({ data: rows, pagination: { page, pageSize } });
  }

  static async org(_req: Request, res: Response): Promise<void> {
    const [branches, departments, jobTitles] = await Promise.all([
      select('SELECT id, code, name, city, is_active AS "isActive" FROM branches ORDER BY code'),
      select(`SELECT id, code, name, parent_id AS "parentId", manager_employee_id AS "managerEmployeeId",
                     cost_center_code AS "costCenterCode", is_active AS "isActive" FROM departments ORDER BY code`),
      select(`SELECT id, code, name, department_id AS "departmentId", grade, description, is_active AS "isActive"
              FROM job_titles ORDER BY code`),
    ]);
    res.json({ data: { branches, departments, jobTitles } });
  }

  static async attendanceSummary(req: Request, res: Response): Promise<void> {
    const from = queryText(req, 'from');
    const to = queryText(req, 'to');
    if (!isDateOnly(from) || !isDateOnly(to) || to < from) throw badRequest('حدد فترة صحيحة.');
    const rows = await select(
      `SELECT e.employee_no AS "employeeNo",
              count(*) FILTER (WHERE x.status = 'present')::int AS present,
              count(*) FILTER (WHERE x.status = 'absent')::int AS absent,
              count(*) FILTER (WHERE x.status IN ('leave','unpaid_leave'))::int AS leave,
              COALESCE(sum(x."lateMinutes"), 0)::int AS "lateMinutes",
              COALESCE(sum(x."overtimeMinutes"), 0)::int AS "overtimeMinutes"
       FROM employees e
       JOIN LATERAL (SELECT ${EFFECTIVE_DAY_COLUMNS} FROM attendance_days d WHERE d.employee_id = e.id AND d.work_date BETWEEN :from AND :to) x ON true
       GROUP BY e.employee_no ORDER BY e.employee_no`,
      { from, to },
    );
    res.json({ data: rows });
  }
}

export default IntegrationController;
