import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requirePermission } from '../auth/middleware.js';
import { type AuthUser, can } from '../auth/permissions.js';
import { config, smtpConfigured, today } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { toCsv } from '../lib/csv.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  SUBCATEGORIES,
  SUBCATEGORY_LABELS,
  dateSchema,
  idParam,
  optionalText,
  parse,
} from '../lib/validation.js';
import { assertDonationAccess, canSeeContacts, donationScopeSql } from '../services/access.js';
import { audit } from '../services/audit.js';
import {
  DONATION_SELECT,
  addNote,
  assertAssignableUser,
  assertEventUsable,
  assertThankYouAccess,
  checkCategory,
  consentSchema,
  donationFieldsSchema,
  getDonationDetail,
  insertDonation,
  markThankYouSent,
  pickupSchema,
  publicContentSchema,
  publishDonation,
  receiveSchema,
  requestPublication,
  schedulePickup,
  serializeDonation,
  setArchived,
  setConsent,
  setItemReceived,
  syncNextFollowUp,
  unpublishDonation,
  updateDonation,
  updatePublicContent,
} from '../services/donations.js';
import { sendEmail } from '../services/email.js';
import { deleteStoredFile, storagePath, storeImage } from '../services/media.js';
import { notify, usersWithPermission } from '../services/notifications.js';
import { fillTemplate, getSettings } from '../services/settings.js';
import { createDonor, donorInputSchema, findDuplicateDonors } from '../services/donors.js';

export const donationsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5 } });

