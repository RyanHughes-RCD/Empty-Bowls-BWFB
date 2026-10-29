import type { Request } from 'express';
import { type Db, pool } from '../db/pool.js';
import { hashIp } from '../lib/crypto.js';

export interface AuditEntry {
  userId?: number | null;
  action: string;
  recordType: string;
  recordId?: string | number | null;
  summary?: string;
  details?: unknown;
  req?: Request;
}

export async function audit(entry: AuditEntry, db: Db = pool): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (user_id, action, record_type, record_id, summary, details, ip_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.userId ?? entry.req?.user?.id ?? null,
      entry.action,
      entry.recordType,
      entry.recordId === undefined || entry.recordId === null ? null : String(entry.recordId),
      entry.summary ?? null,
      entry.details === undefined ? null : JSON.stringify(entry.details),
      entry.req ? hashIp(entry.req.ip) : null,
    ],
  );
}

/** Returns {field: {from, to}} for fields whose values differ. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>, fields?: string[]) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of fields ?? Object.keys(after)) {
    const a = before[key] instanceof Date ? (before[key] as Date).toISOString() : before[key];
    const b = after[key] instanceof Date ? (after[key] as Date).toISOString() : after[key];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changes[key] = { from: a ?? null, to: b ?? null };
  }
  return changes;
}
