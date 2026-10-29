import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { pool } from '../src/db/pool.js';

let app: Express | null = null;
export function getApp(): Express {
  app ??= createApp();
  return app;
}

export const PASSWORD = 'correct-horse-battery-staple';

export async function resetDatabase() {
  const { rows } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations', 'donation_statuses')`,
  );
  await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM donation_statuses WHERE NOT is_system`);
}

let hash: string | null = null;
export async function createUser(role: string, name: string, email: string, overrides: { permission: string; granted: boolean }[] = []) {
  hash ??= await hashPassword(PASSWORD);
  const { rows } = await pool.query('INSERT INTO users (name, email, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [name, email, role, hash]);
  for (const o of overrides) {
    await pool.query('INSERT INTO user_permissions (user_id, permission, granted) VALUES ($1,$2,$3)', [rows[0].id, o.permission, o.granted]);
  }
  return rows[0].id as number;
}

/** A logged-in client that automatically sends the CSRF token. */
export async function login(email: string, password = PASSWORD) {
  const agent = request.agent(getApp());
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.csrfToken as string;
  return {
    agent,
    user: res.body.user,
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => agent.post(url).set('X-CSRF-Token', csrf).send(body ?? {}),
    put: (url: string, body?: object) => agent.put(url).set('X-CSRF-Token', csrf).send(body ?? {}),
    patch: (url: string, body?: object) => agent.patch(url).set('X-CSRF-Token', csrf).send(body ?? {}),
    del: (url: string) => agent.delete(url).set('X-CSRF-Token', csrf),
    csrf,
  };
}
export type Client = Awaited<ReturnType<typeof login>>;

export async function createEvent(code: string, name: string, accepting = true) {
  const { rows } = await pool.query(
    `INSERT INTO events (code, name, event_date, status, accepting_submissions) VALUES ($1,$2,'2026-11-20','active',$3) RETURNING id`,
    [code, name, accepting],
  );
  return rows[0].id as number;
}

export async function formToken() {
  const res = await request(getApp()).get('/api/public/form-token');
  return res.body.token as string;
}

export function sampleSubmission(eventId: number, overrides: Record<string, unknown> = {}) {
  return {
    event_id: eventId,
    donor_name: 'Maple Leaf Bakery',
    contact_name: 'Jane Baker',
    contact_email: 'jane@mapleleafbakery.ca',
    contact_phone: '905-555-0123',
    website: 'mapleleafbakery.ca',
    social_media: '@mapleleafbakery',
    category: 'food',
    subcategory: 'bread',
    description: 'Twenty loaves of fresh sourdough bread for the soup lunch',
    quantity: 20,
    estimated_value_cad: '160.00',
    delivery_method: 'pickup_required',
    pickup_address: '123 Secret Lane, Hamilton ON',
    availability: 'Weekday mornings',
    logistics_notes: 'Use back door, ring bell twice',
    public_consent: true,
    privacy_acknowledged: true,
    ...overrides,
  };
}

/** Submits through the public form exactly as a browser would (multipart, form token). */
export async function submitPublic(data: Record<string, unknown>, image?: Buffer) {
  const token = await formToken();
  const req = request(getApp())
    .post('/api/public/submissions')
    .field('data', JSON.stringify({ ...data, form_token: token }));
  if (image) req.attach('image', image, 'photo.png');
  return req;
}

// Smallest valid PNG
export const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);