// ---------------------------------------------------------------------------
// List / filter / sort / paginate
// ---------------------------------------------------------------------------
const yesNo = z.enum(['yes', 'no']).optional();
export const donationFilterSchema = z.object({
  event_id: z.coerce.number().int().positive().optional(),
  donor_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(200).optional(),
  category: z.enum(CATEGORIES).optional(),
  subcategory: z.enum(SUBCATEGORIES).optional(),
  status: z.string().regex(/^[a-z_,]+$/).optional(),
  publication_status: z.enum(['unpublished', 'pending_publication_approval', 'published', 'withdrawn']).optional(),
  assigned_to: z.union([z.literal('me'), z.literal('none'), z.coerce.number().int().positive()]).optional(),
  follow_up: z.enum(['overdue', 'today', 'scheduled', 'none']).optional(),
  follow_up_from: dateSchema.optional(),
  follow_up_to: dateSchema.optional(),
  item_received: yesNo,
  thank_you: z.enum(['sent', 'outstanding', 'ready', 'draft', 'not_required']).optional(),
  view: z.enum(['awaiting_pickup', 'approved']).optional(),
  archived: z.enum(['only', 'include']).optional(),
  sort: z.enum(['id', 'created_at', 'value', 'category', 'status', 'follow_up', 'donor', 'event']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(25),
});

function escapeLike(s: string) {
  return s.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`);
}

export function buildDonationWhere(user: AuthUser, f: z.infer<typeof donationFilterSchema>, params: unknown[]): string {
  const where: string[] = [donationScopeSql(user, params)];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.archived === 'only' && can(user, 'donations.archive')) where.push('d.is_archived');
  else if (f.archived !== 'include' || !can(user, 'donations.archive')) where.push('NOT d.is_archived');
  if (f.event_id) add('d.event_id = ?', f.event_id);
  if (f.donor_id) add('d.donor_id = ?', f.donor_id);
  if (f.category) add('d.category = ?', f.category);
  if (f.subcategory) add('d.subcategory = ?', f.subcategory);
  if (f.status) add('d.status = ANY(?)', f.status.split(',').filter(Boolean));
  if (f.publication_status) add('d.publication_status = ?', f.publication_status);
  if (f.assigned_to === 'me') add('d.assigned_to = ?', user.id);
  else if (f.assigned_to === 'none') where.push('d.assigned_to IS NULL');
  else if (f.assigned_to) add('d.assigned_to = ?', f.assigned_to);
  if (f.follow_up === 'overdue') add('d.next_follow_up_date < ?', today());
  if (f.follow_up === 'today') add('d.next_follow_up_date = ?', today());
  if (f.follow_up === 'scheduled') where.push('d.next_follow_up_date IS NOT NULL');
  if (f.follow_up === 'none') where.push('d.next_follow_up_date IS NULL');
  if (f.follow_up_from) add('d.next_follow_up_date >= ?', f.follow_up_from);
  if (f.follow_up_to) add('d.next_follow_up_date <= ?', f.follow_up_to);
  if (f.item_received) where.push(f.item_received === 'yes' ? 'd.item_received' : 'NOT d.item_received');
  const approved = `d.status IN (SELECT code FROM donation_statuses WHERE counts_as_approved)`;
  if (f.thank_you === 'sent') where.push('d.thank_you_sent');
  if (f.thank_you === 'outstanding') where.push(`d.thank_you_required AND NOT d.thank_you_sent AND ${approved}`);
  if (f.thank_you === 'ready') where.push(`d.thank_you_required AND NOT d.thank_you_sent AND d.item_received`);
  if (f.thank_you === 'draft') where.push(`d.thank_you_stage = 'draft_prepared'`);
  if (f.thank_you === 'not_required') where.push(`NOT d.thank_you_required`);
  if (f.view === 'approved') where.push(approved);
  if (f.view === 'awaiting_pickup') {
    where.push(`NOT d.item_received AND ${approved} AND (d.delivery_method = 'pickup_required' OR d.pickup_scheduled_for IS NOT NULL)`);
  }
  if (f.q) {
    params.push(`%${escapeLike(f.q)}%`);
    const p = `$${params.length}`;
    const contactSearch = canSeeContacts(user) ? ` OR lower(coalesce(dn.contact_name,'')) LIKE ${p}` : '';
    const idSearch = /^\d+$/.test(f.q) ? ` OR d.id = ${Number(f.q)}` : '';
    where.push(`(lower(dn.name) LIKE ${p} OR lower(d.description) LIKE ${p}${contactSearch}${idSearch})`);
  }
  return where.join(' AND ');
}

const SORTS: Record<string, string> = {
  id: 'd.id',
  created_at: 'd.created_at',
  value: 'd.estimated_value_cad',
  category: 'd.category',
  status: 's.sort_order',
  follow_up: 'd.next_follow_up_date',
  donor: 'lower(dn.name)',
  event: 'e.event_date',
};

donationsRouter.get('/', async (req, res) => {
  const f = parse(donationFilterSchema, req.query);
  const params: unknown[] = [];
  const where = buildDonationWhere(req.user!, f, params);
  const base = `FROM donations d JOIN donors dn ON dn.id = d.donor_id JOIN events e ON e.id = d.event_id
                JOIN donation_statuses s ON s.code = d.status WHERE ${where}`;
  const totals = (await pool.query(`SELECT count(*)::int AS total, coalesce(sum(d.estimated_value_cad),0) AS total_value ${base}`, params)).rows[0];
  const order = `${SORTS[f.sort]} ${f.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, d.id DESC`;
  params.push(f.page_size, (f.page - 1) * f.page_size);
  const { rows } = await pool.query(
    `${DONATION_SELECT} WHERE d.id IN (SELECT d.id ${base}) ORDER BY ${order}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({ ...totals, page: f.page, pageSize: f.page_size, rows: rows.map((r) => serializeDonation(r, req.user!)) });
});

donationsRouter.get('/statuses', async (_req, res) => {
  res.json((await pool.query('SELECT * FROM donation_statuses ORDER BY sort_order')).rows);
});

// CSV export (same permission scoping as the list; contact columns only if allowed)
donationsRouter.get('/export.csv', requirePermission('exports.run'), async (req, res) => {
  const f = parse(donationFilterSchema, { ...req.query, page: 1, page_size: 1 });
  const params: unknown[] = [];
  const where = buildDonationWhere(req.user!, f, params);
  const { rows } = await pool.query(
    `${DONATION_SELECT} WHERE d.id IN (SELECT d.id FROM donations d JOIN donors dn ON dn.id = d.donor_id WHERE ${where})
     ORDER BY d.event_id, d.id LIMIT 50000`,
    params,
  );
  const contacts = canSeeContacts(req.user!);
  const headers = [
    { key: 'id', label: 'DonationID' },
    { key: 'event_id', label: 'EventID' },
    { key: 'event_name', label: 'Event' },
    { key: 'donor_id', label: 'DonorID' },
    { key: 'donor_name', label: 'BusinessorDonor/Org' },
    ...(contacts
      ? [
          { key: 'contact_name', label: 'ContactName' },
          { key: 'contact_email', label: 'ContactEmail' },
          { key: 'contact_phone', label: 'ContactPhone' },
        ]
      : []),
    { key: 'donor_website', label: 'BusinessWebsite' },
    ...(contacts ? [{ key: 'social', label: 'SocialMediaID' }] : []),
    { key: 'category_label', label: 'DonationCategory' },
    { key: 'subcategory_label', label: 'SubCategory' },
    { key: 'description', label: 'DescriptionoftheDonation' },
    { key: 'quantity', label: 'Quantity' },
    { key: 'estimated_value_cad', label: '$Value (CAD)' },
    { key: 'status_label', label: 'Status' },
    { key: 'publication_status', label: 'PublicationStatus' },
    { key: 'assigned_to_name', label: 'AssignedTo' },
    { key: 'next_follow_up_date', label: 'NextFollowUpDate' },
    { key: 'delivery_method', label: 'Delivery' },
    ...(contacts ? [{ key: 'pickup', label: 'PickUpDetails' }] : []),
    { key: 'item_received_yn', label: "ItemRec'd" },
    { key: 'thank_you_yn', label: 'ThankYouStatus' },
    { key: 'thank_you_sent_at', label: 'ThankYouSentAt' },
  ];
  const data = rows.map((r) => ({
    ...r,
    category_label: CATEGORY_LABELS[r.category],
    subcategory_label: r.subcategory ? SUBCATEGORY_LABELS[r.subcategory] : '',
    social: (r.donor_social_media ?? []).map((s: { platform: string; handle: string }) => `${s.platform}: ${s.handle}`).join('; '),
    pickup: [r.pickup_address, r.pickup_preferred_dates, r.pickup_instructions, r.pickup_scheduled_for && `Scheduled ${new Date(r.pickup_scheduled_for).toISOString()}`]
      .filter(Boolean)
      .join(' | '),
    item_received_yn: r.item_received ? 'Yes' : 'No',
    thank_you_yn: r.thank_you_sent ? 'Yes' : 'No',
  }));
  await audit({
    userId: req.user!.id,
    action: 'export.donations',
    recordType: 'export',
    summary: `Exported ${rows.length} donations${contacts ? ' (with contact details)' : ''}`,
    details: { filters: req.query },
    req,
  });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="donations-${today()}.csv"`);
  res.send(toCsv(headers, data));
});

// ---------------------------------------------------------------------------
// Create directly (admins). Volunteers/owners use /api/submissions instead.
// ---------------------------------------------------------------------------
const createSchema = donationFieldsSchema.extend({
  donor_id: z.coerce.number().int().positive().optional(),
  new_donor: donorInputSchema.optional(),
  confirm_not_duplicate: z.boolean().default(false),
  assigned_to: z.coerce.number().int().positive().nullable().optional(),
  next_follow_up_date: dateSchema.optional(),
  delivery_method: z.enum(['donor_delivers', 'pickup_required', 'undecided']).default('undecided'),
  pickup_address: optionalText(1000),
  pickup_instructions: optionalText(3000),
  pickup_preferred_dates: optionalText(1000),
  public_consent: z.boolean().default(false),
  public_consent_source: optionalText(300),
  note: optionalText(5000),
});

donationsRouter.post('/', requirePermission('donations.create'), async (req, res) => {
  const input = checkCategory(parse(createSchema, req.body));
  if (!input.donor_id && !input.new_donor) throw badRequest('Choose an existing donor or enter a new donor.', { fields: { donor_id: 'Choose a donor' } });
  const user = req.user!;
  const created = await withTransaction(async (db) => {
    await assertEventUsable(input.event_id, db);
    if (input.assigned_to) await assertAssignableUser(input.assigned_to, db);
    let donorId = input.donor_id;
    if (!donorId) {
      if (!can(user, 'donors.create')) throw forbidden('You cannot create donor records.');
      const dups = (await findDuplicateDonors(input.new_donor!, null, db)).filter((d) => d.score >= 50);
      if (dups.length && !input.confirm_not_duplicate) {
        throw conflict('This donor may already exist. Choose the existing donor or confirm this is a new donor.', { duplicates: dups });
      }
      donorId = (await createDonor(input.new_donor!, user, db, 'added with a donation')).id;
    } else {
      const d = (await db.query('SELECT merged_into_id FROM donors WHERE id = $1', [donorId])).rows[0];
      if (!d || d.merged_into_id) throw badRequest('Choose a valid donor.');
    }
    const donation = await insertDonation(
      db,
      {
        ...input,
        donor_id: donorId!,
        subcategory: input.subcategory ?? null,
        status: 'approved',
        approved: true,
        public_consent: input.public_consent,
        public_consent_source: input.public_consent ? (input.public_consent_source ?? 'Recorded by staff when adding donation') : null,
      },
      user,
    );
    if (input.next_follow_up_date) {
      await db.query('UPDATE donations SET next_follow_up_date = $2 WHERE id = $1', [donation.id, input.next_follow_up_date]);
      await syncNextFollowUp(db, { donationId: donation.id, date: input.next_follow_up_date, actor: user });
    }
    if (input.note) await db.query('INSERT INTO donation_notes (donation_id, author_id, note_text) VALUES ($1,$2,$3)', [donation.id, user.id, input.note]);
    await audit({ userId: user.id, action: 'donation.create', recordType: 'donation', recordId: donation.id, summary: 'Added manually' }, db);
    if (input.assigned_to && input.assigned_to !== user.id) {
      await notify([input.assigned_to], 'assignment', `Donation #${donation.id} has been assigned to you`, `/app/donations/${donation.id}`, db);
    }
    return donation;
  });
  res.status(201).json({ id: created.id });
});

