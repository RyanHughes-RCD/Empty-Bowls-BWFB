import { z } from 'zod';
import type { AuthUser } from '../auth/permissions.js';
import { type Db, pool } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { normalizeEmail, normalizeName, normalizePhone } from '../lib/normalize.js';
import {
  optionalEmail,
  optionalPhone,
  optionalText,
  optionalUrl,
  requiredText,
  socialMediaSchema,
} from '../lib/validation.js';
import { audit, diff } from './audit.js';
import { canSeeContacts } from './access.js';

export const donorInputSchema = z.object({
  name: requiredText(200, 'Business, donor or organization name'),
  donor_type: z.enum(['business', 'individual', 'organization']).default('business'),
  contact_name: optionalText(200),
  contact_email: optionalEmail,
  contact_phone: optionalPhone,
  website: optionalUrl,
  social_media: socialMediaSchema,
  public_display_name: optionalText(200),
  owner_id: z.coerce.number().int().positive().nullable().optional(),
});
export type DonorInput = z.infer<typeof donorInputSchema>;

export const DONOR_CONTACT_FIELDS = ['contact_name', 'contact_email', 'contact_phone', 'social_media'] as const;

/** Removes private contact fields if the user may not see them. */
export function redactDonor<T extends Record<string, unknown>>(donor: T, user: AuthUser): T {
  if (canSeeContacts(user)) return donor;
  const copy: Record<string, unknown> = { ...donor };
  for (const f of DONOR_CONTACT_FIELDS) if (f in copy) copy[f] = null;
  copy.contact_hidden = true;
  return copy as T;
}

function normalized(input: { name: string; contact_email?: string | null; contact_phone?: string | null }) {
  return {
    norm_name: normalizeName(input.name),
    norm_email: normalizeEmail(input.contact_email),
    norm_phone: normalizePhone(input.contact_phone),
  };
}

