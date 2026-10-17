import { execute, select, selectOne } from '../db/query';
import { notifyPermission, notifyUsers, NoticeInput } from './notify';
import { backupDir, lastDownload, listBackups } from './backups';

const BACKUP_REMINDER_ID = '00000000-0000-4000-8000-0000000000b1';

/** Today in Baghdad as YYYY-MM-DD. */
export function baghdadToday(now = new Date()): string {
  return new Date(now.getTime() + 3 * 3600000).toISOString().slice(0, 10);
}

/** Records the reminder; false when it was already sent (each one goes out once). */
async function once(kind: string, entityId: string, refDate: string): Promise<boolean> {
  const rows = await execute(
    `INSERT INTO reminder_log (kind, entity_id, ref_date) VALUES (:kind, :entityId, :refDate)
     ON CONFLICT DO NOTHING RETURNING kind`,
    { kind, entityId, refDate },
  );
  return rows.length > 0;
}

async function owners(): Promise<string[]> {
  return (await select<{ id: string }>("SELECT id FROM users WHERE role = 'super_admin' AND is_active AND NOT is_demo")).map((row) => row.id);
}

async function employeeUsers(employeeId: string): Promise<string[]> {
  return (await select<{ id: string }>('SELECT id FROM users WHERE employee_id = :employeeId AND is_active', { employeeId })).map((row) => row.id);
}

async function managerUsers(employeeId: string): Promise<string[]> {
  return (await select<{ id: string }>(
    `SELECT u.id FROM employees e JOIN users u ON u.employee_id = e.manager_id AND u.is_active WHERE e.id = :employeeId`, { employeeId },
  )).map((row) => row.id);
}

async function tellStaff(notice: NoticeInput, extra: string[] = []): Promise<void> {
  await notifyUsers([...(await owners()), ...extra], notice);
  await notifyPermission('employees.manage_profile', notice);
}

export interface ReminderSummary { [kind: string]: number }

/**
 * The daily HR round: passport and residency expiry for foreign employees,
 * birthdays, probation ends, service anniversaries, contracts to renew,
 * advances (this month's deduction, the last one), and coming holidays.
 * Each reminder is sent once to the employee (when they have an account),
 * the owner and HR, and the employee's manager where it concerns them.
 */
