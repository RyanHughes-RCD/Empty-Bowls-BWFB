import type { AuthUser } from '../auth/permissions.js';
import { can } from '../auth/permissions.js';
import { type Db, pool } from '../db/pool.js';
import { forbidden, notFound } from '../lib/errors.js';

/**
 * SQL condition restricting donations (alias `d`) to those the user may see.
 * Users without donations.view_all see only records that are assigned to them,
 * shared with them, created by them, owned by them (donor owner) or linked to
 * an open task assigned to them.
 */
export function donationScopeSql(user: AuthUser, params: unknown[], alias = 'd'): string {
  if (can(user, 'donations.view_all')) return 'TRUE';
  params.push(user.id);
  const p = `$${params.length}`;
  return `(${alias}.assigned_to = ${p}
    OR ${alias}.created_by = ${p}
    OR EXISTS (SELECT 1 FROM donation_shares ds WHERE ds.donation_id = ${alias}.id AND ds.user_id = ${p})
    OR EXISTS (SELECT 1 FROM donors dow WHERE dow.id = ${alias}.donor_id AND dow.owner_id = ${p})
    OR EXISTS (SELECT 1 FROM follow_up_tasks ft WHERE ft.donation_id = ${alias}.id AND ft.assigned_to = ${p}
               AND ft.status IN ('open', 'in_progress')))`;
}

/** SQL condition restricting donors (alias `dn`) to those the user may see. */
export function donorScopeSql(user: AuthUser, params: unknown[], alias = 'dn'): string {
  if (can(user, 'donors.view_all')) return 'TRUE';
  params.push(user.id);
  const p = `$${params.length}`;
  const donationScope = donationScopeSql(user, params, 'sd');
  return `(${alias}.owner_id = ${p} OR EXISTS (SELECT 1 FROM donations sd WHERE sd.donor_id = ${alias}.id AND ${donationScope}))`;
}

export async function canAccessDonation(user: AuthUser, donationId: number, db: Db = pool): Promise<boolean> {
  const params: unknown[] = [donationId];
  const scope = donationScopeSql(user, params);
  const { rows } = await db.query(`SELECT 1 FROM donations d WHERE d.id = $1 AND ${scope}`, params);
  return rows.length > 0;
}

/** Throws 404 if the donation does not exist, 403 if the user may not access it. */
export async function assertDonationAccess(user: AuthUser, donationId: number, db: Db = pool): Promise<void> {
  const exists = await db.query('SELECT 1 FROM donations WHERE id = $1', [donationId]);
  if (!exists.rows.length) throw notFound('Donation not found.');
  if (!(await canAccessDonation(user, donationId, db))) throw forbidden('You do not have access to this donation.');
}

export async function assertDonorAccess(user: AuthUser, donorId: number, db: Db = pool): Promise<void> {
  const exists = await db.query('SELECT 1 FROM donors WHERE id = $1', [donorId]);
  if (!exists.rows.length) throw notFound('Donor not found.');
  const params: unknown[] = [donorId];
  const scope = donorScopeSql(user, params);
  const { rows } = await db.query(`SELECT 1 FROM donors dn WHERE dn.id = $1 AND ${scope}`, params);
  if (!rows.length) throw forbidden('You do not have access to this donor.');
}

/** Contact details (email/phone/contact name) and pickup details visibility. */
export function canSeeContacts(user: AuthUser): boolean {
  return can(user, 'donors.view_all') || can(user, 'contacts.view_assigned');
}

export function canSeeNotes(user: AuthUser): boolean {
  return can(user, 'notes.view_all') || can(user, 'notes.assigned');
}