export async function createDonor(input: DonorInput, actor: AuthUser | null, db: Db = pool, reason = 'created') {
  const n = normalized(input);
  const { rows } = await db.query(
    `INSERT INTO donors (name, donor_type, contact_name, contact_email, contact_phone, website, social_media,
                         public_display_name, owner_id, norm_name, norm_email, norm_phone, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      input.name,
      input.donor_type,
      input.contact_name,
      input.contact_email,
      input.contact_phone,
      input.website,
      JSON.stringify(input.social_media ?? []),
      input.public_display_name,
      input.owner_id ?? null,
      n.norm_name,
      n.norm_email,
      n.norm_phone,
      actor?.id ?? null,
    ],
  );
  await audit(
    { userId: actor?.id, action: 'donor.create', recordType: 'donor', recordId: rows[0].id, summary: `Created donor "${input.name}" (${reason})` },
    db,
  );
  return rows[0];
}

/** Updates a donor, saving a snapshot of the previous values in donor_history. */
export async function updateDonor(id: number, input: Partial<DonorInput>, actor: AuthUser, db: Db = pool, reason = 'edited') {
  const current = (await db.query('SELECT * FROM donors WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!current) throw notFound('Donor not found.');
  const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
  const fields = ['name', 'donor_type', 'contact_name', 'contact_email', 'contact_phone', 'website', 'social_media', 'public_display_name', 'owner_id'];
  const changes = diff(current, next, fields);
  if (!Object.keys(changes).length) return current;
  await db.query('INSERT INTO donor_history (donor_id, snapshot, reason, changed_by) VALUES ($1, $2, $3, $4)', [
    id,
    JSON.stringify(current),
    reason,
    actor.id,
  ]);
  const n = normalized(next);
  const { rows } = await db.query(
    `UPDATE donors SET name=$2, donor_type=$3, contact_name=$4, contact_email=$5, contact_phone=$6, website=$7,
            social_media=$8, public_display_name=$9, owner_id=$10, norm_name=$11, norm_email=$12, norm_phone=$13,
            updated_at=now()
     WHERE id=$1 RETURNING *`,
    [
      id,
      next.name,
      next.donor_type,
      next.contact_name,
      next.contact_email,
      next.contact_phone,
      next.website,
      JSON.stringify(next.social_media ?? []),
      next.public_display_name,
      next.owner_id,
      n.norm_name,
      n.norm_email,
      n.norm_phone,
    ],
  );
  await audit(
    {
      userId: actor.id,
      action: 'donor.update',
      recordType: 'donor',
      recordId: id,
      summary: `Updated donor "${next.name}" (${reason}): ${Object.keys(changes).join(', ')}`,
      // Contact values are deliberately not copied into the audit log.
      details: { fields: Object.keys(changes) },
    },
    db,
  );
  return rows[0];
}

export interface DuplicateMatch {
  id: number;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  score: number;
  reasons: string[];
}

/** Finds likely duplicate donors using email, phone and organization name. */
export async function findDuplicateDonors(
  candidate: { name?: string | null; contact_email?: string | null; contact_phone?: string | null },
  excludeId: number | null = null,
  db: Db = pool,
): Promise<DuplicateMatch[]> {
  const nName = normalizeName(candidate.name);
  const nEmail = normalizeEmail(candidate.contact_email);
  const nPhone = normalizePhone(candidate.contact_phone);
  const emailDomain = nEmail?.split('@')[1] ?? null;
  const freeMail = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'yahoo.ca', 'icloud.com', 'live.com', 'sympatico.ca', 'bell.net', 'rogers.com', 'shaw.ca', 'telus.net'];
  const { rows } = await db.query(
    `SELECT id, name, contact_name, contact_email, contact_phone, norm_name, norm_email, norm_phone
     FROM donors
     WHERE merged_into_id IS NULL AND ($4::int IS NULL OR id <> $4)
       AND ( ($1::text IS NOT NULL AND norm_email = $1)
          OR ($2::text IS NOT NULL AND norm_phone = $2)
          OR ($3::text IS NOT NULL AND (norm_name = $3 OR (length($3) >= 5 AND (norm_name LIKE '%' || $3 || '%' OR $3 LIKE '%' || norm_name || '%') AND length(norm_name) >= 5)))
          OR ($5::text IS NOT NULL AND norm_email LIKE '%@' || $5) )
     LIMIT 50`,
    [nEmail, nPhone, nName, excludeId, emailDomain && !freeMail.includes(emailDomain) ? emailDomain : null],
  );
  return rows
    .map((r) => {
      const reasons: string[] = [];
      let score = 0;
      if (nEmail && r.norm_email === nEmail) {
        score += 60;
        reasons.push('Same email address');
      } else if (emailDomain && r.norm_email?.endsWith(`@${emailDomain}`) && !freeMail.includes(emailDomain)) {
        score += 15;
        reasons.push('Same email domain');
      }
      if (nPhone && r.norm_phone === nPhone) {
        score += 50;
        reasons.push('Same phone number');
      }
      if (nName && r.norm_name === nName) {
        score += 50;
        reasons.push('Same name');
      } else if (nName && r.norm_name && (r.norm_name.includes(nName) || nName.includes(r.norm_name))) {
        score += 25;
        reasons.push('Similar name');
      }
      return {
        id: r.id,
        name: r.name,
        contact_name: r.contact_name,
        contact_email: r.contact_email,
        contact_phone: r.contact_phone,
        score: Math.min(score, 100),
        reasons,
      };
    })
    .filter((m) => m.score >= 25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

/** Finds pairs of existing donors that look like duplicates of each other. */
export async function listDuplicatePairs(db: Db = pool) {
  const { rows } = await db.query(
    `SELECT a.id AS a_id, a.name AS a_name, b.id AS b_id, b.name AS b_name,
            (a.norm_email IS NOT NULL AND a.norm_email = b.norm_email) AS same_email,
            (a.norm_phone IS NOT NULL AND a.norm_phone = b.norm_phone) AS same_phone,
            (a.norm_name = b.norm_name) AS same_name
     FROM donors a JOIN donors b ON a.id < b.id
     WHERE a.merged_into_id IS NULL AND b.merged_into_id IS NULL AND NOT a.is_archived AND NOT b.is_archived
       AND ((a.norm_email IS NOT NULL AND a.norm_email = b.norm_email)
         OR (a.norm_phone IS NOT NULL AND a.norm_phone = b.norm_phone)
         OR (a.norm_name IS NOT NULL AND a.norm_name = b.norm_name))
     ORDER BY a.name LIMIT 200`,
  );
  return rows.map((r) => ({
    a: { id: r.a_id, name: r.a_name },
    b: { id: r.b_id, name: r.b_name },
    reasons: [r.same_email && 'Same email address', r.same_phone && 'Same phone number', r.same_name && 'Same name'].filter(Boolean),
  }));
}

/**
 * Merges `mergeId` into `keepId`: moves donations and submissions, fills blank
 * fields on the kept record, and archives the merged record (never deleted).
 */
export async function mergeDonors(keepId: number, mergeId: number, actor: AuthUser, db: Db) {
  if (keepId === mergeId) throw badRequest('Choose two different donors to merge.');
  const [keep, merge] = await Promise.all([
    db.query('SELECT * FROM donors WHERE id = $1 FOR UPDATE', [keepId]),
    db.query('SELECT * FROM donors WHERE id = $1 FOR UPDATE', [mergeId]),
  ]).then((r) => r.map((x) => x.rows[0]));
  if (!keep || !merge) throw notFound('Donor not found.');
  if (keep.merged_into_id || merge.merged_into_id) throw conflict('One of these donors has already been merged.');

  const fill: Partial<DonorInput> = {};
  for (const f of ['contact_name', 'contact_email', 'contact_phone', 'website', 'public_display_name'] as const) {
    if (!keep[f] && merge[f]) fill[f] = merge[f];
  }
  const social = [...(keep.social_media ?? [])];
  for (const s of merge.social_media ?? []) {
    if (!social.some((x: { handle: string }) => x.handle.toLowerCase() === s.handle.toLowerCase())) social.push(s);
  }
  if (social.length !== (keep.social_media ?? []).length) fill.social_media = social;
  if (!keep.owner_id && merge.owner_id) fill.owner_id = merge.owner_id;
  if (Object.keys(fill).length) await updateDonor(keepId, fill, actor, db, `merged with donor #${mergeId}`);

  const moved = await db.query('UPDATE donations SET donor_id = $1, updated_at = now() WHERE donor_id = $2 RETURNING id', [keepId, mergeId]);
  await db.query('UPDATE donation_submissions SET linked_donor_id = $1 WHERE linked_donor_id = $2', [keepId, mergeId]);
  await db.query('INSERT INTO donor_history (donor_id, snapshot, reason, changed_by) VALUES ($1, $2, $3, $4)', [
    mergeId,
    JSON.stringify(merge),
    `merged into donor #${keepId}`,
    actor.id,
  ]);
  await db.query('UPDATE donors SET merged_into_id = $1, is_archived = true, archived_at = now(), updated_at = now() WHERE id = $2', [
    keepId,
    mergeId,
  ]);
  await audit(
    {
      userId: actor.id,
      action: 'donor.merge',
      recordType: 'donor',
      recordId: keepId,
      summary: `Merged donor #${mergeId} "${merge.name}" into #${keepId} "${keep.name}" (${moved.rowCount} donations moved)`,
    },
    db,
  );
  return { kept: keepId, merged: mergeId, donationsMoved: moved.rowCount };
}