// ---------------------------------------------------------------------------
// Detail / update
// ---------------------------------------------------------------------------
donationsRouter.get('/:id', async (req, res) => {
  res.json(await getDonationDetail(parse(idParam, req.params.id), req.user!));
});

donationsRouter.patch('/:id', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const { status_comment, confirm_event_change, ...body } = req.body ?? {};
  await withTransaction(async (db) => {
    const before = (await db.query('SELECT assigned_to FROM donations WHERE id = $1', [id])).rows[0];
    const updated = await updateDonation(id, body, req.user!, db, {
      statusComment: typeof status_comment === 'string' ? status_comment.slice(0, 1000) : null,
      confirmEventChange: confirm_event_change === true,
    });
    if (updated.assigned_to && before && updated.assigned_to !== before.assigned_to && updated.assigned_to !== req.user!.id) {
      await notify([updated.assigned_to], 'assignment', `Donation #${id} has been assigned to you`, `/app/donations/${id}`, db);
    }
  });
  res.json(await getDonationDetail(id, req.user!));
});

donationsRouter.post('/:id/notes', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const { text } = parse(z.object({ text: z.string() }), req.body);
  res.status(201).json(await addNote(id, text, req.user!));
});

// ---- Quick actions
donationsRouter.post('/:id/receive', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const input = parse(receiveSchema, req.body ?? {});
  await withTransaction((db) => setItemReceived(id, input, req.user!, db));
  res.json(await getDonationDetail(id, req.user!));
});

