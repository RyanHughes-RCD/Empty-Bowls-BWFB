import { z } from 'zod';
import { type AuthUser, can } from '../auth/permissions.js';
import { today } from '../config.js';
import { type Db, pool, withTransaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { dateSchema, optionalText, parse, requiredText } from '../lib/validation.js';
import { assertDonationAccess } from './access.js';
import { audit } from './audit.js';
import { assertAssignableUser } from './donations.js';
import { notify } from './notifications.js';

const TASK_SELECT = `
  SELECT t.*, u.name AS assigned_to_name, cb.name AS created_by_name, compb.name AS completed_by_name,
         d.description AS donation_description, d.category AS donation_category, dn.id AS donor_id, dn.name AS donor_name,
         e.name AS event_name
  FROM follow_up_tasks t
  LEFT JOIN users u ON u.id = t.assigned_to
  LEFT JOIN users cb ON cb.id = t.created_by
  LEFT JOIN users compb ON compb.id = t.completed_by
  LEFT JOIN donations d ON d.id = t.donation_id
  LEFT JOIN donors dn ON dn.id = d.donor_id
  LEFT JOIN events e ON e.id = t.event_id`;

function decorate(t: Record<string, unknown>) {
  const open = t.status === 'open' || t.status === 'in_progress';
  const due = t.due_date as string | null;
  return { ...t, overdue: Boolean(open && due && due < today()), due_today: Boolean(open && due === today()) };
}

export const taskFilterSchema = z.object({
  scope: z.enum(['mine', 'all']).default('mine'),
  assigned_to: z.coerce.number().int().positive().optional(),
  event_id: z.coerce.number().int().positive().optional(),
  donation_id: z.coerce.number().int().positive().optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  status: z.enum(['open', 'completed', 'cancelled', 'all']).default('open'),
  due: z.enum(['overdue', 'today', 'upcoming']).optional(),
  task_type: z.enum(['follow_up', 'pickup', 'receipt', 'thank_you', 'info_request', 'general']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

export async function listTasks(user: AuthUser, query: unknown) {
  const f = parse(taskFilterSchema, query);
  const params: unknown[] = [];
  const where: string[] = [];
  if (f.scope === 'all' && can(user, 'tasks.view_all')) {
    if (f.assigned_to) {
      params.push(f.assigned_to);
      where.push(`t.assigned_to = $${params.length}`);
    }
  } else {
    params.push(user.id);
    where.push(`t.assigned_to = $${params.length}`);
  }
  if (f.event_id) {
    params.push(f.event_id);
    where.push(`t.event_id = $${params.length}`);
  }
  if (f.donation_id) {
    params.push(f.donation_id);
    where.push(`t.donation_id = $${params.length}`);
  }
  if (f.from) {
    params.push(f.from);
    where.push(`t.due_date >= $${params.length}`);
  }
  if (f.to) {
    params.push(f.to);
    where.push(`t.due_date <= $${params.length}`);
  }
  if (f.priority) {
    params.push(f.priority);
    where.push(`t.priority = $${params.length}`);
  }
  if (f.task_type) {
    params.push(f.task_type);
    where.push(`t.task_type = $${params.length}`);
  }
  if (f.status === 'open') where.push(`t.status IN ('open','in_progress')`);
  else if (f.status !== 'all') {
    params.push(f.status);
    where.push(`t.status = $${params.length}`);
  }
  if (f.due) {
    params.push(today());
    const p = `$${params.length}`;
    if (f.due === 'overdue') where.push(`t.due_date < ${p} AND t.status IN ('open','in_progress')`);
    if (f.due === 'today') where.push(`t.due_date = ${p} AND t.status IN ('open','in_progress')`);
    if (f.due === 'upcoming') where.push(`t.due_date > ${p}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await pool.query(`SELECT count(*)::int AS n FROM follow_up_tasks t ${whereSql}`, params)).rows[0].n;
  params.push(f.page_size, (f.page - 1) * f.page_size);
  const { rows } = await pool.query(
    `${TASK_SELECT} ${whereSql}
     ORDER BY (t.status IN ('open','in_progress')) DESC, t.due_date ASC NULLS LAST,
              CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { total, page: f.page, pageSize: f.page_size, rows: rows.map(decorate) };
}

function canManageTask(user: AuthUser, task: { assigned_to: number | null; created_by: number | null }) {
  return can(user, 'tasks.manage') || task.assigned_to === user.id || task.created_by === user.id;
}

export async function getTask(id: number, user: AuthUser) {
  const t = (await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [id])).rows[0];
  if (!t) throw notFound('Task not found.');
  if (!canManageTask(user, t) && !can(user, 'tasks.view_all')) throw forbidden('You do not have access to this task.');
  const events = await pool.query(
    `SELECT te.id, te.action, te.detail, te.created_at, u.name AS actor_name FROM task_events te
     LEFT JOIN users u ON u.id = te.actor_id WHERE te.task_id = $1 ORDER BY te.created_at, te.id`,
    [id],
  );
  return { task: decorate(t), events: events.rows };
}

export const createTaskSchema = z.object({
  donation_id: z.coerce.number().int().positive().nullable().optional(),
  event_id: z.coerce.number().int().positive().nullable().optional(),
  description: requiredText(1000, 'Task description'),
  due_date: dateSchema,
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  task_type: z.enum(['follow_up', 'pickup', 'receipt', 'thank_you', 'info_request', 'general']).default('general'),
  assigned_to: z.coerce.number().int().positive().nullable().optional(),
});

export async function createTask(body: unknown, user: AuthUser) {
  const input = parse(createTaskSchema, body);
  const assignee = input.assigned_to ?? user.id;
  if (assignee !== user.id && !can(user, 'tasks.manage') && !can(user, 'donations.assign')) {
    throw forbidden('You can only create tasks for yourself.');
  }
  return withTransaction(async (db) => {
    if (input.donation_id) {
      await assertDonationAccess(user, input.donation_id, db);
      if (!can(user, 'donations.edit_assigned') && !can(user, 'donations.edit_all') && !can(user, 'tasks.manage')) {
        throw forbidden('You are not authorized to add tasks to donations.');
      }
    }
    await assertAssignableUser(assignee, db);
    const { rows } = await db.query(
      `INSERT INTO follow_up_tasks (donation_id, event_id, assigned_to, description, due_date, priority, task_type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [input.donation_id ?? null, input.event_id ?? null, assignee, input.description, input.due_date, input.priority, input.task_type, user.id],
    );
    await db.query(`INSERT INTO task_events (task_id, action, detail, actor_id) VALUES ($1, 'created', NULL, $2)`, [rows[0].id, user.id]);
    if (assignee !== user.id) {
      await notify([assignee], 'task', `New task assigned to you: ${input.description}`, `/app/tasks`, db);
    }
    await audit({ userId: user.id, action: 'task.create', recordType: 'task', recordId: rows[0].id, summary: input.description.slice(0, 200) }, db);
    return rows[0];
  });
}

export const taskActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('complete'), outcome: optionalText(2000) }),
  z.object({ action: z.literal('reopen') }),
  z.object({ action: z.literal('start') }),
  z.object({ action: z.literal('reschedule'), due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date') }),
  z.object({ action: z.literal('reassign'), assigned_to: z.coerce.number().int().positive() }),
  z.object({ action: z.literal('cancel'), reason: optionalText(1000) }),
  z.object({ action: z.literal('note'), text: requiredText(3000, 'Note') }),
  z.object({ action: z.literal('update'), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), description: optionalText(1000).optional() }),
]);

async function logEvent(db: Db, taskId: number, action: string, detail: string | null, userId: number) {
  await db.query('INSERT INTO task_events (task_id, action, detail, actor_id) VALUES ($1, $2, $3, $4)', [taskId, action, detail, userId]);
}

export async function applyTaskAction(id: number, body: unknown, user: AuthUser) {
  const input = parse(taskActionSchema, body);
  return withTransaction(async (db) => {
    const task = (await db.query('SELECT * FROM follow_up_tasks WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!task) throw notFound('Task not found.');
    if (!canManageTask(user, task)) throw forbidden('You can only update tasks assigned to you.');
    const isOpen = task.status === 'open' || task.status === 'in_progress';

    switch (input.action) {
      case 'complete': {
        if (!isOpen) throw conflict('This task is already closed.');
        await db.query(
          `UPDATE follow_up_tasks SET status = 'completed', completed_at = now(), completed_by = $2, outcome = $3, updated_at = now() WHERE id = $1`,
          [id, user.id, input.outcome],
        );
        await logEvent(db, id, 'completed', input.outcome, user.id);
        // Completing the "next follow-up" clears the donation's NextFollowUpDate; the task remains as history.
        if (task.is_next_follow_up) {
          await db.query('UPDATE donations SET next_follow_up_date = NULL, updated_at = now() WHERE id = $1 AND next_follow_up_date = $2', [
            task.donation_id,
            task.due_date,
          ]);
        }
        break;
      }
      case 'reopen': {
        if (isOpen) throw conflict('This task is already open.');
        if (task.is_next_follow_up) {
          const other = await db.query(
            `SELECT 1 FROM follow_up_tasks WHERE donation_id = $1 AND is_next_follow_up AND status IN ('open','in_progress')`,
            [task.donation_id],
          );
          if (other.rows.length) throw conflict('This donation already has an open follow-up. Reschedule that one instead.');
          await db.query('UPDATE donations SET next_follow_up_date = $2 WHERE id = $1', [task.donation_id, task.due_date]);
        }
        await db.query(`UPDATE follow_up_tasks SET status = 'open', completed_at = NULL, completed_by = NULL, updated_at = now() WHERE id = $1`, [id]);
        await logEvent(db, id, 'reopened', null, user.id);
        break;
      }
      case 'start': {
        if (!isOpen) throw conflict('This task is closed.');
        await db.query(`UPDATE follow_up_tasks SET status = 'in_progress', updated_at = now() WHERE id = $1`, [id]);
        await logEvent(db, id, 'started', null, user.id);
        break;
      }
      case 'reschedule': {
        if (!isOpen) throw conflict('Only open tasks can be rescheduled.');
        await db.query('UPDATE follow_up_tasks SET due_date = $2, updated_at = now() WHERE id = $1', [id, input.due_date]);
        await logEvent(db, id, 'rescheduled', `Due date changed from ${task.due_date ?? 'none'} to ${input.due_date}`, user.id);
        if (task.is_next_follow_up) {
          await db.query('UPDATE donations SET next_follow_up_date = $2, updated_at = now() WHERE id = $1', [task.donation_id, input.due_date]);
        }
        break;
      }
      case 'reassign': {
        if (!can(user, 'tasks.manage') && !can(user, 'donations.assign')) throw forbidden('You are not permitted to reassign tasks.');
        if (!isOpen) throw conflict('Only open tasks can be reassigned.');
        await assertAssignableUser(input.assigned_to, db);
        const name = (await db.query('SELECT name FROM users WHERE id = $1', [input.assigned_to])).rows[0].name;
        await db.query('UPDATE follow_up_tasks SET assigned_to = $2, updated_at = now() WHERE id = $1', [id, input.assigned_to]);
        await logEvent(db, id, 'reassigned', `Reassigned to ${name}`, user.id);
        await notify([input.assigned_to], 'task', `A task was assigned to you: ${task.description}`, '/app/tasks', db);
        break;
      }
      case 'cancel': {
        if (!isOpen) throw conflict('This task is already closed.');
        await db.query(`UPDATE follow_up_tasks SET status = 'cancelled', outcome = $2, updated_at = now() WHERE id = $1`, [
          id,
          input.reason ?? 'No longer required',
        ]);
        await logEvent(db, id, 'cancelled', input.reason ?? 'No longer required', user.id);
        if (task.is_next_follow_up) {
          await db.query('UPDATE donations SET next_follow_up_date = NULL, updated_at = now() WHERE id = $1 AND next_follow_up_date = $2', [
            task.donation_id,
            task.due_date,
          ]);
        }
        break;
      }
      case 'note': {
        await logEvent(db, id, 'note', input.text, user.id);
        break;
      }
      case 'update': {
        if (input.description === null) throw badRequest('Description cannot be empty.');
        await db.query(
          'UPDATE follow_up_tasks SET priority = COALESCE($2, priority), description = COALESCE($3, description), updated_at = now() WHERE id = $1',
          [id, input.priority ?? null, input.description ?? null],
        );
        await logEvent(db, id, 'updated', [input.priority && `Priority: ${input.priority}`, input.description && 'Description edited'].filter(Boolean).join('; '), user.id);
        break;
      }
    }
    await audit({ userId: user.id, action: `task.${input.action}`, recordType: 'task', recordId: id, summary: task.description.slice(0, 200) }, db);
    return (await db.query('SELECT * FROM follow_up_tasks WHERE id = $1', [id])).rows[0];
  });
}
