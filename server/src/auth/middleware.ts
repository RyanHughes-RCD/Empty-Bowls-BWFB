import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { type AuthUser, type Permission, type Role, effectivePermissions } from './permissions.js';

declare module 'express-session' {
  interface SessionData {
    userId?: number;
    csrfToken?: string;
    authenticatedAt?: number;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function loadUser(userId: number): Promise<AuthUser | null> {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, account_status, must_change_password FROM users WHERE id = $1`,
    [userId],
  );
  const u = rows[0];
  if (!u || u.account_status !== 'active') return null;
  const overrides = (await pool.query('SELECT permission, granted FROM user_permissions WHERE user_id = $1', [userId])).rows;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role as Role,
    permissions: effectivePermissions(u.role as Role, overrides),
    mustChangePassword: u.must_change_password,
  };
}

/** Loads the signed-in user fresh from the database on every request, so role
 * changes and deactivations take effect immediately. */
export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.userId) {
    const user = await loadUser(req.session.userId);
    if (user) req.user = user;
    else {
      await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    }
  }
  next();
}

export function ensureCsrfToken(req: Request): string {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('base64url');
  return req.session.csrfToken;
}

/** Double-submit style CSRF protection for authenticated, state-changing requests. */
export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Sign-in has no session yet. Requiring a JSON body blocks cross-site HTML form
  // posts (which cannot send application/json without a CORS preflight).
  if (req.path === '/auth/login') {
    return req.is('application/json') ? next() : next(forbidden('Unsupported request.'));
  }
  const expected = req.session?.csrfToken;
  const provided = req.get('x-csrf-token');
  if (
    !expected ||
    !provided ||
    expected.length !== provided.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
  ) {
    return next(forbidden('Your session security token is missing or expired. Please refresh the page.'));
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  // Users with a temporary password may only change it.
  if (req.user.mustChangePassword && !req.path.startsWith('/auth/')) {
    return next(forbidden('You must change your temporary password before continuing.'));
  }
  next();
}

export function requirePermission(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!perms.some((p) => req.user!.permissions.has(p))) return next(forbidden());
    next();
  };
}
