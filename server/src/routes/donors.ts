import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../auth/middleware.js';
import { can } from '../auth/permissions.js';
import { pool, withTransaction } from '../db/pool.js';
import { toCsv } from '../lib/csv.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { idParam, parse } from '../lib/validation.js';
import { assertDonorAccess, canSeeContacts, donationScopeSql, donorScopeSql } from '../services/access.js';
import { audit } from '../services/audit.js';
import { serializeDonation, DONATION_SELECT } from '../services/donations.js';
import {
  createDonor,
  donorInputSchema,
  findDuplicateDonors,
  listDuplicatePairs,
  mergeDonors,
  redactDonor,
  updateDonor,
} from '../services/donors.js';
import { today } from '../config.js';

export const donorsRouter = Router();

donorsRouter.get('/', async (req, res) => {
  const f = parse(
    z.object({
      q: z.string().trim().max(200).optional(),
      archived: z.enum(['true', 'false']).default('false'),
      owner_id: z.coerce.number().int().positive().optional(),
      sort: z.enum(['name', 'created_at', 'donations', 'value']).default('name'),
      dir: z.enum(['asc', 'desc']).default('asc'),
      page: z.coerce.number().int().min(1).default(1),
      page_size: z.coerce.number().int().min(1).max(200).default(25),
    }),
    req.query,
  );
  const user = req.user!;
  const params: unknown[] = [];
  const where = [donorScopeSql(user, params)];
  where.push(f.archived === 'true' ? 'dn.is_archived' : 'NOT dn.is_archived');
  if (f.owner_id) {
    params.push(f.owner_id);
    where.push(`dn.owner_id = $${params.length}`);
  }
  if (f.q) {
    params.push(`%${f.q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    const p = `$${params.length}`;
    where.push(
      canSeeContacts(user)
        ? `(lower(dn.name) LIKE ${p} OR lower(coalesce(dn.contact_name,'')) LIKE ${p} OR lower(coalesce(dn.contact_email,'')) LIKE ${p} OR dn.norm_phone LIKE ${p})`
        : `lower(dn.name) LIKE ${p}`,
    );
  }
  const whereSql = where.join(' AND ');
  const total = (await pool.query(`SELECT count(*)::int AS n FROM donors dn WHERE ${whereSql}`, params)).rows[0].n;
  const sort = { name: 'lower(dn.name)', created_at: 'dn.created_at', donations: 'donation_count', value: 'total_value' }[f.sort];
  const scopeParams = [...params];
  const dScope = donationScopeSql(user, scopeParams, 'd');
  scopeParams.push(f.page_size, (f.page - 1) * f.page_size);
  const { rows } = await pool.query(
    `SELECT dn.id, dn.name, dn.donor_type, dn.contact_name, dn.contact_email, dn.contact_phone, dn.website, dn.social_media,
            dn.is_archived, dn.merged_into_id, dn.owner_id, ou.name AS owner_name, dn.created_at,
            count(d.id)::int AS donation_count, coalesce(sum(d.estimated_value_cad),0) AS total_value
     FROM donors dn
     LEFT JOIN users ou ON ou.id = dn.owner_id
     LEFT JOIN donations d ON d.donor_id = dn.id AND NOT d.is_archived AND ${dScope}
     WHERE ${whereSql}
     GROUP BY dn.id, ou.name
     ORDER BY ${sort} ${f.dir === 'asc' ? 'ASC' : 'DESC'}, dn.id
     LIMIT $${scopeParams.length - 1} OFFSET $${scopeParams.length}`,
    scopeParams,
  );
  res.json({ total, page: f.page, pageSize: f.page_size, rows: rows.map((r) => redactDonor(r, user)) });
});

donorsRouter.get('/export.csv', requirePermission('exports.run'), async (req, res) => {
  const user = req.user!;
  const params: unknown[] = [];
  const where = donorScopeSql(user, params);
  const { rows } = await pool.query(
    `SELECT dn.*, (SELECT count(*) FROM donations d WHERE d.donor_id = dn.id AND NOT d.is_archived)::int AS donation_count
     FROM donors dn WHERE ${where} AND dn.merged_into_id IS NULL ORDER BY lower(dn.name)`,
    params,
  );
  const contacts = canSeeContacts(user);
  const headers = [
    { key: 'id', label: 'DonorID' },
    { key: 'name', label: 'BusinessorDonor/Org' },
    { key: 'donor_type', label: 'Type' },
    ...(contacts
      ? [
          { key: 'contact_name', label: 'ContactName' },
          { key: 'contact_email', label: 'ContactEmail' },
          { key: 'contact_phone', label: 'ContactPhone' },
        ]
      : []),
    { key: 'website', label: 'BusinessWebsite' },
    ...(contacts ? [{ key: 'social', label: 'SocialMediaID' }] : []),
    { key: 'donation_count', label: 'Donations' },
    { key: 'is_archived', label: 'Archived' },
    { key: 'created_at', label: 'CreatedAt' },
  ];
  const data = rows.map((r) => ({
    ...r,
    social: (r.social_media ?? []).map((s: { platform: string; handle: string }) => `${s.platform}: ${s.handle}`).join('; '),
  }));
  await audit({ userId: user.id, action: 'export.donors', recordType: 'export', summary: `Exported ${rows.length} donors`, req });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="donors-${today()}.csv"`);
  res.send(toCsv(headers, data));
});

donorsRouter.get('/duplicates', requirePermission('donors.merge'), async (_req, res) => {
  res.json(await listDuplicatePairs());
});

donorsRouter.post('/duplicates/check', async (req, res) => {
  if (!can(req.user!, 'donors.view_all') && !can(req.user!, 'donors.create')) throw forbidden();
  const input = parse(z.object({ name: z.string().max(200).optional(), contact_email: z.string().max(320).optional(), contact_phone: z.string().max(40).optional(), exclude_id: z.coerce.number().int().optional() }), req.body);
  res.json(await findDuplicateDonors(input, input.exclude_id ?? null));
});

donorsRouter.post('/merge', requirePermission('donors.merge'), async (req, res) => {
  const { keep_id, merge_id } = parse(z.object({ keep_id: z.coerce.number().int().positive(), merge_id: z.coerce.number().int().positive(), confirm: z.literal(true) }), req.body);
  res.json(await withTransaction((db) => mergeDonors(keep_id, merge_id, req.user!, db)));
});

donorsRouter.post('/', requirePermission('donors.create'), async (req, res) => {
  const input = parse(donorInputSchema.extend({ confirm_not_duplicate: z.boolean().default(false) }), req.body);
  const dups = (await findDuplicateDonors(input)).filter((d) => d.score >= 50);
  if (dups.length && !input.confirm_not_duplicate) {
    throw conflict('This donor may already exist. Review the possible duplicates or confirm this is a new donor.', { duplicates: dups });
  }
  const { confirm_not_duplicate: _c, ...fields } = input;
  const donor = await createDonor(fields, req.user!);
  res.status(201).json(donor);
});

donorsRouter.get('/:id', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const user = req.user!;
  await assertDonorAccess(user, id);
  const donor = (
    await pool.query(
      `SELECT dn.*, ou.name AS owner_name, mi.name AS merged_into_name FROM donors dn
       LEFT JOIN users ou ON ou.id = dn.owner_id LEFT JOIN donors mi ON mi.id = dn.merged_into_id WHERE dn.id = $1`,
      [id],
    )
  ).rows[0];
  delete donor.norm_name;
  delete donor.norm_email;
  delete donor.norm_phone;
  const params: unknown[] = [id];
  const scope = donationScopeSql(user, params);
  const donations = (await pool.query(`${DONATION_SELECT} WHERE d.donor_id = $1 AND ${scope} ORDER BY d.created_at DESC`, params)).rows;
  const history = can(user, 'donors.edit')
    ? (
        await pool.query(
          `SELECT h.id, h.reason, h.changed_at, u.name AS changed_by_name, ${canSeeContacts(user) ? 'h.snapshot' : 'NULL AS snapshot'}
           FROM donor_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.donor_id = $1 ORDER BY h.changed_at DESC`,
          [id],
        )
      ).rows
    : null;
  const duplicates = can(user, 'donors.merge') ? await findDuplicateDonors(donor, id) : [];
  res.json({
    donor: redactDonor(donor, user),
    donations: donations.map((d) => serializeDonation(d, user)),
    history,
    duplicates,
    permissions: { edit: can(user, 'donors.edit'), merge: can(user, 'donors.merge'), delete: can(user, 'donors.delete') },
  });
});