export async function runHrReminders(now = new Date()): Promise<ReminderSummary> {
  const today = baghdadToday(now);
  const sent: ReminderSummary = {};
  const count = (kind: string) => { sent[kind] = (sent[kind] ?? 0) + 1; };

  // Passport: six months before expiry. Residency (visa): sixty days before.
  const documents = await select<{ employeeId: string; name: string; no: string; kind: 'passport' | 'residency'; expiry: string; days: number }>(
    `SELECT e.id AS "employeeId", e.full_name AS name, e.employee_no AS no, 'passport' AS kind,
            to_char(p.passport_expiry, 'YYYY-MM-DD') AS expiry, (p.passport_expiry - :today::date) AS days
     FROM employee_profiles p JOIN employees e ON e.id = p.employee_id
     WHERE p.residency_status = 'foreign' AND p.passport_expiry IS NOT NULL AND e.employment_status <> 'inactive'
       AND p.passport_expiry <= :today::date + INTERVAL '6 months'
     UNION ALL
     SELECT e.id, e.full_name, e.employee_no, 'residency', to_char(p.residency_expiry, 'YYYY-MM-DD'), (p.residency_expiry - :today::date)
     FROM employee_profiles p JOIN employees e ON e.id = p.employee_id
     WHERE p.residency_status = 'foreign' AND p.residency_expiry IS NOT NULL AND e.employment_status <> 'inactive'
       AND p.residency_expiry <= :today::date + 60`,
    { today },
  );
  for (const item of documents) {
    if (!(await once(item.kind, item.employeeId, item.expiry))) continue;
    const label = item.kind === 'passport' ? 'جواز السفر' : 'الإقامة (الفيزا)';
    const when = item.days < 0 ? `انتهت منذ ${-item.days} يوماً` : `تنتهي بعد ${item.days} يوماً (${item.expiry})`;
    const notice = { kind: 'document', title: `${label}: ${item.name} (${item.no})`, body: `${when}. يرجى التجديد ورفع النسخة الجديدة.`, link: `/employees/${item.employeeId}` };
    await notifyUsers(await employeeUsers(item.employeeId), { ...notice, title: `تذكير: ${label} ${when}`, link: '/my' });
    await tellStaff(notice);
    count(item.kind);
  }

  // Birthdays today: a greeting to the employee, and a note to HR so they can congratulate.
  const birthdays = await select<{ employeeId: string; name: string }>(
    `SELECT e.id AS "employeeId", e.full_name AS name FROM employee_profiles p JOIN employees e ON e.id = p.employee_id
     WHERE p.birth_date IS NOT NULL AND e.employment_status <> 'inactive'
       AND to_char(p.birth_date, 'MM-DD') = to_char(:today::date, 'MM-DD')`,
    { today },
  );
  for (const item of birthdays) {
    if (!(await once('birthday', item.employeeId, today))) continue;
    await notifyUsers(await employeeUsers(item.employeeId), {
      kind: 'greeting', title: `عيد ميلاد سعيد يا ${item.name.split(' ')[0]} 🎉 · Happy birthday!`,
      body: 'تتمنى لك إدارة مجموعة الليث العبيدي عاماً مليئاً بالنجاح والصحة. Wishing you a wonderful year ahead.', link: '/my',
    });
    await tellStaff({ kind: 'greeting', title: `عيد ميلاد اليوم: ${item.name}`, body: 'شارك بالتهنئة.', link: `/employees/${item.employeeId}` });
    count('birthday');
  }

  // Probation ending within seven days.
  const probations = await select<{ employeeId: string; name: string; due: string; days: number }>(
    `SELECT e.id AS "employeeId", e.full_name AS name, to_char(c.probation_ends_on, 'YYYY-MM-DD') AS due, (c.probation_ends_on - :today::date) AS days
     FROM employee_contracts c JOIN employees e ON e.id = c.employee_id
     WHERE c.status = 'active' AND c.probation_ends_on BETWEEN :today::date AND :today::date + 7 AND e.employment_status <> 'inactive'`,
    { today },
  );
  for (const item of probations) {
    if (!(await once('probation', item.employeeId, item.due))) continue;
    const notice = { kind: 'contract', title: `تنتهي فترة التجربة: ${item.name}`, body: `في ${item.due} (بعد ${item.days} يوم). قيّم الأداء وقرر التثبيت.`, link: `/employees/${item.employeeId}` };
    await tellStaff(notice, await managerUsers(item.employeeId));
    count('probation');
  }

  // Service anniversaries (one year, two years, ...).
  const anniversaries = await select<{ employeeId: string; name: string; years: number }>(
    `SELECT e.id AS "employeeId", e.full_name AS name, (date_part('year', age(:today::date, e.hire_date)))::int AS years
     FROM employees e
     WHERE e.employment_status <> 'inactive' AND e.hire_date < :today::date
       AND to_char(e.hire_date, 'MM-DD') = to_char(:today::date, 'MM-DD')`,
    { today },
  );
  for (const item of anniversaries) {
    if (item.years < 1 || !(await once('service_year', item.employeeId, today))) continue;
    await notifyUsers(await employeeUsers(item.employeeId), {
      kind: 'greeting', title: `أكملت ${item.years === 1 ? 'سنتك الأولى' : `${item.years} سنوات`} معنا 🌟 · ${item.years} year${item.years > 1 ? 's' : ''} with us`,
      body: 'شكراً لعطائك وإخلاصك. Thank you for your dedication.', link: '/my',
    });
    await tellStaff({ kind: 'greeting', title: `${item.name} أكمل ${item.years} سنة خدمة`, body: 'راجع الاستحقاقات المرتبطة بسنوات الخدمة.', link: `/employees/${item.employeeId}` });
    count('service_year');
  }

  // Contracts ending within thirty days need a renewal decision.
  const renewals = await select<{ contractId: string; employeeId: string; name: string; due: string; days: number }>(
    `SELECT c.id AS "contractId", e.id AS "employeeId", e.full_name AS name, to_char(c.ends_on, 'YYYY-MM-DD') AS due, (c.ends_on - :today::date) AS days
     FROM employee_contracts c JOIN employees e ON e.id = c.employee_id
     WHERE c.status = 'active' AND c.ends_on BETWEEN :today::date AND :today::date + 30 AND e.employment_status <> 'inactive'`,
    { today },
  );
  for (const item of renewals) {
    if (!(await once('contract_renewal', item.contractId, item.due))) continue;
    await tellStaff({ kind: 'contract', title: `تجديد عقد: ${item.name}`, body: `ينتهي العقد في ${item.due} (بعد ${item.days} يوم).`, link: `/employees/${item.employeeId}` },
      await managerUsers(item.employeeId));
    count('contract_renewal');
  }

  // Advances: this month's deduction and what remains, once a month; the last instalment flagged.
  const month = today.slice(0, 7);
  const loans = await select<{ id: string; employeeId: string; name: string; currency: string; installment: number; remaining: number; startPeriod: string }>(
    `SELECT l.id, l.employee_id AS "employeeId", e.full_name AS name, l.currency, l.installment::float AS installment, l.start_period AS "startPeriod",
            (l.principal - l.paid_before - COALESCE((SELECT SUM(x.amount) FROM loan_repayments x JOIN payroll_runs r ON r.id = x.run_id
                                                     WHERE x.loan_id = l.id AND r.status IN ('approved','posted')), 0))::float AS remaining
     FROM employee_loans l JOIN employees e ON e.id = l.employee_id
     WHERE l.status = 'active' AND l.archived_at IS NULL AND l.start_period <= :month`,
    { month },
  );
  for (const loan of loans) {
    if (loan.remaining <= 0.004 || !(await once('loan_month', loan.id, `${month}-01`))) continue;
    const take = Math.min(loan.installment, loan.remaining);
    const left = Math.max(0, Math.round((loan.remaining - take) * 100) / 100);
    const last = left <= 0.004;
    const body = `استقطاع ${month}: ${take.toLocaleString('en-US')} ${loan.currency}، المتبقي بعده ${left.toLocaleString('en-US')} ${loan.currency}${last ? ' — هذا آخر استقطاع وتُغلق السلفة' : ''}.`;
    await notifyUsers(await employeeUsers(loan.employeeId), { kind: 'loan', title: last ? 'آخر قسط من سلفتك هذا الشهر' : 'قسط السلفة لهذا الشهر', body, link: '/my' });
    if (last) await notifyPermission('payroll.prepare', { kind: 'loan', title: `آخر قسط: ${loan.name}`, body, link: `/loans` });
    count('loan_month');
  }

  // Confirmed official holidays a week ahead, to everyone.
  const holidays = await select<{ date: string; name: string }>(
    `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS date, name_ar AS name FROM holiday_calendar
     WHERE confirmed AND holiday_date BETWEEN :today::date AND :today::date + 7`,
    { today },
  );
  for (const holiday of holidays) {
    const id = (await selectOne<{ id: string }>("SELECT md5(:key)::uuid AS id", { key: `holiday:${holiday.date}` }))!.id;
    if (!(await once('holiday', id, holiday.date))) continue;
    const users = await select<{ id: string }>('SELECT id FROM users WHERE is_active AND NOT is_demo');
    await notifyUsers(users.map((user) => user.id), { kind: 'calendar', title: `عطلة رسمية: ${holiday.name}`, body: `يوم ${holiday.date}.`, link: '/calendar' });
    count('holiday');
  }
  // Backups off the server: a weekly nudge to the owner until a copy is downloaded.
  if (backupDir() && (await listBackups()).length) {
    const last = await lastDownload();
    if (!last || Date.parse(last) < now.getTime() - 7 * 86400000) {
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
      const monday = new Date(Date.parse(`${today}T00:00:00Z`) - ((weekday + 6) % 7) * 86400000).toISOString().slice(0, 10);
      if (await once('backup_offsite', BACKUP_REMINDER_ID, monday)) {
        await notifyUsers(await owners(), {
          kind: 'backup', title: 'نزّل نسخة احتياطية خارج السيرفر',
          body: last ? `آخر تنزيل ${last.slice(0, 10)}. لوحة المالك ← النسخ الاحتياطي.` : 'لم تُنزَّل أي نسخة بعد. لوحة المالك ← النسخ الاحتياطي.',
          link: '/owner',
        });
        count('backup_offsite');
      }
    }
  }
  return sent;
}
