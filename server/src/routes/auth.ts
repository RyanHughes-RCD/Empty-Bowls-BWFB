import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { ensureCsrfToken, loadUser } from '../auth/middleware.js';
import { getDummyHash, hashPassword, passwordProblems, verifyPassword } from '../auth/password.js';
import { PERMISSIONS, ROLE_LABELS } from '../auth/permissions.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { parse } from '../lib/validation.js';
import { audit } from '../services/audit.js';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' },
});

const MAX_FAILED = 8;

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().trim().toLowerCase().max(320), password: z.string().max(200) }), req.body);
  const user = (await pool.query('SELECT * FROM users WHERE lower(email) = $1', [email])).rows[0];
  if (!user) {
    await verifyPassword(password, await getDummyHash()); // equalize timing
    throw unauthorized('Email or password is incorrect.');
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw unauthorized('This account is temporarily locked after too many failed attempts. Try again in 15 minutes.');
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    const failed = user.failed_login_count + 1;
    const lock = failed >= MAX_FAILED;
    await pool.query(
      `UPDATE users SET failed_login_count = $2::int, locked_until = CASE WHEN $3::boolean THEN now() + interval '15 minutes' END WHERE id = $1`,
      [user.id, lock ? 0 : failed, lock],
    );
    await audit({ userId: user.id, action: 'auth.login_failed', recordType: 'user', recordId: user.id, req });
    throw unauthorized('Email or password is incorrect.');
  }
  if (user.account_status !== 'active') throw unauthorized('This account is not active. Contact an administrator.');

  await new Promise<void>((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = user.id;
  req.session.authenticatedAt = Date.now();
  const csrfToken = ensureCsrfToken(req);
  await pool.query('UPDATE users SET last_login_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);
  await audit({ userId: user.id, action: 'auth.login', recordType: 'user', recordId: user.id, req });
  const authUser = await loadUser(user.id);
  res.json({ user: serializeUser(authUser!), csrfToken });
});

authRouter.post('/logout', async (req, res) => {
  if (req.user) await audit({ userId: req.user.id, action: 'auth.logout', recordType: 'user', recordId: req.user.id, req });
  await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
  res.clearCookie('eb.sid');
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null, csrfToken: null });
  res.json({ user: serializeUser(req.user), csrfToken: ensureCsrfToken(req) });
});

authRouter.post('/change-password', async (req, res) => {
  if (!req.user) throw unauthorized();
  const { current_password, new_password } = parse(
    z.object({ current_password: z.string().max(200), new_password: z.string().max(200) }),
    req.body,
  );
  const row = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!(await verifyPassword(current_password, row.password_hash))) throw badRequest('Your current password is incorrect.');
  const problem = passwordProblems(new_password);
  if (problem) throw badRequest(problem, { fields: { new_password: problem } });
  if (current_password === new_password) throw badRequest('Choose a new password that is different from the current one.');
  await pool.query('UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [
    req.user.id,
    await hashPassword(new_password),
  ]);
  // Invalidate the user's other sessions.
  await pool.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = $1 AND sid <> $2`, [req.user.id, req.sessionID]);
  await audit({ userId: req.user.id, action: 'auth.password_changed', recordType: 'user', recordId: req.user.id, req });
  res.json({ ok: true });
});

export function serializeUser(u: NonNullable<Awaited<ReturnType<typeof loadUser>>>) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    roleLabel: ROLE_LABELS[u.role],
    permissions: [...u.permissions].filter((p) => p in PERMISSIONS).sort(),
    mustChangePassword: u.mustChangePassword,
  };
}
