import { z } from 'zod';
import { type AuthUser, can } from '../auth/permissions.js';
import { today } from '../config.js';
import { type Db, pool } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import {
  CATEGORIES,
  SUBCATEGORIES,
  dateSchema,
  moneySchema,
  optionalText,
  parse,
  quantitySchema,
  reconcileSubcategory,
  requiredText,
} from '../lib/validation.js';
import { assertDonationAccess, canSeeContacts, canSeeNotes } from './access.js';
import { audit, diff } from './audit.js';

/** Statuses only reviewers / full editors may set. */
export const REVIEW_STATUSES = ['new_submission', 'pending_review', 'awaiting_donor_info', 'approved', 'declined'];

/** Forward-only automatic progression used by quick actions. */
const WORKFLOW_ORDER = ['approved', 'follow_up_required', 'confirmed', 'pickup_scheduled', 'item_received', 'thank_you_pending', 'complete'];

export const DONATION_SELECT = `
  SELECT d.*,
         e.name AS event_name, e.code AS event_code, e.status AS event_status,
         dn.name AS donor_name, dn.contact_name, dn.contact_email, dn.contact_phone,
         dn.website AS donor_website, dn.social_media AS donor_social_media, dn.public_display_name AS donor_public_display_name,
         s.label AS status_label,
         au.name AS assigned_to_name,
         rb.name AS received_by_name,
         tb.name AS thank_you_sent_by_name,
         ab.name AS approved_by_name,
         pb.name AS published_by_name,
         cb.name AS created_by_name,
         sub.reference AS submission_reference
  FROM donations d
  JOIN events e ON e.id = d.event_id
  JOIN donors dn ON dn.id = d.donor_id
  JOIN donation_statuses s ON s.code = d.status
  LEFT JOIN users au ON au.id = d.assigned_to
  LEFT JOIN users rb ON rb.id = d.received_by
  LEFT JOIN users tb ON tb.id = d.thank_you_sent_by
  LEFT JOIN users ab ON ab.id = d.approved_by
  LEFT JOIN users pb ON pb.id = d.published_by
  LEFT JOIN users cb ON cb.id = d.created_by
  LEFT JOIN donation_submissions sub ON sub.id = d.submission_id`;

const PRIVATE_CONTACT_FIELDS = [
  'contact_name',
  'contact_email',
  'contact_phone',
  'donor_social_media',
  'pickup_address',
  'pickup_instructions',
  'pickup_preferred_dates',
];

/** Field-level redaction of a donation row for the given user. */
export function serializeDonation(row: Record<string, unknown>, user: AuthUser) {
  const out: Record<string, unknown> = { ...row };
  if (!canSeeContacts(user)) {
    for (const f of PRIVATE_CONTACT_FIELDS) out[f] = null;
    out.contact_hidden = true;
  }
  const d = row.next_follow_up_date as string | null;
  out.follow_up_overdue = Boolean(d && d < today());
  out.follow_up_due_today = d === today();
  return out;
}

export async function getDonationRow(id: number, db: Db = pool) {
  const { rows } = await db.query(`${DONATION_SELECT} WHERE d.id = $1`, [id]);
  if (!rows[0]) throw notFound('Donation not found.');
  return rows[0];
}

