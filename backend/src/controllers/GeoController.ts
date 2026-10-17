import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { execute, select, selectOne } from '../db/query';
import { employeeScopeSql } from '../services/access';
import { periodBounds } from '../services/payroll';
import { recordAudit } from '../utils/audit';
import { badRequest, body, conflict, optionalText, requiredText } from '../utils/http';
import { isUuid } from '../utils/validation';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Dinars per dollar on a date: that day's bulletin, else the latest one before it. */
export async function rateOn(date: string): Promise<{ rate: number; date: string } | null> {
  return selectOne<{ rate: number; date: string }>(
    `SELECT usd_iqd::float AS rate, to_char(rate_date, 'YYYY-MM-DD') AS date FROM exchange_rates
     WHERE rate_date <= :date ORDER BY rate_date DESC LIMIT 1`,
    { date },
  );
}

/**
 * Governorates (Baghdad, Mosul, Erbil) with their branches, the daily dollar
 * rate bulletin, and the payroll register by governorate, branch and
 * department in dinars, dollars or both.
 */
export class GeoController {
  static async governorates(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT g.id, g.code, g.name_ar AS "nameAr", g.name_en AS "nameEn", g.sort_order AS "sortOrder", g.is_active AS "isActive",
              COALESCE((SELECT json_agg(json_build_object('id', b.id, 'name', b.name, 'city', b.city,
                 'employees', (SELECT count(*) FROM employees e WHERE e.branch_id = b.id AND e.employment_status <> 'inactive')) ORDER BY b.name)
                 FROM branches b WHERE b.governorate_id = g.id), '[]') AS branches
       FROM governorates g ORDER BY g.sort_order, g.name_ar`,
    );
    const unassigned = await select('SELECT id, name, city FROM branches WHERE governorate_id IS NULL ORDER BY name');
    res.json({ data: { governorates: rows, unassigned } });
  }

  static async saveGovernorate(req: Request, res: Response): Promise<void> {
    const input = body(req);
    const code = requiredText(input, 'code', 12, 'الرمز').toUpperCase();
    const nameAr = requiredText(input, 'nameAr', 80, 'الاسم');
    const nameEn = optionalText(input, 'nameEn', 80) || nameAr;
    const id = req.params.id && isUuid(req.params.id) ? req.params.id : randomUUID();
    if (req.params.id) {
      const rows = await execute(
        `UPDATE governorates SET code = :code, name_ar = :nameAr, name_en = :nameEn, sort_order = :sort, is_active = :active WHERE id = :id RETURNING id`,
        { id, code, nameAr, nameEn, sort: Number(input.sortOrder) || 0, active: input.isActive !== false },
      );
      if (!rows.length) throw badRequest('المحافظة غير موجودة.');
    } else {
      if (await selectOne('SELECT 1 FROM governorates WHERE code = :code', { code })) throw conflict('الرمز مستخدم.');
      await execute('INSERT INTO governorates (id, code, name_ar, name_en, sort_order) VALUES (:id, :code, :nameAr, :nameEn, :sort)',
        { id, code, nameAr, nameEn, sort: Number(input.sortOrder) || 0 });
    }
    await recordAudit(req, null, 'governorate.saved', 'governorate', id, { code, nameAr });
    res.status(req.params.id ? 200 : 201).json({ data: { id } });
  }

  /** The bulletin: today's dinar rate, the change from the previous one, and the history. */
  static async rates(req: Request, res: Response): Promise<void> {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 400);
    const history = await select<{ date: string; rate: number; note: string | null; setByName: string | null }>(
      `SELECT to_char(x.rate_date, 'YYYY-MM-DD') AS date, x.usd_iqd::float AS rate, x.note, u.name AS "setByName"
       FROM exchange_rates x LEFT JOIN users u ON u.id = x.set_by ORDER BY x.rate_date DESC LIMIT :days`,
      { days },
    );
    const latest = history[0] ?? null;
    const previous = history[1] ?? null;
    res.json({
      data: {
        latest, previous,
        change: latest && previous ? round(latest.rate - previous.rate) : null,
        changePercent: latest && previous ? round(((latest.rate - previous.rate) / previous.rate) * 100, 3) : null,
        history,
      },
    });
  }

  static async setRate(req: Request, res: Response): Promise<void> {
    const input = body(req);
    const date = typeof input.date === 'string' && DATE.test(input.date) ? input.date : new Date().toISOString().slice(0, 10);
    const rate = Number(input.rate);
    if (!Number.isFinite(rate) || rate < 100 || rate > 100000) throw badRequest('سعر الصرف غير منطقي (دينار لكل دولار).');
    const note = optionalText(input, 'note', 200) ?? null;
    await execute(
      `INSERT INTO exchange_rates (rate_date, usd_iqd, note, set_by) VALUES (:date, :rate, :note, :userId)
       ON CONFLICT (rate_date) DO UPDATE SET usd_iqd = EXCLUDED.usd_iqd, note = EXCLUDED.note, set_by = EXCLUDED.set_by, created_at = now()`,
      { date, rate, note, userId: req.user!.id },
    );
    await recordAudit(req, null, 'exchange_rate.set', 'exchange_rate', null, { date, rate, note });
    res.json({ data: { date, rate } });
  }

  /**
   * Every employee's pay for one month, from the system's runs (or the
   * archive for months before launch), filtered by governorate, branch and
   * department, each line shown in its currency and converted at the month's rate.
   */
  static async payrollRegister(req: Request, res: Response): Promise<void> {
    const period = typeof req.query.period === 'string' ? req.query.period : '';
    const { end } = periodBounds(period);
    const filter = (key: string) => (typeof req.query[key] === 'string' && isUuid(req.query[key]) ? String(req.query[key]) : null);
    const governorateId = filter('governorateId');
    const branchId = filter('branchId');
    const departmentId = filter('departmentId');
    const currency = typeof req.query.currency === 'string' && ['IQD', 'USD'].includes(req.query.currency) ? req.query.currency : null;
    const scope = employeeScopeSql(req);
    const bulletin = await rateOn(end);
    const params = { ...scope.params, period, governorateId, branchId, departmentId, currency };
    const where = `${governorateId ? 'AND b.governorate_id = :governorateId' : ''} ${branchId ? 'AND b.id = :branchId' : ''}
      ${departmentId ? 'AND d.id = :departmentId' : ''}${scope.sql}`;
    const system = await select<Record<string, unknown>>(
      `SELECT 'system' AS source, r.id AS "sourceId", r.status, e.id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "employeeName",
              g.name_ar AS "governorateName", b.name AS "branchName", COALESCE(d.name, e.department) AS department,
              r.currency, l.total_earnings::float AS gross, l.total_deductions::float AS deductions, l.net_pay::float AS net
       FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
       JOIN employees e ON e.id = l.employee_id
       JOIN branches b ON b.id = l.branch_id LEFT JOIN governorates g ON g.id = b.governorate_id
       LEFT JOIN departments d ON d.id = l.department_id
       WHERE r.period = :period AND r.status <> 'cancelled' ${currency ? 'AND r.currency = :currency' : ''} ${where}`,
      params,
    );
    const archived = system.length ? [] : await select<Record<string, unknown>>(
      `SELECT 'archive' AS source, m.id AS "sourceId", 'archived' AS status, e.id AS "employeeId", l.employee_no AS "employeeNo",
              COALESCE(e.full_name, l.employee_name) AS "employeeName",
              COALESCE(g.name_ar, mg.name_ar) AS "governorateName", b.name AS "branchName", COALESCE(d.name, e.department) AS department,
              l.currency, COALESCE(l.gross, l.total_earnings)::float AS gross, l.total_deductions::float AS deductions, l.net_pay::float AS net
       FROM payroll_archive_lines l JOIN payroll_archive_months m ON m.id = l.month_id AND m.withdrawn_at IS NULL
       LEFT JOIN governorates mg ON mg.id = m.governorate_id
       LEFT JOIN employees e ON e.id = l.employee_id
       LEFT JOIN branches b ON b.id = e.branch_id LEFT JOIN governorates g ON g.id = b.governorate_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE m.period = :period ${currency ? 'AND l.currency = :currency' : ''}
         ${governorateId ? 'AND COALESCE(b.governorate_id, m.governorate_id) = :governorateId' : ''}
         ${branchId ? 'AND b.id = :branchId' : ''} ${departmentId ? 'AND d.id = :departmentId' : ''}
         ${scope.sql ? `AND e.id IS NOT NULL${scope.sql}` : ''}`,
      params,
    );
    const rate = bulletin?.rate ?? null;
    type Line = Record<string, unknown> & { currency: string; netIqd: number | null; netUsd: number | null };
    const lines: Line[] = [...system, ...archived].map((line): Line => {
      const net = Number(line.net) || 0;
      const lineCurrency = String(line.currency).trim();
      return {
        ...line,
        currency: lineCurrency,
        netIqd: lineCurrency === 'IQD' ? net : rate ? round(net * rate, 0) : null,
        netUsd: lineCurrency === 'USD' ? net : rate ? round(net / rate, 2) : null,
      };
    }).sort((a, b) => String(a.employeeNo).localeCompare(String(b.employeeNo), 'en', { numeric: true }));
    const groups = new Map<string, { governorate: string; branch: string; department: string; employees: number; byCurrency: Record<string, number>; netIqd: number; netUsd: number }>();
    for (const line of lines) {
      const key = `${line.governorateName ?? '—'}|${line.branchName ?? '—'}|${line.department ?? '—'}`;
      const group = groups.get(key) ?? { governorate: String(line.governorateName ?? '—'), branch: String(line.branchName ?? '—'), department: String(line.department ?? '—'), employees: 0, byCurrency: {}, netIqd: 0, netUsd: 0 };
      group.employees += 1;
      group.byCurrency[line.currency] = round((group.byCurrency[line.currency] ?? 0) + (Number(line.net) || 0));
      group.netIqd = round(group.netIqd + (line.netIqd ?? 0), 0);
      group.netUsd = round(group.netUsd + (line.netUsd ?? 0));
      groups.set(key, group);
    }
    const totals = { employees: lines.length, byCurrency: {} as Record<string, number>, netIqd: 0, netUsd: 0 };
    for (const line of lines) {
      totals.byCurrency[line.currency] = round((totals.byCurrency[line.currency] ?? 0) + (Number(line.net) || 0));
      totals.netIqd = round(totals.netIqd + (line.netIqd ?? 0), 0);
      totals.netUsd = round(totals.netUsd + (line.netUsd ?? 0));
    }
    res.json({
      data: {
        period, rate: bulletin, source: system.length ? 'system' : archived.length ? 'archive' : null,
        lines, groups: [...groups.values()].sort((a, b) => `${a.governorate}${a.branch}${a.department}`.localeCompare(`${b.governorate}${b.branch}${b.department}`, 'ar')),
        totals,
      },
    });
  }
}

export default GeoController;