donationsRouter.post('/:id/pickup', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const input = parse(pickupSchema, req.body);
  await withTransaction((db) => schedulePickup(id, input, req.user!, db));
  res.json(await getDonationDetail(id, req.user!));
});

// ---- Thank-you workflow
donationsRouter.get('/:id/thank-you/template', async (req, res) => {
  const id = parse(idParam, req.params.id);
  await assertThankYouAccess(id, req.user!, pool);
  const row = (
    await pool.query(
      `SELECT d.description, d.public_title, dn.name, dn.contact_name, dn.contact_email, e.name AS event_name FROM donations d
       JOIN donors dn ON dn.id = d.donor_id JOIN events e ON e.id = d.event_id WHERE d.id = $1`,
      [id],
    )
  ).rows[0];
  const s = await getSettings();
  const values = {
    charity_name: s.charity_name,
    contact_name: row.contact_name || row.name,
    donor_name: row.name,
    donation_description: row.public_title || row.description,
    event_name: row.event_name,
    sender_name: req.user!.name,
  };
  res.json({
    recipient: canSeeContacts(req.user!) ? row.contact_email : null,
    subject: fillTemplate(s.thank_you_subject_template, values),
    body: fillTemplate(s.thank_you_body_template, values),
    emailConfigured: smtpConfigured(),
  });
});

