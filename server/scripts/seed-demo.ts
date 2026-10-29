/**
 * Loads DEMO data for trying the application locally. Never run against a
 * production database. Refuses to run if any users exist unless --force.
 *
 *   DEMO_PASSWORD="choose-a-long-password" npm run seed-demo
 */
import { hashPassword } from '../src/auth/password.js';
import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closePools, pool } from '../src/db/pool.js';

async function main() {
  if (config.isProduction) throw new Error('Refusing to seed demo data in production.');
  const password = process.env.DEMO_PASSWORD;
  if (!password || password.length < 12) throw new Error('Set DEMO_PASSWORD (12+ characters).');
  await migrate(config.databaseUrl, config.databaseSsl);
  const users = await pool.query('SELECT count(*)::int AS n FROM users');
  if (users.rows[0].n > 0 && !process.argv.includes('--force')) throw new Error('Users already exist. Pass --force to add demo data anyway.');
  const hash = await hashPassword(password);
  const ids: Record<string, number> = {};
  for (const [role, name, email] of [
    ['super_admin', 'Sam Super', 'super@demo.test'],
    ['admin', 'Alex Admin', 'admin@demo.test'],
    ['owner', 'Olive Owner', 'owner@demo.test'],
    ['volunteer', 'Val Volunteer', 'volunteer@demo.test'],
  ]) {
    const r = await pool.query(
      `INSERT INTO users (name, email, role, password_hash) VALUES ($1,$2,$3,$4)
       ON CONFLICT ((lower(email))) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [name, email, role, hash],
    );
    ids[role] = r.rows[0].id;
  }
  const ev = await pool.query(
    `INSERT INTO events (code, name, event_date, location, description, status, accepting_submissions, created_by)
     VALUES ('empty-bowls-2026', 'Empty Bowls 2026', '2026-11-20', 'Community Hall', 'Our annual soup lunch and silent auction.', 'active', true, $1)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [ids.super_admin],
  );
  await pool.query(
    `INSERT INTO events (code, name, event_date, status, accepting_submissions, created_by)
     VALUES ('empty-bowls-2025', 'Empty Bowls 2025', '2025-11-21', 'closed', false, $1) ON CONFLICT (code) DO NOTHING`,
    [ids.super_admin],
  );
  console.log(`Demo users created (password from DEMO_PASSWORD): super@demo.test, admin@demo.test, owner@demo.test, volunteer@demo.test`);
  console.log(`Demo event #${ev.rows[0].id} "Empty Bowls 2026" is accepting submissions. Submit donations at ${config.appBaseUrl}/submit`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => closePools());
