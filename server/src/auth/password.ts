import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

// OWASP-recommended scrypt parameters (N=2^17, r=8, p=1).
// (A lower cost is used only in the automated test suite to keep it fast.)
const PARAMS = { N: process.env.NODE_ENV === 'test' ? 16384 : 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  });
  return crypto.timingSafeEqual(key, expected);
}

// A precomputed hash so failed lookups take the same time as real ones.
let dummyHash: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

export function passwordProblems(password: string): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters long.';
  if (password.length > 200) return 'Password is too long.';
  if (/^(.)\1+$/.test(password)) return 'Password is too simple.';
  const common = ['password1234', '123456789012', 'qwertyuiopas', 'emptybowls123'];
  if (common.includes(password.toLowerCase())) return 'Password is too common.';
  return null;
}
