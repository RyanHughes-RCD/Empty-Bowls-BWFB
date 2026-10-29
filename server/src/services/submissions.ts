import { z } from 'zod';
import { type AuthUser, can } from '../auth/permissions.js';
import { config } from '../config.js';
import { type Db, pool, withTransaction } from '../db/pool.js';
import { randomToken, sha256, submissionReference } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  SUBCATEGORIES,
  dateSchema,
  emailSchema,
  moneySchema,
  optionalPhone,
  optionalText,
  optionalUrl,
  parse,
  quantitySchema,
  requiredText,
  socialMediaSchema,
} from '../lib/validation.js';
import { canSeeContacts } from './access.js';
import { audit } from './audit.js';
import {
  assertAssignableUser,
  assertEventUsable,
  checkCategory,
  insertDonation,
  syncNextFollowUp,
} from './donations.js';
import { createDonor, donorInputSchema, findDuplicateDonors, updateDonor } from './donors.js';
import { sendEmail } from './email.js';
import { notify, usersWithPermission } from './notifications.js';
import { getSettings } from './settings.js';

/** Shape of the donation form (public and internal). Stored verbatim as the original snapshot. */
export const submissionSchema = z
  .object({
    event_id: z.coerce.number({ error: 'Choose an event' }).int().positive({ error: 'Choose an event' }),
    donor_name: requiredText(200, 'Business, donor or organization name'),
    contact_name: requiredText(200, 'Contact name'),
    contact_email: emailSchema,
    contact_phone: optionalPhone,
    website: optionalUrl,
    social_media: z
      .union([socialMediaSchema, z.string(), z.null()]).optional()
      .transform((v) => (typeof v === 'string' ? (v.trim() ? [{ platform: 'Other', handle: v.trim().slice(0, 300) }] : []) : (v ?? []))),
    category: z.enum(CATEGORIES, { error: 'Choose a donation category' }),
    subcategory: z
      .union([z.enum(SUBCATEGORIES), z.literal(''), z.null()]).optional()
      .transform((v) => (v ? v : null)),
    description: requiredText(5000, 'Description of the donation'),
    quantity: quantitySchema,
    estimated_value_cad: moneySchema,
    additional_info: optionalText(3000),
    delivery_method: z.enum(['donor_delivers', 'pickup_required', 'undecided'], { error: 'Tell us how the donation will reach us' }),
    pickup_address: optionalText(1000),
    availability: optionalText(1000),
    logistics_notes: optionalText(2000),
    public_consent: z.boolean().default(false),
    privacy_acknowledged: z.literal(true, { error: 'Please confirm that you have read the privacy notice' }),
  })
  .superRefine((v, ctx) => {
    if (v.category === 'food' && !v.subcategory) {
      ctx.addIssue({ code: 'custom', path: ['subcategory'], message: 'Choose Soup, Bread or Dessert' });
    }
    if (v.delivery_method === 'pickup_required' && !v.pickup_address) {
      ctx.addIssue({ code: 'custom', path: ['pickup_address'], message: 'Enter the pickup address' });
    }
  })
  .transform((v) => ({ ...v, subcategory: v.category === 'food' ? v.subcategory : null }));

export type SubmissionData = z.infer<typeof submissionSchema>;

async function uniqueReference(db: Db): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const ref = submissionReference();
    const exists = await db.query('SELECT 1 FROM donation_submissions WHERE reference = $1', [ref]);
    if (!exists.rows.length) return ref;
  }
  throw new Error('Could not generate a unique reference');
}

