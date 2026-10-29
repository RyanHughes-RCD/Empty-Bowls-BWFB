import crypto from 'node:crypto';
import { config } from '../config.js';

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return crypto.createHmac('sha256', config.hashSalt).update(ip).digest('hex').slice(0, 32);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion

/** Submission reference like EB-2026-7KQ4-M9TX */
export function submissionReference(date = new Date()): string {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  return `EB-${date.getUTCFullYear()}-${code.slice(0, 4)}-${code.slice(4)}`;
}
