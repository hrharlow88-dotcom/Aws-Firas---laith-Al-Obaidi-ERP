import { randomUUID } from 'node:crypto';
import { notifyPermission, notifyUsers } from '../services/notify';
import { Request, Response } from 'express';
import { execute, select, selectOne, transaction } from '../db/query';
import { can } from '../services/settings';
import { recordAudit } from '../utils/audit';
import { assertOnlyKeys, badRequest, body, conflict, forbidden, notFound, optionalNumber, optionalText, requiredText } from '../utils/http';
import { isUuid } from '../utils/validation';

const CATEGORIES = ['it', 'maintenance', 'vehicle', 'transport'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['new', 'assigned', 'in_progress', 'waiting', 'resolved', 'closed', 'cancelled'];
const PREFIX: Record<string, string> = { it: 'IT', maintenance: 'MNT', vehicle: 'VEH', transport: 'TRN' };

const COLUMNS = `
  t.id, t.ref_no AS "refNo", t.category, t.subtype, t.title, t.description, t.priority, t.status,
  t.requester_user_id AS "requesterUserId", ru.name AS "requesterName", re.employee_no AS "requesterEmployeeNo",
  t.branch_id AS "branchId", b.name AS "branchName", t.location, t.assignee_user_id AS "assigneeUserId", au.name AS "assigneeName",
  t.needed_from AS "neededFrom", t.needed_to AS "neededTo", t.destination, t.passengers, t.vehicle_plate AS "vehiclePlate",
  t.resolution, t.resolved_at AS "resolvedAt", t.closed_at AS "closedAt", t.created_at AS "createdAt", t.updated_at AS "updatedAt"`;
const FROM = `
  FROM tickets t
  JOIN users ru ON ru.id = t.requester_user_id
  LEFT JOIN employees re ON re.id = t.requester_employee_id
  LEFT JOIN branches b ON b.id = t.branch_id
  LEFT JOIN users au ON au.id = t.assignee_user_id`;

function parseTime(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw badRequest('الوقت غير صالح.');
  return new Date(value).toISOString();
}

async function loadTicket(id: string) {
  if (!isUuid(id)) throw notFound('التذكرة غير موجودة.');
  const row = await selectOne<{ id: string; status: string; requesterUserId: string; refNo: string; assigneeUserId: string | null }>(
    'SELECT id, status, requester_user_id AS "requesterUserId", ref_no AS "refNo", assignee_user_id AS "assigneeUserId" FROM tickets WHERE id = :id', { id },
  );
  if (!row) throw notFound('التذكرة غير موجودة.');
  return row;
}

/** Helpdesk: IT, maintenance, vehicle requests and transport, raised by anyone and handled by the desk. */
export class TicketController {
  static async list(req: Request, res: Response): Promise<void> {
    const desk = await can(req, 'tickets.manage');
    const mine = req.query.mine === '1' || !desk;
    const category = typeof req.query.category === 'string' && CATEGORIES.includes(req.query.category) ? req.query.category : null;
    const rows = await select(
      `SELECT ${COLUMNS} ${FROM} WHERE true ${mine ? 'AND t.requester_user_id = :userId' : ''} ${category ? 'AND t.category = :category' : ''}
       ORDER BY (t.status IN ('resolved','closed','cancelled')), CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.created_at DESC
       LIMIT 500`,
      { userId: req.user!.id, category },
    );
    res.json({ data: rows });
  }

  /** People the desk can assign tickets to. */
  static async agents(_req: Request, res: Response): Promise<void> {
    const rows = await select(
      `SELECT u.id, u.name FROM users u WHERE u.is_active AND u.role NOT IN ('employee','viewer') ORDER BY u.name`,
    );
    res.json({ data: rows });
  }

  static async get(req: Request, res: Response): Promise<void> {
    const ticket = await loadTicket(req.params.id);
    if (ticket.requesterUserId !== req.user!.id && !(await can(req, 'tickets.manage'))) throw notFound('التذكرة غير موجودة.');
    const row = await selectOne<Record<string, unknown>>(`SELECT ${COLUMNS} ${FROM} WHERE t.id = :id`, { id: ticket.id });
    const comments = await select(
      `SELECT c.id, c.body, c.kind, c.created_at AS "createdAt", u.name AS "userName" FROM ticket_comments c JOIN users u ON u.id = c.user_id
       WHERE c.ticket_id = :id ORDER BY c.created_at`, { id: ticket.id },
    );
    res.json({ data: { ...row, comments } });
  }

  static async create(req: Request, res: Response): Promise<void> {
    const input = body(req);
    assertOnlyKeys(input, ['category', 'subtype', 'title', 'description', 'priority', 'location', 'neededFrom', 'neededTo', 'destination', 'passengers', 'vehiclePlate']);
    const category = String(input.category);
    if (!CATEGORIES.includes(category)) throw badRequest('اختر نوع التذكرة.');
    const priority = input.priority === undefined ? 'normal' : String(input.priority);
    if (!PRIORITIES.includes(priority)) throw badRequest('الأولوية غير صالحة.');
    const title = requiredText(input, 'title', 200, 'عنوان الطلب');
    const description = requiredText(input, 'description', 5000, 'تفاصيل الطلب');
    const neededFrom = parseTime(input.neededFrom);
    const neededTo = parseTime(input.neededTo);
    if ((category === 'vehicle' || category === 'transport') && !neededFrom) throw badRequest('حدد وقت الحاجة للسيارة.');
    if (neededFrom && neededTo && neededTo <= neededFrom) throw badRequest('وقت الإرجاع يجب أن يكون بعد وقت البداية.');
    const employee = req.user!.employeeId
      ? await selectOne<{ id: string; branchId: string }>('SELECT id, branch_id AS "branchId" FROM employees WHERE id = :id', { id: req.user!.employeeId })
      : null;
    const id = randomUUID();
    const refNo = await transaction(async (tx) => {
      const seq = await selectOne<{ n: string }>("SELECT nextval('ticket_ref_seq')::text AS n", {}, tx);
      const ref = `${PREFIX[category]}-${seq!.n.padStart(5, '0')}`;
      await execute(
        `INSERT INTO tickets (id, ref_no, category, subtype, title, description, priority, requester_user_id, requester_employee_id, branch_id,
           location, needed_from, needed_to, destination, passengers, vehicle_plate)
         VALUES (:id, :ref, :category, :subtype, :title, :description, :priority, :userId, :employeeId, :branchId,
           :location, :neededFrom, :neededTo, :destination, :passengers, :plate)`,
        {
          id, ref, category, subtype: optionalText(input, 'subtype', 60) ?? null, title, description, priority, userId: req.user!.id,
          employeeId: employee?.id ?? null, branchId: employee?.branchId ?? req.user!.branchId ?? null,
          location: optionalText(input, 'location', 200) ?? null, neededFrom, neededTo,
          destination: optionalText(input, 'destination', 200) ?? null,
          passengers: optionalNumber(input, 'passengers', { min: 1, max: 100 }) ?? null,
          plate: optionalText(input, 'vehiclePlate', 30) ?? null,
        }, tx,
      );
      await recordAudit(req, tx, 'ticket.created', 'ticket', id, { ref, category, priority });
      await notifyPermission('tickets.manage', { kind: 'ticket', title: `تذكرة جديدة ${ref}`, body: title, link: '/tickets' }, tx, req.user!.id);
      return ref;
    });
    res.status(201).json({ data: { id, refNo } });
  }

  /** The desk moves a ticket: status, assignee, priority, resolution. Every change is written to the ticket's log. */
  static async update(req: Request, res: Response): Promise<void> {
    const ticket = await loadTicket(req.params.id);
    const input = body(req);
    assertOnlyKeys(input, ['status', 'assigneeUserId', 'priority', 'resolution', 'vehiclePlate']);
    const desk = await can(req, 'tickets.manage');
    const own = ticket.requesterUserId === req.user!.id;
    // The requester may only cancel an open ticket or close a resolved one.
    if (!desk && !(own && Object.keys(input).length === 1 && ((input.status === 'cancelled' && !['resolved', 'closed', 'cancelled'].includes(ticket.status)) || (input.status === 'closed' && ticket.status === 'resolved')))) {
      throw forbidden();
    }
    if (['closed', 'cancelled'].includes(ticket.status)) throw conflict('التذكرة مغلقة.');
    const changes: string[] = [];
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: ticket.id };
    if (input.status !== undefined) {
      const status = String(input.status);
      if (!STATUSES.includes(status)) throw badRequest('الحالة غير صالحة.');
      sets.push('status = :status');
      params.status = status;
      if (status === 'resolved') sets.push('resolved_at = now()');
      if (status === 'closed') sets.push('closed_at = now()');
      changes.push(`الحالة: ${status}`);
    }
    if (input.assigneeUserId !== undefined) {
      const assignee = input.assigneeUserId === null || input.assigneeUserId === '' ? null : String(input.assigneeUserId);
      if (assignee && !(await selectOne('SELECT 1 FROM users WHERE id = :id AND is_active', { id: assignee }))) throw badRequest('المكلّف غير موجود.');
      sets.push('assignee_user_id = :assignee');
      params.assignee = assignee;
      if (assignee && input.status === undefined && ticket.status === 'new') { sets.push("status = 'assigned'"); }
      changes.push('تغيير المكلّف');
    }
    if (input.priority !== undefined) {
      if (!PRIORITIES.includes(String(input.priority))) throw badRequest('الأولوية غير صالحة.');
      sets.push('priority = :priority');
      params.priority = String(input.priority);
      changes.push(`الأولوية: ${params.priority}`);
    }
    if (input.resolution !== undefined) {
      sets.push('resolution = :resolution');
      params.resolution = optionalText(input, 'resolution', 5000) ?? null;
      changes.push('الحل');
    }
    if (input.vehiclePlate !== undefined) {
      sets.push('vehicle_plate = :plate');
      params.plate = optionalText(input, 'vehiclePlate', 30) ?? null;
      changes.push('رقم السيارة');
    }
    if (!sets.length) throw badRequest('لا يوجد تغيير.');
    await transaction(async (tx) => {
      await execute(`UPDATE tickets SET ${sets.join(', ')}, updated_at = now() WHERE id = :id`, params, tx);
      await execute(
        `INSERT INTO ticket_comments (id, ticket_id, user_id, body, kind) VALUES (:cid, :id, :userId, :body, 'status')`,
        { cid: randomUUID(), id: ticket.id, userId: req.user!.id, body: changes.join(' · ') }, tx,
      );
      await recordAudit(req, tx, 'ticket.updated', 'ticket', ticket.id, { changes });
      await notifyUsers([ticket.requesterUserId !== req.user!.id ? ticket.requesterUserId : null, params.assignee as string | null | undefined],
        { kind: 'ticket', title: `تحديث على تذكرتك ${ticket.refNo}`, body: changes.join(' · '), link: '/my-tickets' }, tx);
    });
    res.json({ data: { id: ticket.id } });
  }

  static async comment(req: Request, res: Response): Promise<void> {
    const ticket = await loadTicket(req.params.id);
    if (ticket.requesterUserId !== req.user!.id && !(await can(req, 'tickets.manage'))) throw notFound('التذكرة غير موجودة.');
    const text = requiredText(body(req), 'body', 2000, 'التعليق');
    await execute(
      `INSERT INTO ticket_comments (id, ticket_id, user_id, body) VALUES (:cid, :id, :userId, :body)`,
      { cid: randomUUID(), id: ticket.id, userId: req.user!.id, body: text },
    );
    await execute('UPDATE tickets SET updated_at = now() WHERE id = :id', { id: ticket.id });
    await notifyUsers([ticket.requesterUserId !== req.user!.id ? ticket.requesterUserId : ticket.assigneeUserId],
      { kind: 'ticket', title: `تعليق جديد على ${ticket.refNo}`, body: text.slice(0, 200), link: ticket.requesterUserId !== req.user!.id ? '/my-tickets' : '/tickets' });
    res.status(201).json({ data: { id: ticket.id } });
  }
}

export default TicketController;