const draftSchema = z.object({
  method: z.enum(['email', 'letter', 'card', 'phone', 'in_person', 'other']),
  recipient: optionalText(320),
  subject: optionalText(300),
  body: optionalText(20000),
});

donationsRouter.post('/:id/thank-you/drafts', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const input = parse(draftSchema, req.body);
  const msg = await withTransaction(async (db) => {
    const row = await assertThankYouAccess(id, req.user!, db);
    if (row.thank_you_sent) throw conflict('A thank-you has already been sent for this donation.');
    if (input.recipient && !canSeeContacts(req.user!)) throw forbidden('You cannot set recipient details.');
    const m = (
      await db.query(
        `INSERT INTO thank_you_messages (donation_id, method, recipient, subject, body, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, input.method, input.recipient, input.subject, input.body, req.user!.id],
      )
    ).rows[0];
    // A draft is NOT a sent thank-you.
    await db.query(`UPDATE donations SET thank_you_stage = 'draft_prepared', updated_at = now() WHERE id = $1 AND thank_you_stage IN ('not_started','not_required')`, [id]);
    await audit({ userId: req.user!.id, action: 'donation.thank_you_draft', recordType: 'donation', recordId: id, summary: `Thank-you draft prepared (${input.method})` }, db);
    return m;
  });
  res.status(201).json(msg);
});

donationsRouter.put('/:id/thank-you/drafts/:mid', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const mid = parse(idParam, req.params.mid);
  const input = parse(draftSchema, req.body);
  await withTransaction(async (db) => {
    await assertThankYouAccess(id, req.user!, db);
    const m = (await db.query('SELECT * FROM thank_you_messages WHERE id = $1 AND donation_id = $2 FOR UPDATE', [mid, id])).rows[0];
    if (!m) throw notFound();
    if (m.status !== 'draft' && m.status !== 'failed') throw conflict('Only drafts can be edited.');
    await db.query('UPDATE thank_you_messages SET method=$2, recipient=COALESCE($3, recipient), subject=$4, body=$5, updated_at=now() WHERE id=$1', [
      mid,
      input.method,
      canSeeContacts(req.user!) ? input.recipient : null,
      input.subject,
      input.body,
    ]);
  });
  res.json({ ok: true });
});

donationsRouter.post('/:id/thank-you/drafts/:mid/discard', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const mid = parse(idParam, req.params.mid);
  await withTransaction(async (db) => {
    await assertThankYouAccess(id, req.user!, db);
    const r = await db.query(`UPDATE thank_you_messages SET status = 'discarded', updated_at = now() WHERE id = $1 AND donation_id = $2 AND status IN ('draft','failed')`, [mid, id]);
    if (!r.rowCount) throw notFound();
    const remaining = await db.query(`SELECT 1 FROM thank_you_messages WHERE donation_id = $1 AND status IN ('draft','failed')`, [id]);
    if (!remaining.rows.length) {
      await db.query(`UPDATE donations SET thank_you_stage = CASE WHEN thank_you_required THEN 'not_started' ELSE 'not_required' END WHERE id = $1 AND thank_you_stage = 'draft_prepared'`, [id]);
    }
  });
  res.json({ ok: true });
});

/** Sends a reviewed draft by email (only if SMTP is configured) after explicit confirmation. */
donationsRouter.post('/:id/thank-you/drafts/:mid/send-email', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const mid = parse(idParam, req.params.mid);
  const { confirm } = parse(z.object({ confirm: z.literal(true, { error: 'Please confirm you reviewed the message before sending.' }) }), req.body);
  void confirm;
  if (!smtpConfigured()) throw badRequest('Email sending is not configured. Send the message yourself, then use "Confirm sent".');
  await assertThankYouAccess(id, req.user!, pool);
  const m = (await pool.query('SELECT * FROM thank_you_messages WHERE id = $1 AND donation_id = $2', [mid, id])).rows[0];
  if (!m || m.status !== 'draft') throw conflict('Only an unsent draft can be emailed.');
  if (m.method !== 'email' || !m.recipient || !m.subject || !m.body) throw badRequest('The draft needs an email recipient, subject and message.');
  const settings = await getSettings();
  const result = await sendEmail({
    to: m.recipient,
    subject: m.subject,
    text: m.body,
    purpose: 'thank_you',
    userId: req.user!.id,
    replyTo: settings.charity_contact_email || undefined,
  });
  if (result.status !== 'sent') {
    await pool.query(`UPDATE thank_you_messages SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [mid, result.error ?? result.status]);
    throw badRequest(`The email could not be sent: ${result.error ?? result.status}. The thank-you has NOT been marked as sent.`);
  }
  await pool.query('UPDATE thank_you_messages SET delivery_reference = $2 WHERE id = $1', [mid, result.messageId ?? null]);
  await withTransaction((db) => markThankYouSent(id, { method: 'email', messageId: mid }, req.user!, db));
  res.json(await getDonationDetail(id, req.user!));
});

/** User confirms a thank-you was actually sent (by any method). */
donationsRouter.post('/:id/thank-you/confirm-sent', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const input = parse(
    z.object({
      method: z.enum(['email', 'letter', 'card', 'phone', 'in_person', 'other']),
      message_id: z.coerce.number().int().positive().nullable().optional(),
      sent_on: dateSchema.optional(),
      notes: optionalText(2000),
      confirm: z.literal(true, { error: 'Please confirm the thank-you was actually sent.' }),
    }),
    req.body,
  );
  if (input.sent_on && input.sent_on > today()) throw badRequest('The sent date cannot be in the future.');
  await withTransaction(async (db) => {
    if (input.message_id) {
      const m = (await db.query('SELECT status FROM thank_you_messages WHERE id = $1 AND donation_id = $2', [input.message_id, id])).rows[0];
      if (!m) throw notFound('Draft not found.');
    }
    await markThankYouSent(
      id,
      { method: input.method, messageId: input.message_id ?? null, notes: input.notes, sentAt: input.sent_on ? `${input.sent_on}T12:00:00Z` : null },
      req.user!,
      db,
    );
  });
  res.json(await getDonationDetail(id, req.user!));
});