export async function createSubmission(opts: {
  data: SubmissionData;
  source: 'public_form' | 'internal';
  submittedBy: AuthUser | null;
  idempotencyKey: string | null;
  fingerprint: string | null;
  image?: { storageKey: string; mime: string; size: number; originalName?: string; altText?: string | null } | null;
}): Promise<{ id: number; reference: string; duplicate: boolean }> {
  const { data } = opts;
  // Idempotency: a resubmitted (double-clicked / retried) form returns the original reference.
  if (opts.idempotencyKey) {
    const existing = await pool.query('SELECT id, reference FROM donation_submissions WHERE idempotency_key = $1', [opts.idempotencyKey]);
    if (existing.rows[0]) return { ...existing.rows[0], duplicate: true };
  }
  const event = (await pool.query('SELECT id, name, status, accepting_submissions FROM events WHERE id = $1', [data.event_id])).rows[0];
  if (!event) throw badRequest('Please correct the highlighted fields.', { fields: { event_id: 'Choose an event' } });
  if (opts.source === 'public_form' && !event.accepting_submissions) {
    throw badRequest('Please correct the highlighted fields.', { fields: { event_id: 'This event is not accepting donations right now.' } });
  }
  if (opts.source === 'internal' && ['closed', 'archived'].includes(event.status)) {
    throw badRequest('Please correct the highlighted fields.', { fields: { event_id: `This event is ${event.status}.` } });
  }

  const result = await withTransaction(async (db) => {
    const reference = await uniqueReference(db);
    let inserted;
    try {
      inserted = await db.query(
        `INSERT INTO donation_submissions (reference, event_id, submitted_by, source, submission_data, status, public_consent,
           privacy_acknowledged, idempotency_key, submitter_fingerprint)
         VALUES ($1, $2, $3, $4, $5, 'pending_review', $6, true, $7, $8) RETURNING id, reference`,
        [reference, data.event_id, opts.submittedBy?.id ?? null, opts.source, JSON.stringify(data), data.public_consent, opts.idempotencyKey, opts.fingerprint],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505' && opts.idempotencyKey) {
        throw conflict('This donation was already submitted.');
      }
      throw err;
    }
    const sub = inserted.rows[0];
    await db.query(`INSERT INTO submission_events (submission_id, action, actor_id, comment) VALUES ($1, 'submitted', $2, $3)`, [
      sub.id,
      opts.submittedBy?.id ?? null,
      opts.source === 'public_form' ? 'Submitted through the public donation form' : `Submitted internally by ${opts.submittedBy?.name}`,
    ]);
    if (opts.image) {
      await db.query(
        `INSERT INTO donation_media (submission_id, storage_key, mime_type, size_bytes, original_name, alt_text, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          sub.id,
          opts.image.storageKey,
          opts.image.mime,
          opts.image.size,
          opts.image.originalName?.slice(0, 200) ?? null,
          opts.image.altText ?? `Photo of donation from ${data.donor_name}`.slice(0, 300),
          opts.submittedBy?.id ?? null,
        ],
      );
    }
    await audit(
      {
        userId: opts.submittedBy?.id ?? null,
        action: 'submission.create',
        recordType: 'submission',
        recordId: sub.id,
        summary: `New ${opts.source === 'public_form' ? 'public' : 'internal'} submission ${sub.reference} for ${event.name}`,
      },
      db,
    );
    return sub;
  });

  // Notify the review team (in-app, plus email if configured). Failures here never lose the submission.
  try {
    const settings = await getSettings();
    const reviewers = await usersWithPermission('submissions.review');
    const msg = `New donation submission ${result.reference} from ${data.donor_name} (${CATEGORY_LABELS[data.category]}) for ${event.name}`;
    await notify(
      reviewers.map((r) => r.id),
      'submission',
      msg,
      `/app/approvals/${result.id}`,
    );
    const recipients = new Set([...reviewers.map((r) => r.email), ...settings.notify_extra_emails]);
    for (const to of recipients) {
      await sendEmail({
        to,
        subject: `New donation submission ${result.reference}`,
        text: `${msg}\n\nReview it here: ${config.appBaseUrl}/app/approvals/${result.id}\n\n(Sign-in required.)`,
        purpose: 'admin_new_submission',
      });
    }
    if (opts.source === 'public_form' && settings.send_donor_confirmation_email) {
      await sendEmail({
        to: data.contact_email,
        subject: `We received your donation information (${result.reference})`,
        text:
          `Dear ${data.contact_name},\n\n${settings.submission_confirmation_message}\n\n` +
          `Your submission reference is ${result.reference}. Please quote it if you contact us.\n\n` +
          `Please note: your donation has not yet been reviewed or confirmed.\n\n${settings.charity_name}`,
        purpose: 'donor_submission_confirmation',
        replyTo: settings.charity_contact_email || undefined,
      });
    }
  } catch (err) {
    console.error('Submission notification failed', err);
  }
  return { ...result, duplicate: false };
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------
function redactSubmission(row: Record<string, unknown>, user: AuthUser) {
  if (canSeeContacts(user)) return row;
  const strip = (d: unknown) => {
    if (!d || typeof d !== 'object') return d;
    const c = { ...(d as Record<string, unknown>) };
    for (const f of ['contact_name', 'contact_email', 'contact_phone', 'pickup_address', 'availability', 'logistics_notes', 'social_media']) {
      if (f in c) c[f] = null;
    }
    return c;
  };
  return { ...row, submission_data: strip(row.submission_data), reviewed_data: strip(row.reviewed_data), contact_hidden: true };
}

export async function listSubmissions(user: AuthUser, filters: { status?: string; event_id?: number; q?: string; mine?: boolean; page: number; pageSize: number }) {
  const reviewer = can(user, 'submissions.review');
  if (!reviewer && !can(user, 'submissions.create')) throw forbidden();
  const params: unknown[] = [];
  const where: string[] = [];
  if (!reviewer || filters.mine) {
    params.push(user.id);
    where.push(`s.submitted_by = $${params.length}`);
  }
  if (filters.status === 'open') where.push(`s.status IN ('pending_review','awaiting_donor_info')`);
  else if (filters.status) {
    params.push(filters.status);
    where.push(`s.status = $${params.length}`);
  }
  if (filters.event_id) {
    params.push(filters.event_id);
    where.push(`s.event_id = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q.toLowerCase()}%`);
    where.push(`(lower(s.reference) LIKE $${params.length} OR lower(s.submission_data->>'donor_name') LIKE $${params.length}
                 OR lower(s.submission_data->>'description') LIKE $${params.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await pool.query(`SELECT count(*)::int AS n FROM donation_submissions s ${whereSql}`, params)).rows[0].n;
  params.push(filters.pageSize, (filters.page - 1) * filters.pageSize);
  const { rows } = await pool.query(
    `SELECT s.id, s.reference, s.source, s.status, s.submitted_at, s.reviewed_at, s.public_consent, s.event_id,
            e.name AS event_name, s.submission_data, s.reviewed_data, sb.name AS submitted_by_name, rb.name AS reviewed_by_name,
            d.id AS donation_id
     FROM donation_submissions s
     JOIN events e ON e.id = s.event_id
     LEFT JOIN users sb ON sb.id = s.submitted_by
     LEFT JOIN users rb ON rb.id = s.reviewed_by
     LEFT JOIN donations d ON d.submission_id = s.id
     ${whereSql}
     ORDER BY (s.status IN ('pending_review','awaiting_donor_info')) DESC, s.submitted_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { total, rows: rows.map((r) => redactSubmission(r, user)) };
}

export async function getSubmissionDetail(id: number, user: AuthUser) {
  const row = (
    await pool.query(
      `SELECT s.*, e.name AS event_name, e.status AS event_status, sb.name AS submitted_by_name, rb.name AS reviewed_by_name,
              d.id AS donation_id
       FROM donation_submissions s JOIN events e ON e.id = s.event_id
       LEFT JOIN users sb ON sb.id = s.submitted_by LEFT JOIN users rb ON rb.id = s.reviewed_by
       LEFT JOIN donations d ON d.submission_id = s.id WHERE s.id = $1`,
      [id],
    )
  ).rows[0];
  if (!row) throw notFound('Submission not found.');
  const reviewer = can(user, 'submissions.review');
  if (!reviewer && row.submitted_by !== user.id) throw forbidden('You do not have access to this submission.');
  delete row.info_request_token_hash;
  delete row.submitter_fingerprint;
  delete row.idempotency_key;
  const [events, media] = await Promise.all([
    pool.query(
      `SELECT se.id, se.action, se.comment, se.data, se.created_at, u.name AS actor_name
       FROM submission_events se LEFT JOIN users u ON u.id = se.actor_id WHERE se.submission_id = $1 ORDER BY se.created_at, se.id`,
      [id],
    ),
    pool.query('SELECT id, alt_text, mime_type, created_at FROM donation_media WHERE submission_id = $1 ORDER BY created_at', [id]),
  ]);
  const data = (row.reviewed_data ?? row.submission_data) as SubmissionData;
  const duplicates = reviewer && canSeeContacts(user)
    ? await findDuplicateDonors({ name: data.donor_name, contact_email: data.contact_email, contact_phone: data.contact_phone })
    : [];
  let linkedDonor = null;
  if (row.linked_donor_id && reviewer) {
    linkedDonor = (await pool.query('SELECT id, name, contact_name, contact_email, contact_phone, website FROM donors WHERE id = $1', [row.linked_donor_id])).rows[0];
  }
  const redacted = redactSubmission(row, user);
  return {
    submission: redacted,
    events: events.rows.map((e) => (canSeeContacts(user) ? e : { ...e, data: null })),
    media: media.rows,
    duplicates,
    linkedDonor,
    canReview: reviewer && canReviewSubmission(row, user),
  };
}

function canReviewSubmission(row: { submitted_by: number | null }, user: AuthUser) {
  if (!can(user, 'submissions.review')) return false;
  // Nobody below Admin may approve a submission they created themselves.
  if (row.submitted_by === user.id && !['admin', 'super_admin'].includes(user.role)) return false;
  return true;
}

async function lockOpenSubmission(db: Db, id: number, user: AuthUser) {
  const row = (await db.query('SELECT * FROM donation_submissions WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!row) throw notFound('Submission not found.');
  if (!can(user, 'submissions.review')) throw forbidden();
  if (!canReviewSubmission(row, user)) throw forbidden('You cannot review a submission you created yourself.');
  if (!['pending_review', 'awaiting_donor_info'].includes(row.status)) {
    throw conflict(`This submission has already been ${row.status.replace(/_/g, ' ')}.`);
  }
  return row;
}

export async function saveReviewedData(id: number, body: unknown, user: AuthUser) {
  const data = parse(submissionSchema, { ...(body as object), privacy_acknowledged: true });
  return withTransaction(async (db) => {
    const row = await lockOpenSubmission(db, id, user);
    data.privacy_acknowledged = row.privacy_acknowledged;
    data.public_consent = row.public_consent; // consent can only come from the donor (or recorded separately)
    await db.query('UPDATE donation_submissions SET reviewed_data = $2, updated_at = now() WHERE id = $1', [id, JSON.stringify(data)]);
    await db.query(`INSERT INTO submission_events (submission_id, action, actor_id, comment) VALUES ($1, 'edited', $2, 'Reviewer corrected submission details')`, [
      id,
      user.id,
    ]);
    await audit({ userId: user.id, action: 'submission.edit', recordType: 'submission', recordId: id, summary: 'Corrected submission details' }, db);
  });
}

export async function addSubmissionNote(id: number, text: string, user: AuthUser) {
  if (!can(user, 'submissions.review')) throw forbidden();
  const t = text.trim();
  if (!t || t.length > 5000) throw badRequest('Enter a note of up to 5000 characters.');
  const exists = await pool.query('SELECT 1 FROM donation_submissions WHERE id = $1', [id]);
  if (!exists.rows.length) throw notFound();
  await pool.query(`INSERT INTO submission_events (submission_id, action, actor_id, comment) VALUES ($1, 'note', $2, $3)`, [id, user.id, t]);
}

export async function linkDonor(id: number, donorId: number | null, user: AuthUser) {
  await withTransaction(async (db) => {
    await lockOpenSubmission(db, id, user);
    if (donorId) {
      const d = (await db.query('SELECT id, name, merged_into_id FROM donors WHERE id = $1', [donorId])).rows[0];
      if (!d || d.merged_into_id) throw badRequest('Choose a valid donor.');
    }
    await db.query('UPDATE donation_submissions SET linked_donor_id = $2, updated_at = now() WHERE id = $1', [id, donorId]);
    await db.query(`INSERT INTO submission_events (submission_id, action, actor_id, comment) VALUES ($1, 'donor_linked', $2, $3)`, [
      id,
      user.id,
      donorId ? `Linked to existing donor #${donorId}` : 'Donor link removed',
    ]);
  });
}

// ---------------------------------------------------------------------------
// Approve / decline / request information
// ---------------------------------------------------------------------------
export const approveSchema = z.object({
  donor: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('existing'), donor_id: z.coerce.number().int().positive(), update_contact: z.boolean().default(false) }),
    z.object({ mode: z.literal('new'), confirm_not_duplicate: z.boolean().default(false) }),
  ]),
  event_id: z.coerce.number().int().positive(),
  category: z.enum(CATEGORIES),
  subcategory: z.enum(SUBCATEGORIES).nullable().optional(),
  description: requiredText(5000, 'Description'),
  quantity: quantitySchema,
  estimated_value_cad: moneySchema,
  value_is_estimate: z.boolean().default(false),
  status: z.string().regex(/^[a-z_]+$/).default('approved'),
  assigned_to: z.coerce.number().int().positive().nullable().optional(),
  next_follow_up_date: dateSchema.optional(),
  recognition: z.enum(['approve', 'decline', 'decide_later']).default('decide_later'),
  include_images: z.boolean().default(true),
  comment: optionalText(3000),
});

