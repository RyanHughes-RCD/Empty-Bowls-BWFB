/**
 * PUBLIC (anonymous) API.
 *
 * Reads use ONLY the public_* database views through the restricted public
 * connection pool. These views contain explicitly approved public fields; no
 * contact details, notes, follow-ups, pickup data or assignments exist in them.
 * The only writes are new submissions and donor responses to info requests.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { publicPool } from '../db/pool.js';
import { hashIp } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { CATEGORIES, SUBCATEGORIES, parse } from '../lib/validation.js';
import { storagePath, storeImage } from '../services/media.js';
import { getPublicSettings, getSettings } from '../services/settings.js';
import { createSubmission, findInfoRequest, submissionSchema, submitDonorResponse } from '../services/submissions.js';

export const publicRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10, fieldSize: 100 * 1024 },
});

const submissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: config.isTest ? 1000 : config.publicSubmissionRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many submissions from your network. Please try again later or contact us directly.' },
});

const readLimiter = rateLimit({ windowMs: 60 * 1000, limit: config.isTest ? 10000 : 300, standardHeaders: 'draft-7', legacyHeaders: false });
publicRouter.use(readLimiter);

publicRouter.get('/settings', async (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(await getPublicSettings());
});

publicRouter.get('/events', async (_req, res) => {
  const { rows } = await publicPool.query(
    `SELECT id, code, name, event_date, description, location, accepting_submissions, gallery_enabled
     FROM public_events ORDER BY event_date DESC NULLS LAST, id DESC`,
  );
  res.json(rows);
});

// ---- Anti-spam: signed form token proves the form was loaded some seconds before submitting.
function signFormToken(ts: number) {
  return crypto.createHmac('sha256', config.sessionSecret).update(`form:${ts}`).digest('base64url');
}
publicRouter.get('/form-token', (_req, res) => {
  const ts = Date.now();
  res.set('Cache-Control', 'no-store');
  res.json({ token: `${ts}.${signFormToken(ts)}` });
});
function checkFormToken(token: unknown) {
  if (typeof token !== 'string') return false;
  const [tsStr, sig] = token.split('.');
  const ts = Number(tsStr);
  if (!ts || !sig) return false;
  const expected = signFormToken(ts);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const age = (Date.now() - ts) / 1000;
  return age >= config.minFormFillSeconds && age <= 24 * 60 * 60;
}

publicRouter.post('/submissions', submissionLimiter, upload.single('image'), async (req, res) => {
  const settings = await getSettings();
  if (!settings.submissions_enabled) throw badRequest('Donation submissions are currently closed. Please contact us directly.');
  let raw: Record<string, unknown>;
  try {
    raw = typeof req.body.data === 'string' ? JSON.parse(req.body.data) : req.body;
  } catch {
    throw badRequest('Invalid submission.');
  }
  // Honeypot: real people never see or fill this field.
  if (raw.company_fax || raw.website_confirm) {
    return res.status(201).json({ reference: 'EB-RECEIVED', message: settings.submission_confirmation_message });
  }
  if (!checkFormToken(raw.form_token)) {
    throw badRequest('Your form session expired or was submitted too quickly. Please reload the page and try again.');
  }
  const idempotencyKey = z.string().uuid().safeParse(raw.idempotency_key);
  const data = parse(submissionSchema, raw);
  let image = null;
  if (req.file) {
    if (!settings.image_uploads_enabled) throw badRequest('Image uploads are not enabled.');
    const stored = await storeImage(req.file.buffer);
    image = { ...stored, originalName: req.file.originalname, altText: typeof raw.image_alt === 'string' ? raw.image_alt.slice(0, 300) : null };
  }
  const result = await createSubmission({
    data,
    source: 'public_form',
    submittedBy: null,
    idempotencyKey: idempotencyKey.success ? idempotencyKey.data : null,
    fingerprint: hashIp(req.ip),
    image,
  });
  if (result.duplicate && image) await fs.promises.unlink(storagePath(image.storageKey)).catch(() => undefined);
  res.status(201).json({ reference: result.reference, message: settings.submission_confirmation_message });
});

// ---- Donor response to a "request more information" link
publicRouter.get('/info-request/:token', async (req, res) => {
  const row = await findInfoRequest(String(req.params.token));
  if (!row) throw notFound('This link has expired or has already been used.');
  res.set('Cache-Control', 'no-store');
  res.json({ reference: row.reference, message: row.info_request_message, event_name: row.event_name });
});

publicRouter.post('/info-request/:token', submissionLimiter, upload.single('image'), async (req, res) => {
  const token = String(req.params.token);
  const row = await findInfoRequest(token);
  if (!row) throw notFound('This link has expired or has already been used.');
  const response = typeof req.body.response === 'string' ? req.body.response : '';
  let image = null;
  if (req.file) image = { ...(await storeImage(req.file.buffer)), originalName: req.file.originalname };
  const result = await submitDonorResponse(token, response, image);
  res.status(201).json({ reference: result.reference });
});

// ---- Public gallery (approved & published donations only)
const galleryQuery = z.object({
  event: z.string().regex(/^[a-z0-9-]{2,60}$/).optional(),
  category: z.enum(CATEGORIES).optional(),
  subcategory: z.enum(SUBCATEGORIES).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(24),
});

publicRouter.get('/gallery', async (req, res) => {
  const f = parse(galleryQuery, req.query);
  const params: unknown[] = [];
  const where: string[] = [];
  if (f.event) {
    params.push(f.event);
    where.push(`g.event_code = $${params.length}`);
  }
  if (f.category) {
    params.push(f.category);
    where.push(`g.category = $${params.length}`);
  }
  if (f.subcategory) {
    params.push(f.subcategory);
    where.push(`g.subcategory = $${params.length}`);
  }
  if (f.q) {
    params.push(`%${f.q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    where.push(`(lower(coalesce(g.title,'')) LIKE $${params.length} OR lower(g.description) LIKE $${params.length}
                 OR lower(coalesce(g.donor_name,'')) LIKE $${params.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const summary = (
    await publicPool.query(
      `SELECT count(*)::int AS count, coalesce(sum(g.estimated_value_cad), 0) AS disclosed_value,
              count(DISTINCT g.donor_name)::int AS donor_count
       FROM public_gallery_donations g ${whereSql}`,
      params,
    )
  ).rows[0];
  const byCategory = (
    await publicPool.query(
      `SELECT g.category, count(*)::int AS count FROM public_gallery_donations g ${f.event ? 'WHERE g.event_code = $1' : ''} GROUP BY g.category`,
      f.event ? [f.event] : [],
    )
  ).rows;
  params.push(f.page_size, (f.page - 1) * f.page_size);
  const { rows } = await publicPool.query(
    `SELECT g.id, g.event_code, g.event_name, g.category, g.subcategory, g.title, g.description, g.quantity,
            g.estimated_value_cad, g.donor_name, g.donor_website, g.published_at,
            COALESCE((SELECT json_agg(json_build_object('id', m.id, 'alt', m.alt_text) ORDER BY m.sort_order)
                      FROM public_gallery_media m WHERE m.donation_id = g.id), '[]') AS images
     FROM public_gallery_donations g ${whereSql}
     ORDER BY g.category, g.published_at DESC, g.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  // Not cached, so publishing / unpublishing takes effect immediately.
  res.set('Cache-Control', 'no-cache');
  res.json({ summary, byCategory, page: f.page, pageSize: f.page_size, donations: rows });
});

publicRouter.get('/media/:id', async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) throw notFound();
  const m = (await publicPool.query('SELECT storage_key, mime_type FROM public_gallery_media WHERE id = $1', [req.params.id])).rows[0];
  if (!m) throw notFound('Image not found.');
  res.set('Content-Type', m.mime_type);
  res.set('Cache-Control', 'no-cache');
  res.set('X-Content-Type-Options', 'nosniff');
  res.sendFile(storagePath(m.storage_key));
});
