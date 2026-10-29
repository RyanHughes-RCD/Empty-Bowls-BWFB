import { type Permission, type Role, effectivePermissions } from '../auth/permissions.js';
import { type Db, pool } from '../db/pool.js';

export async function usersWithPermission(permission: Permission, db: Db = pool) {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.role,
            COALESCE(json_agg(json_build_object('permission', p.permission, 'granted', p.granted))
                     FILTER (WHERE p.permission IS NOT NULL), '[]') AS overrides
     FROM users u LEFT JOIN user_permissions p ON p.user_id = u.id
     WHERE u.account_status = 'active'
     GROUP BY u.id`,
  );
  return rows.filter((u) => effectivePermissions(u.role as Role, u.overrides).has(permission)) as {
    id: number;
    name: string;
    email: string;
  }[];
}

export async function notify(userIds: number[], kind: string, message: string, link: string | null, db: Db = pool) {
  for (const id of new Set(userIds)) {
    await db.query('INSERT INTO notifications (user_id, kind, message, link) VALUES ($1, $2, $3, $4)', [
      id,
      kind,
      message.slice(0, 500),
      link,
    ]);
  }
}