/** Full detail view of a donation, with everything the user is allowed to see. */
export async function getDonationDetail(id: number, user: AuthUser) {
  await assertDonationAccess(user, id);
  const row = await getDonationRow(id);
  const donation = serializeDonation(row, user);
  const [notes, tasks, statusHistory, media, thankYous, shares, submission, auditRows] = await Promise.all([
    canSeeNotes(user)
      ? pool.query(
          `SELECT n.id, n.note_text, n.created_at, n.author_id, u.name AS author_name
           FROM donation_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.donation_id = $1 ORDER BY n.created_at DESC`,
          [id],
        )
      : null,
    pool.query(
      `SELECT t.*, u.name AS assigned_to_name, cu.name AS completed_by_name
       FROM follow_up_tasks t LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN users cu ON cu.id = t.completed_by
       WHERE t.donation_id = $1 ORDER BY (t.status IN ('open','in_progress')) DESC, t.due_date NULLS LAST, t.id DESC`,
      [id],
    ),
    pool.query(
      `SELECT h.*, u.name AS changed_by_name FROM donation_status_history h LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.donation_id = $1 ORDER BY h.changed_at DESC, h.id DESC`,
      [id],
    ),
    pool.query(
      `SELECT id, alt_text, is_public, sort_order, mime_type, created_at FROM donation_media
       WHERE donation_id = $1 ORDER BY sort_order, created_at`,
      [id],
    ),
    can(user, 'donations.thank_you') || can(user, 'donations.edit_all')
      ? pool.query(
          `SELECT m.*, cu.name AS created_by_name, su.name AS sent_by_name FROM thank_you_messages m
           LEFT JOIN users cu ON cu.id = m.created_by LEFT JOIN users su ON su.id = m.sent_by
           WHERE m.donation_id = $1 ORDER BY m.created_at DESC`,
          [id],
        )
      : null,
    can(user, 'donations.assign')
      ? pool.query(
          `SELECT s.user_id, u.name, s.created_at FROM donation_shares s JOIN users u ON u.id = s.user_id WHERE s.donation_id = $1`,
          [id],
        )
      : null,
    row.submission_id && can(user, 'submissions.review')
      ? pool.query(
          `SELECT id, reference, source, status, submitted_at, submission_data, reviewed_data, review_comments, public_consent
           FROM donation_submissions WHERE id = $1`,
          [row.submission_id],
        )
      : null,
    can(user, 'audit.view') || can(user, 'donations.edit_all')
      ? pool.query(
          `SELECT a.id, a.action, a.summary, a.created_at, u.name AS user_name FROM audit_log a
           LEFT JOIN users u ON u.id = a.user_id
           WHERE a.record_type = 'donation' AND a.record_id = $1 ORDER BY a.created_at DESC LIMIT 100`,
          [String(id)],
        )
      : null,
  ]);
  if (!canSeeContacts(user) && thankYous) for (const t of thankYous.rows) t.recipient = null;
  return {
    donation,
    notes: notes?.rows ?? null,
    tasks: tasks.rows,
    statusHistory: statusHistory.rows,
    media: media.rows,
    thankYouMessages: thankYous?.rows ?? null,
    shares: shares?.rows ?? null,
    submission: submission?.rows[0] ?? null,
    audit: auditRows?.rows ?? null,
    permissions: donationPermissions(user, row),
  };
}