export async function approveSubmission(id: number, body: unknown, user: AuthUser) {
  const input = parse(approveSchema, body);
  const checked = checkCategory(input);
  return withTransaction(async (db) => {
    const sub = await lockOpenSubmission(db, id, user);
    // Belt and braces: the UNIQUE(submission_id) constraint also prevents double approval.
    const already = await db.query('SELECT id FROM donations WHERE submission_id = $1', [id]);
    if (already.rows.length) throw conflict('A donation has already been created from this submission.');
    await assertEventUsable(input.event_id, db, { allowClosed: true });
    const status = (await db.query('SELECT code, counts_as_approved, is_active FROM donation_statuses WHERE code = $1', [input.status])).rows[0];
    if (!status || !status.counts_as_approved || !status.is_active) throw badRequest('Choose an approved operational status.');
    if (input.assigned_to) await assertAssignableUser(input.assigned_to, db);

    const data = (sub.reviewed_data ?? sub.submission_data) as SubmissionData;
    const donorFields = parse(donorInputSchema, {
      name: data.donor_name,
      contact_name: data.contact_name,
      contact_email: data.contact_email,
      contact_phone: data.contact_phone,
      website: data.website,
      social_media: data.social_media,
    });

    let donorId: number;
    if (input.donor.mode === 'existing') {
      const donor = (await db.query('SELECT id, merged_into_id FROM donors WHERE id = $1', [input.donor.donor_id])).rows[0];
      if (!donor || donor.merged_into_id) throw badRequest('The selected donor does not exist or was merged.');
      donorId = donor.id;
      if (input.donor.update_contact) {
        if (!can(user, 'donors.edit')) throw forbidden('You cannot update donor records.');
        const { name: _n, ...contact } = donorFields;
        await updateDonor(donorId, contact, user, db, `updated from submission ${sub.reference}`);
      }
    } else {
      if (!can(user, 'donors.create')) throw forbidden('You cannot create donor records.');
      const likely = (await findDuplicateDonors(donorFields, null, db)).filter((d) => d.score >= 50);
      if (likely.length && !input.donor.confirm_not_duplicate) {
        throw conflict('This donor may already exist. Link the submission to the existing donor, or confirm that this is a new donor.', {
          duplicates: likely,
        });
      }
      const donor = await createDonor(donorFields, user, db, `from submission ${sub.reference}`);
      donorId = donor.id;
    }

    const donation = await insertDonation(
      db,
      {
        event_id: input.event_id,
        donor_id: donorId,
        submission_id: id,
        category: checked.category,
        subcategory: checked.subcategory ?? null,
        description: input.description,
        quantity: input.quantity,
        estimated_value_cad: input.estimated_value_cad,
        value_is_estimate: input.value_is_estimate,
        status: input.status,
        assigned_to: input.assigned_to ?? null,
        delivery_method: data.delivery_method,
        pickup_address: data.pickup_address,
        pickup_instructions: [data.logistics_notes, data.additional_info ? `Additional info from donor: ${data.additional_info}` : null]
          .filter(Boolean)
          .join('\n\n') || null,
        pickup_preferred_dates: data.availability,
        public_consent: sub.public_consent,
        public_consent_source: sub.public_consent ? `Donor consent on submission ${sub.reference}` : null,
        approved: true,
      },
      user,
    );

    // Public recognition decision is independent of approval and NEVER publishes.
    if (input.recognition === 'approve' && sub.public_consent) {
      await db.query(
        `UPDATE donations SET show_donor_name = true, show_website = true, publication_status = 'pending_publication_approval' WHERE id = $1`,
        [donation.id],
      );
    }

    if (input.include_images) {
      await db.query('UPDATE donation_media SET donation_id = $2 WHERE submission_id = $1', [id, donation.id]);
    }
    if (input.next_follow_up_date) {
      await db.query('UPDATE donations SET next_follow_up_date = $2 WHERE id = $1', [donation.id, input.next_follow_up_date]);
      await syncNextFollowUp(db, { donationId: donation.id, date: input.next_follow_up_date, actor: user });
    }
    // Carry the review notes over to the donation's internal notes.
    const reviewNotes = await db.query(
      `SELECT se.comment, se.created_at, se.actor_id FROM submission_events se WHERE se.submission_id = $1 AND se.action = 'note' ORDER BY se.id`,
      [id],
    );
    for (const n of reviewNotes.rows) {
      await db.query('INSERT INTO donation_notes (donation_id, author_id, note_text, created_at) VALUES ($1, $2, $3, $4)', [
        donation.id,
        n.actor_id,
        `[Review note] ${n.comment}`,
        n.created_at,
      ]);
    }
    if (input.comment) {
      await db.query('INSERT INTO donation_notes (donation_id, author_id, note_text) VALUES ($1, $2, $3)', [donation.id, user.id, `[Approval] ${input.comment}`]);
    }

    await db.query(
      `UPDATE donation_submissions SET status = 'approved', reviewed_by = $2, reviewed_at = now(), review_comments = $3,
         linked_donor_id = $4, info_request_token_hash = NULL, updated_at = now() WHERE id = $1`,
      [id, user.id, input.comment, donorId],
    );
    await db.query(`INSERT INTO submission_events (submission_id, action, actor_id, comment, data) VALUES ($1, 'approved', $2, $3, $4)`, [
      id,
      user.id,
      input.comment ?? 'Approved',
      JSON.stringify({ donation_id: donation.id, donor_id: donorId, recognition: input.recognition }),
    ]);
    await audit(
      {
        userId: user.id,
        action: 'submission.approve',
        recordType: 'submission',
        recordId: id,
        summary: `Approved ${sub.reference} -> donation #${donation.id} (donor #${donorId})`,
      },
      db,
    );
    await audit(
      { userId: user.id, action: 'donation.create', recordType: 'donation', recordId: donation.id, summary: `Created from submission ${sub.reference}` },
      db,
    );
    if (input.assigned_to && input.assigned_to !== user.id) {
      await notify([input.assigned_to], 'assignment', `Donation #${donation.id} has been assigned to you`, `/app/donations/${donation.id}`, db);
    }
    return { donationId: donation.id, donorId };
  });
}