donationsRouter.post('/:id/thank-you/not-required', async (req, res) => {
  const id = parse(idParam, req.params.id);
  await withTransaction(async (db) => {
    const row = await assertThankYouAccess(id, req.user!, db);
    if (row.thank_you_sent) throw conflict('A thank-you was already sent.');
    await db.query(`UPDATE donations SET thank_you_required = false, thank_you_stage = 'not_required', updated_at = now() WHERE id = $1`, [id]);
    await audit({ userId: req.user!.id, action: 'donation.thank_you_not_required', recordType: 'donation', recordId: id, summary: 'Thank-you marked not required' }, db);
  });
  res.json(await getDonationDetail(id, req.user!));
});

// ---- Publication
donationsRouter.put('/:id/public-content', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const input = parse(publicContentSchema, req.body);
  await withTransaction(async (db) => {
    await assertDonationAccess(req.user!, id, db);
    await updatePublicContent(id, input, req.user!, db);
  });
  res.json(await getDonationDetail(id, req.user!));
});

donationsRouter.post('/:id/consent', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const input = parse(consentSchema, req.body);
  await withTransaction((db) => setConsent(id, input, req.user!, db));
  res.json(await getDonationDetail(id, req.user!));
});

donationsRouter.post('/:id/request-publication', async (req, res) => {
  const id = parse(idParam, req.params.id);
  await withTransaction(async (db) => {
    await assertDonationAccess(req.user!, id, db);
    await requestPublication(id, req.user!, db);
  });
  const publishers = await usersWithPermission('publication.manage');
  await notify(
    publishers.map((p) => p.id).filter((pid) => pid !== req.user!.id),
    'publication',
    `Donation #${id} is waiting for publication approval`,
    `/app/donations/${id}`,
  );
  res.json(await getDonationDetail(id, req.user!));
});