donorsRouter.patch('/:id', requirePermission('donors.edit'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  const keys = Object.keys(req.body ?? {});
  const input = parse(donorInputSchema.partial(), req.body);
  const patch = Object.fromEntries(Object.entries(input).filter(([k]) => keys.includes(k)));
  const donor = await withTransaction((db) => updateDonor(id, patch, req.user!, db));
  res.json(redactDonor(donor, req.user!));
});

donorsRouter.post('/:id/archive', requirePermission('donors.delete'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  const r = await pool.query('UPDATE donors SET is_archived = true, archived_at = now(), updated_at = now() WHERE id = $1', [id]);
  if (!r.rowCount) throw notFound();
  await audit({ userId: req.user!.id, action: 'donor.archive', recordType: 'donor', recordId: id, summary: 'Archived donor', req });
  res.json({ ok: true });
});

donorsRouter.post('/:id/restore', requirePermission('donors.delete'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  const r = await pool.query('UPDATE donors SET is_archived = false, archived_at = NULL, updated_at = now() WHERE id = $1 AND merged_into_id IS NULL', [id]);
  if (!r.rowCount) throw conflict('Merged donors cannot be restored.');
  await audit({ userId: req.user!.id, action: 'donor.restore', recordType: 'donor', recordId: id, summary: 'Restored donor', req });
  res.json({ ok: true });
});

