/**
 * Least-privilege database roles (recommended for production).
 *
 * Creates/updates two login roles:
 *   APP_DB_ROLE    - used by the application (DATABASE_URL). Can read/write
 *                    data tables but cannot change the schema.
 *   PUBLIC_DB_ROLE - used for anonymous public pages (PUBLIC_DATABASE_URL).
 *                    Can ONLY read the public_* views. It cannot read donors,
 *                    contacts, notes, submissions, users or anything else.
 *
 * Run with an owner/admin connection AFTER migrations:
 *   ADMIN_DATABASE_URL=postgres://owner:...@host/db \
 *   APP_DB_PASSWORD=... PUBLIC_DB_PASSWORD=... npm run setup-db-roles
 */
import pg from 'pg';

const adminUrl = process.env.ADMIN_DATABASE_URL;
const appRole = process.env.APP_DB_ROLE ?? 'charity_app';
const publicRole = process.env.PUBLIC_DB_ROLE ?? 'charity_public';
const appPassword = process.env.APP_DB_PASSWORD;
const publicPassword = process.env.PUBLIC_DB_PASSWORD;

function ident(s: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(s)) throw new Error(`Invalid role name ${s}`);
  return `"${s}"`;
}

async function main() {
  if (!adminUrl || !appPassword || !publicPassword) {
    console.error('Set ADMIN_DATABASE_URL, APP_DB_PASSWORD and PUBLIC_DB_PASSWORD.');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: adminUrl, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  const lit = (s: string) => client.escapeLiteral(s);
  const app = ident(appRole);
  const pub = ident(publicRole);
  try {
    for (const [role, pw] of [
      [appRole, appPassword],
      [publicRole, publicPassword],
    ]) {
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      // New roles get no superuser / createdb / createrole rights (PostgreSQL defaults). Re-running only resets the password.
      if (exists.rows.length) await client.query(`ALTER ROLE ${ident(role)} LOGIN PASSWORD ${lit(pw)}`);
      else await client.query(`CREATE ROLE ${ident(role)} LOGIN PASSWORD ${lit(pw)} NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    }
    const db = (await client.query('SELECT current_database() AS d')).rows[0].d;
    await client.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${app}, ${pub}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${app}, ${pub}`);

    // Application role: data access only (no DDL).
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${app}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${app}`);
    // Tables created by future migrations (run as this owner role) get the same grants automatically.
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${app}`);
    await client.query(`REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ${app}`);
    await client.query(`REVOKE UPDATE, DELETE ON audit_log FROM ${app}`); // audit log is append-only for the app

    // Public role: nothing except the public views.
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${pub}`);
    await client.query(`GRANT SELECT ON public_events, public_gallery_donations, public_gallery_media TO ${pub}`);
    console.log(`Roles ready.\n  DATABASE_URL should use ${appRole} (set AUTO_MIGRATE=false and run migrations with the owner role).\n  PUBLIC_DATABASE_URL should use ${publicRole}.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