donationsRouter.post('/:id/publish', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const { confirm } = parse(z.object({ confirm: z.boolean().default(false) }), req.body ?? {});
  await withTransaction((db) => publishDonation(id, req.user!, db, confirm));
  res.json(await getDonationDetail(id, req.user!));
});

donationsRouter.post('/:id/unpublish', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const { reason } = parse(z.object({ reason: optionalText(500) }), req.body ?? {});
  await withTransaction((db) => unpublishDonation(id, req.user!, db, reason));
  res.json(await getDonationDetail(id, req.user!));
});

donationsRouter.post('/:id/archive', async (req, res) => {
  const id = parse(idParam, req.params.id);
  await withTransaction((db) => setArchived(id, true, req.user!, db));
  res.json({ ok: true });
});

donationsRouter.post('/:id/restore', async (req, res) => {
  const id = parse(idParam, req.params.id);
  await withTransaction((db) => setArchived(id, false, req.user!, db));
  res.json(await getDonationDetail(id, req.user!));
});

// ---- Sharing with specific users
donationsRouter.post('/:id/shares', requirePermission('donations.assign'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  const { user_id } = parse(z.object({ user_id: z.coerce.number().int().positive() }), req.body);
  await assertDonationAccess(req.user!, id);
  await assertAssignableUser(user_id, pool);
  await pool.query('INSERT INTO donation_shares (donation_id, user_id, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, user_id, req.user!.id]);
  await audit({ userId: req.user!.id, action: 'donation.share', recordType: 'donation', recordId: id, summary: `Shared with user #${user_id}` });
  await notify([user_id], 'share', `Donation #${id} was shared with you`, `/app/donations/${id}`);
  res.status(201).json({ ok: true });
});

donationsRouter.delete('/:id/shares/:userId', requirePermission('donations.assign'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  const userId = parse(idParam, req.params.userId);
  await pool.query('DELETE FROM donation_shares WHERE donation_id = $1 AND user_id = $2', [id, userId]);
  await audit({ userId: req.user!.id, action: 'donation.unshare', recordType: 'donation', recordId: id, summary: `Stopped sharing with user #${userId}` });
  res.json({ ok: true });
});

// ---- Media
donationsRouter.post('/:id/media', upload.single('image'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  await assertDonationAccess(req.user!, id);
  if (!can(req.user!, 'donations.edit_all') && !can(req.user!, 'donations.edit_assigned')) throw forbidden();
  if (!req.file) throw badRequest('Choose an image to upload.');
  const stored = await storeImage(req.file.buffer);
  const alt = typeof req.body.alt_text === 'string' ? req.body.alt_text.trim().slice(0, 300) : null;
  const { rows } = await pool.query(
    `INSERT INTO donation_media (donation_id, storage_key, mime_type, size_bytes, original_name, alt_text, uploaded_by, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7, (SELECT coalesce(max(sort_order),0)+1 FROM donation_media WHERE donation_id = $1)) RETURNING id`,
    [id, stored.storageKey, stored.mime, stored.size, req.file.originalname.slice(0, 200), alt || null, req.user!.id],
  );
  await audit({ userId: req.user!.id, action: 'donation.media_upload', recordType: 'donation', recordId: id, summary: 'Uploaded an image' });
  res.status(201).json({ id: rows[0].id });
});

donationsRouter.patch('/:id/media/:mediaId', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const mediaId = parse(z.string().uuid(), req.params.mediaId);
  const input = parse(z.object({ alt_text: optionalText(300).optional(), is_public: z.boolean().optional(), sort_order: z.coerce.number().int().min(0).max(1000).optional() }), req.body);
  await assertDonationAccess(req.user!, id);
  if (input.is_public !== undefined && !can(req.user!, 'publication.manage')) throw forbidden('Only users who can publish may change image visibility.');
  if (!can(req.user!, 'donations.edit_all') && !can(req.user!, 'donations.edit_assigned')) throw forbidden();
  const r = await pool.query(
    `UPDATE donation_media SET alt_text = CASE WHEN $3 THEN $4 ELSE alt_text END, is_public = COALESCE($5, is_public), sort_order = COALESCE($6, sort_order)
     WHERE id = $1 AND donation_id = $2`,
    [mediaId, id, input.alt_text !== undefined, input.alt_text ?? null, input.is_public ?? null, input.sort_order ?? null],
  );
  if (!r.rowCount) throw notFound();
  await audit({ userId: req.user!.id, action: 'donation.media_update', recordType: 'donation', recordId: id, summary: `Image updated${input.is_public !== undefined ? ` (public: ${input.is_public})` : ''}` });
  res.json({ ok: true });
});