/** What the user may do with this particular donation (used by the UI; enforced again on every write). */
export function donationPermissions(user: AuthUser, _row?: Record<string, unknown>) {
  const editAll = can(user, 'donations.edit_all');
  const editAssigned = editAll || can(user, 'donations.edit_assigned');
  return {
    editAll,
    editAssigned,
    editPickup: editAssigned && canSeeContacts(user),
    assign: can(user, 'donations.assign'),
    receive: can(user, 'donations.receive'),
    thankYou: can(user, 'donations.thank_you'),
    publish: can(user, 'publication.manage'),
    requestPublication: editAll,
    archive: can(user, 'donations.archive'),
    notes: canSeeNotes(user),
    contacts: canSeeContacts(user),
    tasks: editAssigned,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export const donationFieldsSchema = z.object({
  event_id: z.coerce.number().int().positive({ error: 'Choose an event' }),
  category: z.enum(CATEGORIES, { error: 'Choose a donation category' }),
  subcategory: z.enum(SUBCATEGORIES).nullable().optional(),
  description: requiredText(5000, 'Description'),
  quantity: quantitySchema,
  estimated_value_cad: moneySchema,
  value_is_estimate: z.boolean().default(false),
});

export function checkCategory<T extends { category: string; subcategory?: string | null }>(data: T): T {
  const sub = reconcileSubcategory(data.category, data.subcategory);
  if (data.category === 'food' && !sub) {
    throw badRequest('Please correct the highlighted fields.', { fields: { subcategory: 'Choose Soup, Bread or Dessert' } });
  }
  return { ...data, subcategory: sub };
}

export async function assertEventUsable(eventId: number, db: Db, opts: { allowClosed?: boolean } = {}) {
  const ev = (await db.query('SELECT id, name, status FROM events WHERE id = $1', [eventId])).rows[0];
  if (!ev) throw badRequest('Please correct the highlighted fields.', { fields: { event_id: 'Event not found' } });
  if (ev.status === 'archived' || (!opts.allowClosed && ev.status === 'closed')) {
    throw badRequest('Please correct the highlighted fields.', {
      fields: { event_id: `"${ev.name}" is ${ev.status}; donations cannot be added to it.` },
    });
  }
  return ev;
}

export async function insertDonation(
  db: Db,
  data: {
    event_id: number;
    donor_id: number;
    submission_id?: number | null;
    category: string;
    subcategory: string | null;
    description: string;
    quantity: number;
    estimated_value_cad: number | null;
    value_is_estimate?: boolean;
    status: string;
    assigned_to?: number | null;
    delivery_method?: string;
    pickup_address?: string | null;
    pickup_instructions?: string | null;
    pickup_preferred_dates?: string | null;
    public_consent?: boolean;
    public_consent_source?: string | null;
    approved?: boolean;
  },
  actor: AuthUser,
) {
  const { rows } = await db.query(
    `INSERT INTO donations (event_id, donor_id, submission_id, category, subcategory, description, quantity,
       estimated_value_cad, value_is_estimate, status, assigned_to, delivery_method, pickup_address,
       pickup_instructions, pickup_preferred_dates, public_consent, public_consent_source,
       public_consent_recorded_at, public_consent_recorded_by, created_by, approved_by, approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
       CASE WHEN $16 THEN now() END, CASE WHEN $16 THEN $18::int END, $18, CASE WHEN $19 THEN $18::int END, CASE WHEN $19 THEN now() END)
     RETURNING *`,
    [
      data.event_id,
      data.donor_id,
      data.submission_id ?? null,
      data.category,
      data.subcategory,
      data.description,
      data.quantity,
      data.estimated_value_cad,
      data.value_is_estimate ?? false,
      data.status,
      data.assigned_to ?? null,
      data.delivery_method ?? 'undecided',
      data.pickup_address ?? null,
      data.pickup_instructions ?? null,
      data.pickup_preferred_dates ?? null,
      data.public_consent ?? false,
      data.public_consent_source ?? null,
      actor.id,
      data.approved ?? false,
    ],
  );
  const donation = rows[0];
  await db.query(
    'INSERT INTO donation_status_history (donation_id, from_status, to_status, changed_by, comment) VALUES ($1, NULL, $2, $3, $4)',
    [donation.id, donation.status, actor.id, data.submission_id ? 'Created from approved submission' : 'Created'],
  );
  return donation;
}

// ---------------------------------------------------------------------------
// Update (PATCH) with field-level permission checks
// ---------------------------------------------------------------------------
const updateSchema = z.object({
  event_id: z.coerce.number().int().positive(),
  donor_id: z.coerce.number().int().positive(),
  category: z.enum(CATEGORIES),
  subcategory: z.enum(SUBCATEGORIES).nullable(),
  description: requiredText(5000, 'Description'),
  quantity: quantitySchema,
  estimated_value_cad: moneySchema,
  value_is_estimate: z.boolean(),
  status: z.string().regex(/^[a-z_]{2,40}$/),
  next_follow_up_date: dateSchema,
  assigned_to: z.coerce.number().int().positive().nullable(),
  delivery_method: z.enum(['donor_delivers', 'pickup_required', 'undecided']),
  pickup_address: optionalText(1000),
  pickup_instructions: optionalText(3000),
  pickup_preferred_dates: optionalText(1000),
  pickup_scheduled_for: z
    .union([z.string(), z.null()])
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || !Number.isNaN(Date.parse(v)), { message: 'Enter a valid date and time' }),
  thank_you_required: z.boolean(),
});

type FieldRule = 'edit_all' | 'assigned' | 'pickup' | 'assign';
const FIELD_RULES: Record<keyof z.infer<typeof updateSchema>, FieldRule> = {
  event_id: 'edit_all',
  donor_id: 'edit_all',
  category: 'edit_all',
  subcategory: 'edit_all',
  value_is_estimate: 'edit_all',
  description: 'assigned',
  quantity: 'assigned',
  estimated_value_cad: 'assigned',
  status: 'assigned',
  next_follow_up_date: 'assigned',
  thank_you_required: 'assigned',
  delivery_method: 'pickup',
  pickup_address: 'pickup',
  pickup_instructions: 'pickup',
  pickup_preferred_dates: 'pickup',
  pickup_scheduled_for: 'pickup',
  assigned_to: 'assign',
};

function allowedByRule(user: AuthUser, rule: FieldRule): boolean {
  const editAll = can(user, 'donations.edit_all');
  const assigned = editAll || can(user, 'donations.edit_assigned');
  switch (rule) {
    case 'edit_all':
      return editAll;
    case 'assigned':
      return assigned;
    case 'pickup':
      return assigned && canSeeContacts(user);
    case 'assign':
      return can(user, 'donations.assign');
  }
}

export async function assertAssignableUser(userId: number, db: Db) {
  const u = (await db.query(`SELECT id FROM users WHERE id = $1 AND account_status = 'active'`, [userId])).rows[0];
  if (!u) throw badRequest('Please correct the highlighted fields.', { fields: { assigned_to: 'Choose an active user' } });
}

export async function updateDonation(
  id: number,
  body: Record<string, unknown>,
  user: AuthUser,
  db: Db,
  opts: { statusComment?: string | null; confirmEventChange?: boolean } = {},
) {
  await assertDonationAccess(user, id, db);
  const keys = Object.keys(body).filter((k) => k in FIELD_RULES) as (keyof typeof FIELD_RULES)[];
  if (!keys.length) throw badRequest('No changes were provided.');
  const denied = keys.filter((k) => !allowedByRule(user, FIELD_RULES[k]));
  if (denied.length) throw forbidden(`You do not have permission to change: ${denied.join(', ')}.`);

  const shape = Object.fromEntries(keys.map((k) => [k, updateSchema.shape[k]]));
  const patch = parse(z.object(shape), body) as Record<string, unknown>;

  const current = (await db.query('SELECT * FROM donations WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (current.is_archived) throw conflict('This donation is archived. Restore it before editing.');
  const next: Record<string, unknown> = { ...current, ...patch };

  // Category rule: SubCategory only for Food; changing away from Food clears it.
  if ('category' in patch || 'subcategory' in patch) {
    const checked = checkCategory({ category: next.category as string, subcategory: next.subcategory as string | null });
    next.subcategory = checked.subcategory;
  }
  if ('event_id' in patch && patch.event_id !== current.event_id) {
    if (!opts.confirmEventChange) {
      throw badRequest('Moving a donation to a different event must be confirmed.', {
        fields: { event_id: 'Confirm that you want to move this donation to another event.' },
      });
    }
    await assertEventUsable(patch.event_id as number, db, { allowClosed: true });
  }
  if ('donor_id' in patch) {
    const d = (await db.query('SELECT merged_into_id FROM donors WHERE id = $1', [patch.donor_id])).rows[0];
    if (!d || d.merged_into_id) throw badRequest('Please correct the highlighted fields.', { fields: { donor_id: 'Choose a valid donor' } });
  }
  if ('assigned_to' in patch && patch.assigned_to) await assertAssignableUser(patch.assigned_to as number, db);
  if ('status' in patch && patch.status !== current.status) {
    const st = (await db.query('SELECT code, is_active FROM donation_statuses WHERE code = $1', [patch.status])).rows[0];
    if (!st || !st.is_active) throw badRequest('Please correct the highlighted fields.', { fields: { status: 'Choose a valid status' } });
    if (!can(user, 'donations.edit_all') && (REVIEW_STATUSES.includes(patch.status as string) || REVIEW_STATUSES.includes(current.status))) {
      throw forbidden('Only administrators can approve, decline or return a donation to review.');
    }
  }

  const changes = diff(current, next, Object.keys(FIELD_RULES));
  if (!Object.keys(changes).length) return current;

  const { rows } = await db.query(
    `UPDATE donations SET event_id=$2, donor_id=$3, category=$4, subcategory=$5, description=$6, quantity=$7,
       estimated_value_cad=$8, value_is_estimate=$9, status=$10, next_follow_up_date=$11, assigned_to=$12,
       delivery_method=$13, pickup_address=$14, pickup_instructions=$15, pickup_preferred_dates=$16,
       pickup_scheduled_for=$17, thank_you_required=$18,
       thank_you_stage = CASE WHEN $18 = false AND thank_you_stage <> 'sent' THEN 'not_required'
                              WHEN $18 = true AND thank_you_stage = 'not_required' THEN 'not_started'
                              ELSE thank_you_stage END,
       updated_at=now()
     WHERE id=$1 RETURNING *`,
    [
      id,
      next.event_id,
      next.donor_id,
      next.category,
      next.subcategory,
      next.description,
      next.quantity,
      next.estimated_value_cad,
      next.value_is_estimate,
      next.status,
      next.next_follow_up_date,
      next.assigned_to,
      next.delivery_method,
      next.pickup_address,
      next.pickup_instructions,
      next.pickup_preferred_dates,
      next.pickup_scheduled_for,
      next.thank_you_required,
    ],
  );
  const updated = rows[0];

  if (changes.status) {
    await db.query(
      'INSERT INTO donation_status_history (donation_id, from_status, to_status, changed_by, comment) VALUES ($1,$2,$3,$4,$5)',
      [id, current.status, updated.status, user.id, opts.statusComment ?? null],
    );
  }
  if (changes.next_follow_up_date || changes.assigned_to) {
    await syncNextFollowUp(db, {
      donationId: id,
      date: updated.next_follow_up_date,
      assigneeChangedTo: changes.assigned_to ? updated.assigned_to : undefined,
      actor: user,
    });
  }
  const sensitive = ['pickup_address', 'pickup_instructions', 'pickup_preferred_dates'];
  await audit(
    {
      userId: user.id,
      action: 'donation.update',
      recordType: 'donation',
      recordId: id,
      summary: `Updated ${Object.keys(changes).join(', ')}`,
      details: Object.fromEntries(
        Object.entries(changes).map(([k, v]) => [k, sensitive.includes(k) ? { changed: true } : v]),
      ),
    },
    db,
  );
  return updated;
}

// ---------------------------------------------------------------------------
// NextFollowUpDate <-> To Do task synchronization
// ---------------------------------------------------------------------------
/**
 * Keeps exactly one open "next follow-up" task per donation in sync with
 * donations.next_follow_up_date. Re-saving never creates duplicates (also
 * guaranteed by a partial unique index). Completed tasks remain as history.
 */
export async function syncNextFollowUp(
  db: Db,
  opts: { donationId: number; date: string | null; assigneeChangedTo?: number | null; actor: AuthUser },
) {
  const open = (
    await db.query(
      `SELECT * FROM follow_up_tasks WHERE donation_id = $1 AND is_next_follow_up AND status IN ('open','in_progress') FOR UPDATE`,
      [opts.donationId],
    )
  ).rows[0];
  const donation = (
    await db.query('SELECT d.id, d.assigned_to, dn.name AS donor_name FROM donations d JOIN donors dn ON dn.id = d.donor_id WHERE d.id = $1', [
      opts.donationId,
    ])
  ).rows[0];

  if (!opts.date) {
    if (open) {
      await db.query(
        `UPDATE follow_up_tasks SET status = 'cancelled', outcome = 'Follow-up date cleared (no longer required)', updated_at = now() WHERE id = $1`,
        [open.id],
      );
      await db.query(`INSERT INTO task_events (task_id, action, detail, actor_id) VALUES ($1, 'cancelled', $2, $3)`, [
        open.id,
        'Follow-up date was cleared on the donation',
        opts.actor.id,
      ]);
    }
    return null;
  }

  if (open) {
    const assignee = opts.assigneeChangedTo !== undefined ? (opts.assigneeChangedTo ?? open.assigned_to) : open.assigned_to;
    if (open.due_date !== opts.date) {
      await db.query(`INSERT INTO task_events (task_id, action, detail, actor_id) VALUES ($1, 'rescheduled', $2, $3)`, [
        open.id,
        `Due date changed from ${open.due_date ?? 'none'} to ${opts.date}`,
        opts.actor.id,
      ]);
    }
    if (assignee !== open.assigned_to) {
      await db.query(`INSERT INTO task_events (task_id, action, detail, actor_id) VALUES ($1, 'reassigned', $2, $3)`, [
        open.id,
        `Reassigned to user #${assignee}`,
        opts.actor.id,
      ]);
    }
    const { rows } = await db.query(
      'UPDATE follow_up_tasks SET due_date = $2, assigned_to = $3, updated_at = now() WHERE id = $1 RETURNING *',
      [open.id, opts.date, assignee],
    );
    return rows[0];
  }

  const assignee = donation.assigned_to ?? opts.actor.id;
  const { rows } = await db.query(
    `INSERT INTO follow_up_tasks (donation_id, assigned_to, description, due_date, priority, task_type, is_next_follow_up, created_by)
     VALUES ($1, $2, $3, $4, 'normal', 'follow_up', true, $5) RETURNING *`,
    [opts.donationId, assignee, `Follow up with ${donation.donor_name} about donation #${opts.donationId}`, opts.date, opts.actor.id],
  );
  await db.query(`INSERT INTO task_events (task_id, action, detail, actor_id) VALUES ($1, 'created', $2, $3)`, [
    rows[0].id,
    `Created from the donation's Next Follow-Up Date (${opts.date})`,
    opts.actor.id,
  ]);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------
async function advanceStatus(db: Db, donationId: number, target: string, actor: AuthUser, comment: string) {
  const cur = (await db.query('SELECT status FROM donations WHERE id = $1', [donationId])).rows[0].status as string;
  const ci = WORKFLOW_ORDER.indexOf(cur);
  const ti = WORKFLOW_ORDER.indexOf(target);
  if (ci === -1 || ti <= ci) return;
  await db.query('UPDATE donations SET status = $2, updated_at = now() WHERE id = $1', [donationId, target]);
  await db.query(
    'INSERT INTO donation_status_history (donation_id, from_status, to_status, changed_by, comment) VALUES ($1,$2,$3,$4,$5)',
    [donationId, cur, target, actor.id, comment],
  );
}

async function loadForAction(id: number, user: AuthUser, db: Db) {
  await assertDonationAccess(user, id, db);
  const row = (await db.query('SELECT * FROM donations WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (row.is_archived) throw conflict('This donation is archived.');
  if (REVIEW_STATUSES.includes(row.status) && row.status !== 'approved') throw conflict('This donation has not been approved.');
  return row;
}

export const receiveSchema = z.object({
  received: z.boolean().default(true),
  received_quantity: z.coerce.number().int().min(0).nullable().optional(),
  note: optionalText(2000),
});

export async function setItemReceived(id: number, input: z.infer<typeof receiveSchema>, user: AuthUser, db: Db) {
  if (!can(user, 'donations.receive')) throw forbidden('You are not authorized to record items as received.');
  const row = await loadForAction(id, user, db);
  if (input.received) {
    const qty = input.received_quantity ?? row.quantity;
    if (qty > row.quantity) throw badRequest('Received quantity cannot exceed the donated quantity.');
    const fullyReceived = qty >= row.quantity;
    await db.query(
      `UPDATE donations SET item_received = $2, received_quantity = $3, received_at = now(), received_by = $4, updated_at = now() WHERE id = $1`,
      [id, fullyReceived, qty, user.id],
    );
    if (fullyReceived) await advanceStatus(db, id, 'item_received', user, 'Item marked as received');
    await completeOpenTasksOfType(db, id, ['receipt', 'pickup'], user, 'Item received');
    await audit(
      {
        userId: user.id,
        action: 'donation.received',
        recordType: 'donation',
        recordId: id,
        summary: fullyReceived ? `Item received (${qty} of ${row.quantity})` : `Partially received (${qty} of ${row.quantity})`,
      },
      db,
    );
  } else {
    await db.query(
      `UPDATE donations SET item_received = false, received_quantity = NULL, received_at = NULL, received_by = NULL, updated_at = now() WHERE id = $1`,
      [id],
    );
    await audit({ userId: user.id, action: 'donation.received_undo', recordType: 'donation', recordId: id, summary: 'Item receipt reversed' }, db);
  }
  if (input.note) await addNote(id, input.note, user, db);
}

export const pickupSchema = z.object({
  pickup_scheduled_for: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date and time'),
  pickup_address: optionalText(1000),
  pickup_instructions: optionalText(3000),
  assign_task_to: z.coerce.number().int().positive().nullable().optional(),
});

export async function schedulePickup(id: number, input: z.infer<typeof pickupSchema>, user: AuthUser, db: Db) {
  const body: Record<string, unknown> = {
    pickup_scheduled_for: input.pickup_scheduled_for,
    delivery_method: 'pickup_required',
  };
  if (input.pickup_address !== null) body.pickup_address = input.pickup_address;
  if (input.pickup_instructions !== null) body.pickup_instructions = input.pickup_instructions;
  await loadForAction(id, user, db);
  await updateDonation(id, body, user, db);
  await advanceStatus(db, id, 'pickup_scheduled', user, 'Pickup scheduled');
  const assignee = input.assign_task_to ?? (await db.query('SELECT assigned_to FROM donations WHERE id = $1', [id])).rows[0].assigned_to ?? user.id;
  if (input.assign_task_to && input.assign_task_to !== user.id && !can(user, 'tasks.manage') && !can(user, 'donations.assign')) {
    throw forbidden('You cannot assign tasks to other users.');
  }
  const existing = (
    await db.query(`SELECT id FROM follow_up_tasks WHERE donation_id = $1 AND task_type = 'pickup' AND status IN ('open','in_progress')`, [id])
  ).rows[0];
  const due = input.pickup_scheduled_for.slice(0, 10);
  if (existing) {
    await db.query('UPDATE follow_up_tasks SET due_date = $2, assigned_to = $3, updated_at = now() WHERE id = $1', [existing.id, due, assignee]);
    await db.query(`INSERT INTO task_events (task_id, action, detail, actor_id) VALUES ($1, 'rescheduled', $2, $3)`, [
      existing.id,
      `Pickup rescheduled to ${input.pickup_scheduled_for}`,
      user.id,
    ]);
  } else {
    const t = await db.query(
      `INSERT INTO follow_up_tasks (donation_id, assigned_to, description, due_date, priority, task_type, created_by)
       VALUES ($1, $2, $3, $4, 'normal', 'pickup', $5) RETURNING id`,
      [id, assignee, `Pick up donation #${id}`, due, user.id],
    );
    await db.query(`INSERT INTO task_events (task_id, action, detail, actor_id) VALUES ($1, 'created', 'Created when pickup was scheduled', $2)`, [
      t.rows[0].id,
      user.id,
    ]);
  }
}

async function completeOpenTasksOfType(db: Db, donationId: number, types: string[], user: AuthUser, outcome: string) {
  const { rows } = await db.query(
    `UPDATE follow_up_tasks SET status = 'completed', completed_at = now(), completed_by = $3, outcome = $4, updated_at = now()
     WHERE donation_id = $1 AND task_type = ANY($2) AND status IN ('open','in_progress') RETURNING id`,
    [donationId, types, user.id, outcome],
  );
  for (const r of rows) {
    await db.query(`INSERT INTO task_events (task_id, action, detail, actor_id) VALUES ($1, 'completed', $2, $3)`, [r.id, outcome, user.id]);
  }
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
export async function addNote(donationId: number, text: string, user: AuthUser, db: Db = pool) {
  if (!canSeeNotes(user)) throw forbidden('You are not authorized to add notes.');
  await assertDonationAccess(user, donationId, db);
  const trimmed = text.trim();
  if (!trimmed) throw badRequest('Note cannot be empty.');
  if (trimmed.length > 5000) throw badRequest('Notes must be 5000 characters or fewer.');
  const { rows } = await db.query(
    'INSERT INTO donation_notes (donation_id, author_id, note_text) VALUES ($1, $2, $3) RETURNING id, note_text, created_at',
    [donationId, user.id, trimmed],
  );
  await audit({ userId: user.id, action: 'donation.note', recordType: 'donation', recordId: donationId, summary: 'Added an internal note' }, db);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Thank-you workflow
// ---------------------------------------------------------------------------
export async function assertThankYouAccess(id: number, user: AuthUser, db: Db) {
  if (!can(user, 'donations.thank_you')) throw forbidden('You are not authorized to manage thank-you messages.');
  return loadForAction(id, user, db);
}

export async function markThankYouSent(
  donationId: number,
  opts: { method: string; messageId?: number | null; notes?: string | null; sentAt?: string | null },
  user: AuthUser,
  db: Db,
) {
  const row = await assertThankYouAccess(donationId, user, db);
  if (row.thank_you_sent) throw conflict('A thank-you has already been recorded as sent for this donation.');
  const sentAt = opts.sentAt ?? new Date().toISOString();
  await db.query(
    `UPDATE donations SET thank_you_sent = true, thank_you_stage = 'sent', thank_you_sent_at = $2, thank_you_sent_by = $3,
       thank_you_method = $4, thank_you_notes = COALESCE($5, thank_you_notes), thank_you_required = true, updated_at = now()
     WHERE id = $1`,
    [donationId, sentAt, user.id, opts.method, opts.notes ?? null],
  );
  if (opts.messageId) {
    await db.query(`UPDATE thank_you_messages SET status = 'sent', sent_by = $2, sent_at = $3, updated_at = now() WHERE id = $1`, [
      opts.messageId,
      user.id,
      sentAt,
    ]);
  }
  const fresh = (await db.query('SELECT item_received FROM donations WHERE id = $1', [donationId])).rows[0];
  if (fresh.item_received) await advanceStatus(db, donationId, 'complete', user, 'Item received and thank-you sent');
  await completeOpenTasksOfType(db, donationId, ['thank_you'], user, 'Thank-you sent');
  await audit(
    { userId: user.id, action: 'donation.thank_you_sent', recordType: 'donation', recordId: donationId, summary: `Thank-you recorded as sent (${opts.method})` },
    db,
  );
}

// ---------------------------------------------------------------------------
// Publication (separate from operational status)
// ---------------------------------------------------------------------------
export const publicContentSchema = z.object({
  public_title: optionalText(200),
  public_description: optionalText(3000),
  show_donor_name: z.boolean(),
  show_website: z.boolean(),
  show_value: z.boolean(),
  show_quantity: z.boolean(),
});

export const consentSchema = z.object({
  public_consent: z.boolean(),
  source: optionalText(300),
});

export async function setConsent(id: number, input: z.infer<typeof consentSchema>, user: AuthUser, db: Db) {
  if (!can(user, 'publication.manage')) throw forbidden();
  const row = (await db.query('SELECT * FROM donations WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!row) throw notFound();
  if (!input.public_consent && row.publication_status === 'published') {
    await db.query(`UPDATE donations SET publication_status = 'withdrawn' WHERE id = $1`, [id]);
  }
  await db.query(
    `UPDATE donations SET public_consent = $2, public_consent_source = $3, public_consent_recorded_at = now(),
       public_consent_recorded_by = $4, updated_at = now() WHERE id = $1`,
    [id, input.public_consent, input.source ?? (input.public_consent ? 'Recorded by staff' : 'Consent withdrawn'), user.id],
  );
  await audit(
    {
      userId: user.id,
      action: input.public_consent ? 'donation.consent_recorded' : 'donation.consent_withdrawn',
      recordType: 'donation',
      recordId: id,
      summary: input.public_consent ? `Public recognition consent recorded (${input.source ?? 'staff'})` : 'Public recognition consent withdrawn (unpublished)',
    },
    db,
  );
}

export async function updatePublicContent(id: number, input: z.infer<typeof publicContentSchema>, user: AuthUser, db: Db) {
  const row = (await db.query('SELECT * FROM donations WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!row) throw notFound();
  if (!can(user, 'publication.manage') && !can(user, 'donations.edit_all')) throw forbidden();
  if (row.publication_status === 'published' && !can(user, 'publication.manage')) {
    throw forbidden('Only users who can publish may change the public content of a published donation.');
  }
  if (row.publication_status === 'published' && !input.public_description) {
    throw badRequest('A published donation must have a public description. Unpublish it first.');
  }
  await db.query(
    `UPDATE donations SET public_title=$2, public_description=$3, show_donor_name=$4, show_website=$5, show_value=$6,
       show_quantity=$7, updated_at=now() WHERE id=$1`,
    [id, input.public_title, input.public_description, input.show_donor_name, input.show_website, input.show_value, input.show_quantity],
  );
  await audit(
    { userId: user.id, action: 'donation.public_content', recordType: 'donation', recordId: id, summary: 'Updated public-facing content', details: diff(row, input) },
    db,
  );
}

export async function requestPublication(id: number, user: AuthUser, db: Db) {
  if (!can(user, 'donations.edit_all') && !can(user, 'publication.manage')) throw forbidden();
  const row = (await db.query('SELECT * FROM donations WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!row) throw notFound();
  if (row.publication_status === 'published') throw conflict('This donation is already published.');
  await db.query(`UPDATE donations SET publication_status = 'pending_publication_approval', updated_at = now() WHERE id = $1`, [id]);
  await audit({ userId: user.id, action: 'donation.publication_requested', recordType: 'donation', recordId: id, summary: 'Requested publication approval' }, db);
}

export async function publishDonation(id: number, user: AuthUser, db: Db, confirm: boolean) {
  if (!can(user, 'publication.manage')) throw forbidden('You do not have permission to publish donations.');
  if (!confirm) throw badRequest('Please confirm that this donation is authorized for publication.');
  const row = (
    await db.query(
      `SELECT d.*, s.publishable, e.status AS event_status FROM donations d
       JOIN donation_statuses s ON s.code = d.status JOIN events e ON e.id = d.event_id WHERE d.id = $1 FOR UPDATE OF d`,
      [id],
    )
  ).rows[0];
  if (!row) throw notFound();
  const problems: string[] = [];
  if (row.is_archived) problems.push('The donation is archived.');
  if (!row.publishable) problems.push('The donation has not been approved internally.');
  if (!row.public_consent) problems.push('Public recognition consent has not been recorded.');
  if (!row.public_description) problems.push('A public description must be written and reviewed.');
  if (row.event_status === 'archived') problems.push('The event is archived.');
  if (problems.length) throw conflict('This donation cannot be published yet.', { problems });
  await db.query(
    `UPDATE donations SET publication_status = 'published', published_at = now(), published_by = $2, updated_at = now() WHERE id = $1`,
    [id, user.id],
  );
  await audit({ userId: user.id, action: 'donation.publish', recordType: 'donation', recordId: id, summary: 'Published to the public gallery' }, db);
}

export async function unpublishDonation(id: number, user: AuthUser, db: Db, reason: string | null) {
  if (!can(user, 'publication.manage')) throw forbidden('You do not have permission to unpublish donations.');
  const row = (await db.query('SELECT publication_status FROM donations WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!row) throw notFound();
  const next = row.publication_status === 'published' ? 'withdrawn' : 'unpublished';
  await db.query('UPDATE donations SET publication_status = $2, updated_at = now() WHERE id = $1', [id, next]);
  await audit(
    { userId: user.id, action: 'donation.unpublish', recordType: 'donation', recordId: id, summary: `Removed from public gallery${reason ? `: ${reason}` : ''}` },
    db,
  );
}

export async function setArchived(id: number, archived: boolean, user: AuthUser, db: Db) {
  if (!can(user, 'donations.archive')) throw forbidden();
  const row = (await db.query('SELECT * FROM donations WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!row) throw notFound();
  await db.query(
    `UPDATE donations SET is_archived = $2, archived_at = CASE WHEN $2 THEN now() END, archived_by = CASE WHEN $2 THEN $3::int END,
       publication_status = CASE WHEN $2 AND publication_status = 'published' THEN 'withdrawn' ELSE publication_status END,
       next_follow_up_date = CASE WHEN $2 THEN NULL ELSE next_follow_up_date END,
       updated_at = now() WHERE id = $1`,
    [id, archived, user.id],
  );
  if (archived) {
    await db.query(
      `UPDATE follow_up_tasks SET status = 'cancelled', outcome = 'Donation archived', updated_at = now()
       WHERE donation_id = $1 AND status IN ('open','in_progress')`,
      [id],
    );
  }
  await audit(
    { userId: user.id, action: archived ? 'donation.archive' : 'donation.restore', recordType: 'donation', recordId: id, summary: archived ? 'Archived' : 'Restored from archive' },
    db,
  );
}
