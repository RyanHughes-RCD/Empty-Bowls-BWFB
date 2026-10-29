import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Applies any SQL migrations that have not yet been applied, in filename order. */
export async function migrate(connectionString: string, ssl = false, log = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString, ssl: ssl ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  const applied: string[] = [];
  try {
    // Serialize concurrent migrators (e.g. two app instances starting at once).
    await client.query('SELECT pg_advisory_lock(727274001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`Applied migration ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274001)').catch(() => undefined);
    await client.end();
  }
  return applied;
}
