import { Request, Response } from 'express';
import { select } from '../db/query';
import { employeeScopeSql } from '../services/access';
import { can, getSettings } from '../services/settings';
import { liveSignoffs, STEP_LABELS, STEPS } from '../services/signatures';

interface InboxGroup {
  id: string;
  module: string;
  title: string;
  link: string;
  items: Array<{ id: string; title: string; detail?: string | null; at?: string | null; link?: string }>;
}

const STEP_PERMISSION = { hr: 'payroll.prepare', audit: 'payroll.audit', ceo: 'payroll.approve', finance: 'payroll.disburse' } as const;

/**
 * "My approvals": everything waiting for the signed-in person, from every
 * app, in one place (like Odoo's activities), each with a link to act on it.
 */
export class ApprovalsController {
  static async inbox(req: Request, res: Response): Promise<void> {
    const groups: InboxGroup[] = [];
    const scope = employeeScopeSql(req);
    const settings = await getSettings();
    const ownEmployee = req.user!.employeeId ?? null;

    if (await can(req, 'leaves.approve')) {
      const rows = await select<{ id: string; name: string; startsOn: string; endsOn: string; at: string }>(
        `SELECT l.id, e.full_name AS name, to_char(l.starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(l.ends_on, 'YYYY-MM-DD') AS "endsOn",
                l.created_at AS at
         FROM leave_requests l JOIN employees e ON e.id = l.employee_id
         WHERE l.status = 'pending' AND e.id IS DISTINCT FROM :own::uuid${scope.sql}
         ORDER BY l.created_at LIMIT 50`,
        { own: ownEmployee, ...scope.params },
      );
      if (rows.length) {
        groups.push({ id: 'leaves', module: 'leaves', title: 'طلبات إجازة بانتظار الموافقة', link: '/leaves',
          items: rows.map((row) => ({ id: row.id, title: row.name, detail: `${row.startsOn} → ${row.endsOn}`, at: row.at })) });
      }
    }
    if (await can(req, 'requests.manage')) {
      const rows = await select<{ id: string; name: string; kind: string; amount: number; currency: string; at: string }>(
        `SELECT r.id, e.full_name AS name, r.kind, r.amount::float AS amount, r.currency, r.created_at AS at
         FROM employee_requests r JOIN employees e ON e.id = r.employee_id WHERE r.status = 'pending'${scope.sql}
         ORDER BY r.created_at LIMIT 50`,
        scope.params,
      );
      if (rows.length) {
        groups.push({ id: 'requests', module: 'requests', title: 'طلبات سلف وتكاليف عمل', link: '/requests',
          items: rows.map((row) => ({ id: row.id, title: `${row.name} — ${row.kind === 'loan' ? 'سلفة' : 'تكاليف عمل'}`, detail: `${row.amount} ${row.currency}`, at: row.at })) });
      }
    }
    if (await can(req, 'payroll.disburse')) {
      const rows = await select<{ id: string; name: string; amount: number; currency: string; at: string }>(
        `SELECT r.id, e.full_name AS name, r.amount::float AS amount, r.currency, r.decided_at AS at
         FROM employee_requests r JOIN employees e ON e.id = r.employee_id
         WHERE r.status = 'approved' AND r.kind = 'expense'${scope.sql} ORDER BY r.decided_at LIMIT 50`,
        scope.params,
      );
      if (rows.length) {
        groups.push({ id: 'expenses', module: 'requests', title: 'مصاريف معتمدة بانتظار الصرف', link: '/requests',
          items: rows.map((row) => ({ id: row.id, title: row.name, detail: `${row.amount} ${row.currency}`, at: row.at })) });
      }
    }
    if (settings.payrollRules.approvalChain && await can(req, 'payroll.view')) {
      const runs = await select<{ id: string; period: string; status: string; branch: string | null; paidAt: string | null }>(
        `SELECT r.id, r.period, r.status, b.name AS branch, r.paid_at AS "paidAt" FROM payroll_runs r LEFT JOIN branches b ON b.id = r.branch_id
         WHERE r.status IN ('calculated','approved','posted') AND r.paid_at IS NULL ORDER BY r.period LIMIT 40`,
      );
      const items: InboxGroup['items'] = [];
      for (const run of runs) {
        const signed = await liveSignoffs(run.id);
        const next = STEPS.find((step) => !signed.some((item) => item.step === step));
        if (!next || signed.some((item) => item.userId === req.user!.id)) continue;
        if (next === 'finance' && run.status === 'calculated') continue;
        if (!(await can(req, STEP_PERMISSION[next]))) continue;
        items.push({ id: run.id, title: `مسير ${run.period}${run.branch ? ` — ${run.branch}` : ''}`, detail: `بانتظار توقيعك: ${STEP_LABELS[next]}`, link: `/payroll/${run.id}` });
      }
      if (items.length) groups.push({ id: 'payroll', module: 'payroll', title: 'مسيرات بانتظار توقيعك', link: '/payroll', items });
    }
    if (await can(req, 'tickets.manage')) {
      const rows = await select<{ id: string; ref: string; title: string; status: string; at: string }>(
        `SELECT id, ref_no AS ref, title, status, created_at AS at FROM tickets
         WHERE status IN ('new','assigned','in_progress') AND (assignee_user_id = :userId OR assignee_user_id IS NULL)
         ORDER BY created_at LIMIT 50`,
        { userId: req.user!.id },
      ).catch(() => []);
      if (rows.length) {
        groups.push({ id: 'tickets', module: 'helpdesk', title: 'تذاكر مسندة إليك أو بلا مسؤول', link: '/tickets',
          items: rows.map((row) => ({ id: row.id, title: `${row.ref} — ${row.title}`, detail: row.status, at: row.at })) });
      }
    }
    if (ownEmployee) {
      const notices = await select<{ id: string; ref: string; title: string; at: string }>(
        `SELECT id, ref_no AS ref, title, issued_at AS at FROM disciplinary_records WHERE employee_id = :own AND status = 'issued'`,
        { own: ownEmployee },
      );
      if (notices.length) {
        groups.push({ id: 'discipline', module: 'me', title: 'إشعارات تحتاج إقرارك بالاستلام', link: '/my',
          items: notices.map((row) => ({ id: row.id, title: `${row.ref} — ${row.title}`, at: row.at })) });
      }
    }
    // Approval requests and expense reports whose current step waits for this person.
    const waiting = await select<{ id: string; number: string; title: string; kind: string; amount: number | null; currency: string | null; at: string; requester: string }>(
      `SELECT r.id, r.number, r.title, r.entity_type AS kind, r.amount::float AS amount, r.currency, r.created_at AS at, u.name AS requester
       FROM approval_requests r JOIN users u ON u.id = r.requester_id
       WHERE r.status = 'pending' AND jsonb_exists(r.steps -> r.current_step -> 'approvers', :userId) ORDER BY r.created_at LIMIT 50`,
      { userId: req.user!.id },
    );
    for (const kind of ['approval', 'expense']) {
      const items = waiting.filter((row) => row.kind === kind);
      if (!items.length) continue;
      groups.push({
        id: kind === 'expense' ? 'expense-reports' : 'approval-requests', module: kind === 'expense' ? 'expenses' : 'approval-requests',
        title: kind === 'expense' ? 'تقارير مصاريف بانتظار موافقتك' : 'طلبات موافقة بانتظارك',
        link: kind === 'expense' ? '/expenses' : '/approval-requests',
        items: items.map((row) => ({
          id: row.id, title: `${row.number} — ${row.title}`, detail: `${row.requester}${row.amount ? ` · ${row.amount} ${row.currency}` : ''}`, at: row.at,
          link: kind === 'expense' ? `/expenses/${row.id}` : `/approval-requests/${row.id}`,
        })),
      });
    }
    const total = groups.reduce((sum, group) => sum + group.items.length, 0);
    res.json({ data: { groups, total } });
  }
}

export default ApprovalsController;