/**
 * Privacy request: removes a donor's personal contact information while
 * keeping anonymous donation records for the charity's financial history.
 */
donorsRouter.post('/:id/anonymize', requirePermission('donors.delete'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  parse(z.object({ confirm: z.literal(true) }), req.body);
  await withTransaction(async (db) => {
    const r = await db.query(
      `UPDATE donors SET name = 'Anonymized donor #' || id, contact_name = NULL, contact_email = NULL, contact_phone = NULL,
         website = NULL, social_media = '[]', public_display_name = NULL, norm_name = NULL, norm_email = NULL, norm_phone = NULL,
         is_archived = true, archived_at = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
    if (!r.rowCount) throw notFound();
    await db.query('DELETE FROM donor_history WHERE donor_id = $1', [id]);
    await db.query(
      `UPDATE donations SET pickup_address = NULL, pickup_instructions = NULL, pickup_preferred_dates = NULL,
         show_donor_name = false, show_website = false WHERE donor_id = $1`,
      [id],
    );
    await db.query(
      `UPDATE donation_submissions SET submission_data = submission_data - 'contact_name' - 'contact_email' - 'contact_phone' - 'pickup_address' - 'social_media' - 'website' || '{"donor_name":"(anonymized)"}',
         reviewed_data = CASE WHEN reviewed_data IS NULL THEN NULL ELSE reviewed_data - 'contact_name' - 'contact_email' - 'contact_phone' - 'pickup_address' - 'social_media' - 'website' || '{"donor_name":"(anonymized)"}' END
       WHERE linked_donor_id = $1`,
      [id],
    );
    await db.query(`UPDATE thank_you_messages SET recipient = NULL WHERE donation_id IN (SELECT id FROM donations WHERE donor_id = $1)`, [id]);
    await audit({ userId: req.user!.id, action: 'donor.anonymize', recordType: 'donor', recordId: id, summary: 'Personal information removed (privacy request)', req }, db);
  });
  res.json({ ok: true });
});

/** Permanent deletion is only possible for donors with no donations. */
donorsRouter.delete('/:id', requirePermission('donors.delete'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  const used = await pool.query('SELECT 1 FROM donations WHERE donor_id = $1 LIMIT 1', [id]);
  if (used.rows.length) throw conflict('This donor has donations. Archive or anonymize the donor instead.');
  await pool.query('UPDATE donation_submissions SET linked_donor_id = NULL WHERE linked_donor_id = $1', [id]);
  await pool.query('UPDATE donors SET merged_into_id = NULL WHERE merged_into_id = $1', [id]);
  const r = await pool.query('DELETE FROM donors WHERE id = $1', [id]);
  if (!r.rowCount) throw notFound();
  await audit({ userId: req.user!.id, action: 'donor.delete', recordType: 'donor', recordId: id, summary: 'Permanently deleted donor', req });
  res.json({ ok: true });
});