export async function declineSubmission(id: number, comment: string | null, user: AuthUser) {
  return withTransaction(async (db) => {
    const sub = await lockOpenSubmission(db, id, user);
    await db.query(
      `UPDATE donation_submissions SET status = 'declined', reviewed_by = $2, reviewed_at = now(), review_comments = $3,
         info_request_token_hash = NULL, updated_at = now() WHERE id = $1`,
      [id, user.id, comment],
    );
    await db.query(`INSERT INTO submission_events (submission_id, action, actor_id, comment) VALUES ($1, 'declined', $2, $3)`, [
      id,
      user.id,
      comment ?? 'Declined',
    ]);
    await audit({ userId: user.id, action: 'submission.decline', recordType: 'submission', recordId: id, summary: `Declined ${sub.reference}` }, db);
  });
}

export async function requestMoreInfo(id: number, message: string, user: AuthUser, sendEmailToDonor: boolean) {
  const msg = message.trim();
  if (!msg || msg.length > 3000) throw badRequest('Enter a message to the donor (up to 3000 characters).');
  const token = randomToken();
  const sub = await withTransaction(async (db) => {
    const row = await lockOpenSubmission(db, id, user);
    await db.query(
      `UPDATE donation_submissions SET status = 'awaiting_donor_info', info_request_token_hash = $2, info_request_message = $3,
         info_request_expires_at = now() + interval '30 days', updated_at = now() WHERE id = $1`,
      [id, sha256(token), msg],
    );
    await db.query(`INSERT INTO submission_events (submission_id, action, actor_id, comment) VALUES ($1, 'info_requested', $2, $3)`, [id, user.id, msg]);
    await audit({ userId: user.id, action: 'submission.request_info', recordType: 'submission', recordId: id, summary: `Requested more information for ${row.reference}` }, db);
    return row;
  });
  const link = `${config.appBaseUrl}/submit/more-info/${token}`;
  let emailStatus: string = 'not_requested';
  if (sendEmailToDonor) {
    const data = (sub.reviewed_data ?? sub.submission_data) as SubmissionData;
    const settings = await getSettings();
    const r = await sendEmail({
      to: data.contact_email,
      subject: `More information needed for your donation (${sub.reference})`,
      text: `Dear ${data.contact_name},\n\nThank you for your donation offer. Our team needs a little more information:\n\n${msg}\n\nPlease reply securely using this link (valid for 30 days):\n${link}\n\n${settings.charity_name}`,
      purpose: 'donor_info_request',
      userId: user.id,
      replyTo: settings.charity_contact_email || undefined,
    });
    emailStatus = r.status;
  }
  return { link, emailStatus };
}

