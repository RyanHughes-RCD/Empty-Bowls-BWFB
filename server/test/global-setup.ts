import pg from 'pg';
import { migrate } from '../src/db/migrate.js';

/** Recreates the test database schema and the restricted public role once per run. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://eb_owner:devpass@localhost:5432/empty_bowls_test';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const role = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'eb_public_test'`);
  if (!role.rows.length) await client.query(`CREATE ROLE eb_public_test LOGIN PASSWORD 'publicpass'`);
  await client.end();
  await migrate(url, false, () => undefined);
  const c2 = new pg.Client({ connectionString: url });
  await c2.connect();
  await c2.query(`GRANT USAGE ON SCHEMA public TO eb_public_test`);
  await c2.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM eb_public_test`);
  await c2.query(`GRANT SELECT ON public_events, public_gallery_donations, public_gallery_media TO eb_public_test`);
  await c2.end();
}