donationsRouter.delete('/:id/media/:mediaId', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const mediaId = parse(z.string().uuid(), req.params.mediaId);
  if (!can(req.user!, 'donations.edit_all')) throw forbidden();
  const r = await pool.query('DELETE FROM donation_media WHERE id = $1 AND donation_id = $2 RETURNING storage_key', [mediaId, id]);
  if (!r.rowCount) throw notFound();
  await deleteStoredFile(r.rows[0].storage_key);
  await audit({ userId: req.user!.id, action: 'donation.media_delete', recordType: 'donation', recordId: id, summary: 'Deleted an image' });
  res.json({ ok: true });
});

/** Internal (authenticated) image access, checked against the parent record. */
export async function serveInternalMedia(mediaId: string, user: AuthUser) {
  const m = (await pool.query('SELECT * FROM donation_media WHERE id = $1', [mediaId])).rows[0];
  if (!m) throw notFound();
  if (m.donation_id) {
    await assertDonationAccess(user, m.donation_id);
  } else {
    const s = (await pool.query('SELECT submitted_by FROM donation_submissions WHERE id = $1', [m.submission_id])).rows[0];
    if (!can(user, 'submissions.review') && s?.submitted_by !== user.id) throw forbidden();
  }
  return { path: storagePath(m.storage_key), mime: m.mime_type as string };
}