export async function findInfoRequest(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const row = (
    await pool.query(
      `SELECT s.id, s.reference, s.info_request_message, e.name AS event_name FROM donation_submissions s JOIN events e ON e.id = s.event_id
       WHERE s.info_request_token_hash = $1 AND s.status = 'awaiting_donor_info' AND s.info_request_expires_at > now()`,
      [sha256(token)],
    )
  ).rows[0];
  return row ?? null;
}

export async function submitDonorResponse(
  token: string,
  response: string,
  image: { storageKey: string; mime: string; size: number; originalName?: string } | null,
) {
  const text = response.trim();
  if (!text || text.length > 5000) throw badRequest('Please enter your response (up to 5000 characters).');
  const result = await withTransaction(async (db) => {
    const row = (
      await db.query(
        `SELECT id, reference FROM donation_submissions WHERE info_request_token_hash = $1 AND status = 'awaiting_donor_info'
         AND info_request_expires_at > now() FOR UPDATE`,
        [sha256(token)],
      )
    ).rows[0];
    if (!row) throw notFound('This link has expired or has already been used.');
    await db.query(
      `UPDATE donation_submissions SET status = 'pending_review', info_request_token_hash = NULL, updated_at = now() WHERE id = $1`,
      [row.id],
    );
    await db.query(`INSERT INTO submission_events (submission_id, action, comment) VALUES ($1, 'donor_response', $2)`, [row.id, text]);
    if (image) {
      await db.query(
        `INSERT INTO donation_media (submission_id, storage_key, mime_type, size_bytes, original_name, alt_text) VALUES ($1,$2,$3,$4,$5,$6)`,
        [row.id, image.storageKey, image.mime, image.size, image.originalName?.slice(0, 200) ?? null, 'Photo provided by donor'],
      );
    }
    await audit({ action: 'submission.donor_response', recordType: 'submission', recordId: row.id, summary: `Donor responded to information request for ${row.reference}` }, db);
    return row;
  });
  const reviewers = await usersWithPermission('submissions.review');
  await notify(
    reviewers.map((r) => r.id),
    'submission',
    `The donor responded to the information request for ${result.reference}`,
    `/app/approvals/${result.id}`,
  );
  return result;
}
