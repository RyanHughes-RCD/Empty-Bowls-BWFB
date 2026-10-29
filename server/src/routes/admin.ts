import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../auth/middleware.js';
import { hashPassword, passwordProblems } from '../auth/password.js';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  ROLE_DEFAULTS,
  ROLE_LABELS,
  ROLES,
  type Permission,
  type Role,
  can,
  canGrant,
  effectivePermissions,
} from '../auth/permissions.js';
import { smtpConfigured } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { emailSchema, idParam, parse, requiredText } from '../lib/validation.js';
import { audit } from '../services/audit.js';
import { deleteStoredFile } from '../services/media.js';
import { getSettings, saveSettings, settingsSchema } from '../services/settings.js';
import { serveInternalMedia } from './donations.js';

export const adminRouter = Router();

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
adminRouter.get('/notifications', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, kind, message, link, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user!.id],
  );
  const unread = (await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user!.id])).rows[0].n;
  res.json({ unread, rows });
});

adminRouter.post('/notifications/read-all', async (req, res) => {
  await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user!.id]);
  res.json({ ok: true });
});

adminRouter.post('/notifications/:id/read', async (req, res) => {
  await pool.query('UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2', [parse(idParam, req.params.id), req.user!.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Internal media (authorization-checked; files are never statically served)
// ---------------------------------------------------------------------------
adminRouter.get('/media/:id', async (req, res) => {
  const id = parse(z.string().uuid(), req.params.id);
  const file = await serveInternalMedia(id, req.user!);
  res.set('Content-Type', file.mime);
  res.set('Cache-Control', 'private, max-age=300');
  res.set('X-Content-Type-Options', 'nosniff');
  res.sendFile(file.path);
});

// ---------------------------------------------------------------------------
// Users and permissions
// ---------------------------------------------------------------------------
/** Minimal list of active users for assignment dropdowns. */
adminRouter.get('/users/options', async (req, res) => {
  const u = req.user!;
  if (!['donations.assign', 'tasks.manage', 'tasks.view_all', 'submissions.review', 'users.manage', 'donors.edit'].some((p) => can(u, p as Permission))) {
    return res.json([{ id: u.id, name: u.name, role: u.role }]);
  }
  const { rows } = await pool.query(`SELECT id, name, role FROM users WHERE account_status = 'active' ORDER BY lower(name)`);
  res.json(rows);
});

adminRouter.get('/permissions/catalog', requirePermission('users.manage', 'users.manage_all'), (_req, res) => {
  res.json({ permissions: PERMISSIONS, roleDefaults: ROLE_DEFAULTS, roleLabels: ROLE_LABELS, roles: ROLES });
});

adminRouter.get('/users', requirePermission('users.manage', 'users.manage_all'), async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.account_status, u.must_change_password, u.created_at, u.last_login_at, u.locked_until,
            COALESCE(json_agg(json_build_object('permission', p.permission, 'granted', p.granted)) FILTER (WHERE p.permission IS NOT NULL), '[]') AS overrides
     FROM users u LEFT JOIN user_permissions p ON p.user_id = u.id GROUP BY u.id ORDER BY u.account_status, lower(u.name)`,
  );
  res.json(
    rows.map((r) => ({
      ...r,
      roleLabel: ROLE_LABELS[r.role as Role],
      effectivePermissions: [...effectivePermissions(r.role, r.overrides)].sort(),
    })),
  );
});

/** Admins (users.manage) may only manage Record Owner and Volunteer accounts. */
function assertCanManage(actor: Express.Request['user'], targetRole: Role, newRole?: Role) {
  if (can(actor, 'users.manage_all')) return;
  if (!can(actor, 'users.manage')) throw forbidden();
  const limited: Role[] = ['owner', 'volunteer'];
  if (!limited.includes(targetRole) || (newRole && !limited.includes(newRole))) {
    throw forbidden('Only a Super Admin can manage Admin or Super Admin accounts.');
  }
}

function tempPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

const createUserSchema = z.object({
  name: requiredText(200, 'Name'),
  email: emailSchema,
  role: z.enum(ROLES),
  password: z.string().max(200).optional(),
});

adminRouter.post('/users', requirePermission('users.manage', 'users.manage_all'), async (req, res) => {
  const input = parse(createUserSchema, req.body);
  assertCanManage(req.user, input.role, input.role);
  const exists = await pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [input.email]);
  if (exists.rows.length) throw badRequest('Please correct the highlighted fields.', { fields: { email: 'A user with this email already exists' } });
  const password = input.password || tempPassword();
  const problem = passwordProblems(password);
  if (problem) throw badRequest(problem, { fields: { password: problem } });
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, role, password_hash, must_change_password, created_by) VALUES ($1,$2,$3,$4,true,$5) RETURNING id`,
    [input.name, input.email, input.role, await hashPassword(password), req.user!.id],
  );
  await audit({ userId: req.user!.id, action: 'user.create', recordType: 'user', recordId: rows[0].id, summary: `Created ${ROLE_LABELS[input.role]} ${input.email}`, req });
  // The temporary password is shown once to the administrator; it must be changed at first sign-in.
  res.status(201).json({ id: rows[0].id, temporaryPassword: password });
});

adminRouter.patch('/users/:id', requirePermission('users.manage', 'users.manage_all'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  const input = parse(
    z.object({
      name: requiredText(200, 'Name').optional(),
      email: emailSchema.optional(),
      role: z.enum(ROLES).optional(),
      account_status: z.enum(['active', 'suspended', 'deactivated']).optional(),
      unlock: z.boolean().optional(),
    }),
    req.body,
  );
  await withTransaction(async (db) => {
    const target = (await db.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!target) throw notFound('User not found.');
    assertCanManage(req.user, target.role, input.role);
    if (id === req.user!.id && (input.role || input.account_status)) throw forbidden('You cannot change your own role or account status.');
    const removingSuper = target.role === 'super_admin' && ((input.role && input.role !== 'super_admin') || (input.account_status && input.account_status !== 'active'));
    if (removingSuper) {
      const others = await db.query(`SELECT count(*)::int AS n FROM users WHERE role = 'super_admin' AND account_status = 'active' AND id <> $1`, [id]);
      if (others.rows[0].n === 0) throw conflict('The last active Super Admin cannot be removed or demoted.');
    }
    if (input.email && input.email !== target.email.toLowerCase()) {
      const e = await db.query('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [input.email, id]);
      if (e.rows.length) throw badRequest('Please correct the highlighted fields.', { fields: { email: 'A user with this email already exists' } });
    }
    await db.query(
      `UPDATE users SET name = COALESCE($2, name), email = COALESCE($3, email), role = COALESCE($4, role),
         account_status = COALESCE($5, account_status),
         locked_until = CASE WHEN $6 THEN NULL ELSE locked_until END, failed_login_count = CASE WHEN $6 THEN 0 ELSE failed_login_count END,
         updated_at = now() WHERE id = $1`,
      [id, input.name ?? null, input.email ?? null, input.role ?? null, input.account_status ?? null, input.unlock === true],
    );
    if (input.role && input.role !== target.role) {
      // Overrides that are not grantable to the new role are removed.
      const overrides = (await db.query('SELECT permission FROM user_permissions WHERE user_id = $1 AND granted', [id])).rows;
      for (const o of overrides) {
        if (!canGrant(input.role, o.permission as Permission)) await db.query('DELETE FROM user_permissions WHERE user_id = $1 AND permission = $2', [id, o.permission]);
      }
    }
    if (input.account_status && input.account_status !== 'active') {
      await db.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = $1`, [id]);
    }
    await audit(
      {
        userId: req.user!.id,
        action: 'user.update',
        recordType: 'user',
        recordId: id,
        summary: `Updated user ${target.email}: ${Object.keys(input).join(', ')}`,
        details: { role: input.role ? { from: target.role, to: input.role } : undefined, account_status: input.account_status },
        req,
      },
      db,
    );
  });
  res.json({ ok: true });
});

adminRouter.post('/users/:id/reset-password', requirePermission('users.manage', 'users.manage_all'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  const target = (await pool.query('SELECT id, role, email FROM users WHERE id = $1', [id])).rows[0];
  if (!target) throw notFound('User not found.');
  assertCanManage(req.user, target.role);
  if (id === req.user!.id) throw badRequest('Use "Change password" to change your own password.');
  const password = tempPassword();
  await pool.query('UPDATE users SET password_hash = $2, must_change_password = true, failed_login_count = 0, locked_until = NULL WHERE id = $1', [
    id,
    await hashPassword(password),
  ]);
  await pool.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = $1`, [id]);
  await audit({ userId: req.user!.id, action: 'user.reset_password', recordType: 'user', recordId: id, summary: `Reset password for ${target.email}`, req });
  res.json({ temporaryPassword: password });
});

adminRouter.put('/users/:id/permissions', requirePermission('users.manage_all'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  const input = parse(
    z.object({ overrides: z.array(z.object({ permission: z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]), granted: z.boolean() })).max(100) }),
    req.body,
  );
  await withTransaction(async (db) => {
    const target = (await db.query('SELECT id, role, email FROM users WHERE id = $1', [id])).rows[0];
    if (!target) throw notFound('User not found.');
    if (target.role === 'super_admin') throw forbidden('Super Admin permissions cannot be changed.');
    if (id === req.user!.id) throw forbidden('You cannot change your own permissions.');
    for (const o of input.overrides) {
      if (o.granted && !canGrant(target.role, o.permission)) throw badRequest(`"${o.permission}" cannot be granted to a ${ROLE_LABELS[target.role as Role]}.`);
    }
    await db.query('DELETE FROM user_permissions WHERE user_id = $1', [id]);
    const defaults = new Set(ROLE_DEFAULTS[target.role as Role]);
    for (const o of input.overrides) {
      // Only store real differences from the role defaults.
      if (o.granted === defaults.has(o.permission)) continue;
      await db.query('INSERT INTO user_permissions (user_id, permission, granted, granted_by) VALUES ($1,$2,$3,$4)', [id, o.permission, o.granted, req.user!.id]);
    }
    await audit({ userId: req.user!.id, action: 'user.permissions', recordType: 'user', recordId: id, summary: `Updated permissions for ${target.email}`, details: input.overrides, req }, db);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
adminRouter.get('/audit', requirePermission('audit.view'), async (req, res) => {
  const f = parse(
    z.object({
      record_type: z.string().max(40).optional(),
      record_id: z.string().max(40).optional(),
      user_id: z.coerce.number().int().positive().optional(),
      action: z.string().max(60).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      page: z.coerce.number().int().min(1).default(1),
      page_size: z.coerce.number().int().min(1).max(200).default(50),
    }),
    req.query,
  );
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.record_type) add('a.record_type = ?', f.record_type);
  if (f.record_id) add('a.record_id = ?', f.record_id);
  if (f.user_id) add('a.user_id = ?', f.user_id);
  if (f.action) add('a.action LIKE ?', `${f.action.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  if (f.from) add('a.created_at >= ?::date', f.from);
  if (f.to) add(`a.created_at < (?::date + 1)`, f.to);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await pool.query(`SELECT count(*)::int AS n FROM audit_log a ${whereSql}`, params)).rows[0].n;
  params.push(f.page_size, (f.page - 1) * f.page_size);
  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.record_type, a.record_id, a.summary, a.details, a.created_at, a.user_id, u.name AS user_name
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${whereSql} ORDER BY a.created_at DESC, a.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({ total, page: f.page, pageSize: f.page_size, rows });
});

// ---------------------------------------------------------------------------
// Settings, statuses, retention
// ---------------------------------------------------------------------------
adminRouter.get('/settings', requirePermission('settings.manage'), async (_req, res) => {
  res.json({ settings: await getSettings(), system: { emailConfigured: smtpConfigured() } });
});

adminRouter.put('/settings', requirePermission('settings.manage'), async (req, res) => {
  const input = parse(settingsSchema.partial(), req.body);
  await saveSettings(input, req.user!.id);
  await audit({ userId: req.user!.id, action: 'settings.update', recordType: 'settings', summary: `Updated settings: ${Object.keys(input).join(', ')}`, req });
  res.json({ settings: await getSettings(), system: { emailConfigured: smtpConfigured() } });
});

adminRouter.get('/email-log', requirePermission('settings.manage'), async (_req, res) => {
  const { rows } = await pool.query('SELECT id, recipient, subject, purpose, status, error, created_at FROM email_log ORDER BY created_at DESC LIMIT 100');
  res.json(rows);
});

const statusSchema = z.object({
  code: z.string().trim().regex(/^[a-z_]{2,40}$/, 'Use lowercase letters and underscores'),
  label: requiredText(80, 'Label'),
  sort_order: z.coerce.number().int().min(0).max(10000),
  is_active: z.boolean().default(true),
  publishable: z.boolean().default(false),
  counts_as_approved: z.boolean().default(false),
});

adminRouter.post('/statuses', requirePermission('settings.manage'), async (req, res) => {
  const input = parse(statusSchema, req.body);
  await pool.query(
    'INSERT INTO donation_statuses (code, label, sort_order, is_active, publishable, counts_as_approved) VALUES ($1,$2,$3,$4,$5,$6)',
    [input.code, input.label, input.sort_order, input.is_active, input.publishable, input.counts_as_approved],
  );
  await audit({ userId: req.user!.id, action: 'status.create', recordType: 'status', recordId: input.code, summary: `Added status "${input.label}"`, req });
  res.status(201).json({ ok: true });
});

adminRouter.patch('/statuses/:code', requirePermission('settings.manage'), async (req, res) => {
  const code = parse(z.string().regex(/^[a-z_]{2,40}$/), req.params.code);
  const current = (await pool.query('SELECT * FROM donation_statuses WHERE code = $1', [code])).rows[0];
  if (!current) throw notFound();
  const input = parse(statusSchema.omit({ code: true }).partial(), req.body);
  if (current.is_system && (input.publishable !== undefined || input.counts_as_approved !== undefined || input.is_active === false)) {
    throw badRequest('Built-in statuses can be renamed and reordered, but not disabled or change meaning.');
  }
  await pool.query(
    `UPDATE donation_statuses SET label = COALESCE($2, label), sort_order = COALESCE($3, sort_order), is_active = COALESCE($4, is_active),
       publishable = COALESCE($5, publishable), counts_as_approved = COALESCE($6, counts_as_approved) WHERE code = $1`,
    [code, input.label ?? null, input.sort_order ?? null, input.is_active ?? null, input.publishable ?? null, input.counts_as_approved ?? null],
  );
  await audit({ userId: req.user!.id, action: 'status.update', recordType: 'status', recordId: code, summary: `Updated status "${code}"`, req });
  res.json({ ok: true });
});

/**
 * Data retention: removes personal information from declined / withdrawn
 * submissions older than the configured retention period. The submission
 * reference, dates and review history are kept for record-keeping.
 */
adminRouter.post('/settings/retention/run', requirePermission('settings.manage'), async (req, res) => {
  parse(z.object({ confirm: z.literal(true) }), req.body);
  const settings = await getSettings();
  const result = await withTransaction(async (db) => {
    const subs = await db.query(
      `UPDATE donation_submissions
       SET submission_data = jsonb_build_object('redacted', true, 'category', submission_data->'category', 'redacted_at', now()),
           reviewed_data = NULL, submitter_fingerprint = NULL, info_request_token_hash = NULL, updated_at = now()
       WHERE status IN ('declined','withdrawn') AND coalesce(reviewed_at, submitted_at) < now() - make_interval(days => $1)
         AND NOT (submission_data ? 'redacted')
       RETURNING id`,
      [settings.declined_retention_days],
    );
    const ids = subs.rows.map((r) => r.id);
    let files: string[] = [];
    if (ids.length) {
      await db.query(`UPDATE submission_events SET data = NULL, comment = CASE WHEN action = 'donor_response' THEN '[redacted]' ELSE comment END WHERE submission_id = ANY($1)`, [ids]);
      files = (await db.query('DELETE FROM donation_media WHERE submission_id = ANY($1) AND donation_id IS NULL RETURNING storage_key', [ids])).rows.map((r) => r.storage_key);
    }
    await db.query(`DELETE FROM user_sessions WHERE expire < now()`);
    await audit({ userId: req.user!.id, action: 'retention.run', recordType: 'settings', summary: `Retention cleanup redacted ${ids.length} declined/withdrawn submissions`, req }, db);
    return { redacted: ids.length, files };
  });
  for (const f of result.files) await deleteStoredFile(f);
  res.json({ redactedSubmissions: result.redacted, deletedImages: result.files.length });
});
