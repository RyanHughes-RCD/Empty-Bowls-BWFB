import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, publicPool } from '../src/db/pool.js';
import { isValidPhone } from '../src/lib/validation.js';
import { normalizeName, normalizePhone } from '../src/lib/normalize.js';
import { toCsv } from '../src/lib/csv.js';
import { createEvent, createUser, getApp, login, resetDatabase } from './helpers.js';

beforeAll(async () => {
  await resetDatabase();
  await createEvent('gala', 'Gala');
});
afterAll(async () => closePools());

describe('public database role (least privilege)', () => {
  it('cannot read private tables', async () => {
    for (const table of ['donors', 'donations', 'donation_notes', 'donation_submissions', 'users', 'follow_up_tasks', 'audit_log', 'user_sessions']) {
      await expect(publicPool.query(`SELECT * FROM ${table} LIMIT 1`)).rejects.toThrow(/permission denied/);
    }
  });
  it('cannot write anything', async () => {
    await expect(publicPool.query(`UPDATE donations SET publication_status = 'published'`)).rejects.toThrow(/permission denied/);
  });
  it('can read the public views', async () => {
    const r = await publicPool.query('SELECT * FROM public_events');
    expect(r.rows[0].code).toBe('gala');
  });
});

describe('authentication', () => {
  it('locks out after repeated failures and uses generic messages', async () => {
    await createUser('admin', 'Lock Test', 'lock@charity.test');
    for (let i = 0; i < 8; i++) {
      const r = await request(getApp()).post('/api/auth/login').send({ email: 'lock@charity.test', password: 'wrong-password-xx' });
      expect(r.status).toBe(401);
    }
    const r = await request(getApp()).post('/api/auth/login').send({ email: 'lock@charity.test', password: 'correct-horse-battery-staple' });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/locked/);
    const unknown = await request(getApp()).post('/api/auth/login').send({ email: 'nobody@x.test', password: 'whatever-pass' });
    expect(unknown.body.error).toBe('Email or password is incorrect.');
  });

  it('rejects form-encoded login posts (login CSRF)', async () => {
    const r = await request(getApp()).post('/api/auth/login').type('form').send({ email: 'a', password: 'b' });
    expect(r.status).toBe(403);
  });

  it('forces a temporary password to be changed', async () => {
    const sa = await createUser('super_admin', 'Root', 'root@charity.test');
    void sa;
    const root = await login('root@charity.test');
    const created = await root.post('/api/users', { name: 'Fresh', email: 'fresh@charity.test', role: 'volunteer' });
    const fresh = await login('fresh@charity.test', created.body.temporaryPassword);
    expect(fresh.user.mustChangePassword).toBe(true);
    expect((await fresh.get('/api/dashboard')).status).toBe(403);
    const ch = await fresh.post('/api/auth/change-password', { current_password: created.body.temporaryPassword, new_password: 'a-much-better-passphrase' });
    expect(ch.status).toBe(200);
    expect((await fresh.get('/api/dashboard')).status).toBe(200);
  });
});

describe('validation helpers', () => {
  it('accepts Canadian and international phone numbers', () => {
    for (const ok of ['905-555-0123', '(416) 555-0199', '+1 604 555 0100', '1-800-555-0199', '+44 20 7946 0958', '613.555.0101 ext 22']) {
      expect(isValidPhone(ok), ok).toBe(true);
    }
    for (const bad of ['12345', 'call me', '055-555-0123', '+1']) expect(isValidPhone(bad), bad).toBe(false);
  });
  it('normalizes donor names and phones for duplicate detection', () => {
    expect(normalizeName('Maple Leaf Bakery Inc.')).toBe(normalizeName('maple leaf bakery'));
    expect(normalizeName('Smith & Sons Ltd')).toBe('smith and sons');
    expect(normalizePhone('+1 (905) 555-0123')).toBe('9055550123');
  });
  it('neutralizes spreadsheet formulas in CSV', () => {
    const csv = toCsv([{ key: 'a', label: 'A' }], [{ a: '=1+1' }, { a: 'x,"y"' }]);
    expect(csv).toContain("'=1+1");
    expect(csv).toContain('"x,""y"""');
  });
});
