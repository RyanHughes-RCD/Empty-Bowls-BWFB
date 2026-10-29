import pg from 'pg';
import { config } from '../config.js';

// Return DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);
// numeric -> number (values are monetary amounts well within double precision)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// bigint counts -> number
pg.types.setTypeParser(20, (v) => Number(v));

const ssl = config.databaseSsl ? { rejectUnauthorized: false } : undefined;

/** Main application pool (internal, authorization enforced in the service layer). */
export const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl, max: 10 });

/**
 * Public pool. In production, point PUBLIC_DATABASE_URL at a role that can
 * only SELECT from the public_* views (see scripts/setup-db-roles.ts).
 */
export const publicPool = new pg.Pool({ connectionString: config.publicDatabaseUrl, ssl, max: 5 });

export type Db = pg.Pool | pg.PoolClient;

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closePools(): Promise<void> {
  await Promise.all([pool.end(), publicPool.end()]);
}
