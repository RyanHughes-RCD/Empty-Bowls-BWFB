import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../auth/middleware.js';
import { can } from '../auth/permissions.js';
import { pool } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { dateSchema, idParam, optionalText, parse, requiredText } from '../lib/validation.js';
import { audit, diff } from '../services/audit.js';

export const eventsRouter = Router();

const eventSchema = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,59}$/, 'Use 2-60 lowercase letters, numbers and dashes (e.g. empty-bowls-2026)'),
  name: requiredText(200, 'Event name'),
  event_date: dateSchema,
  description: optionalText(5000),
  location: optionalText(500),
  status: z.enum(['planning', 'active', 'closed', 'archived']).default('planning'),
  accepting_submissions: z.boolean().default(false),
  gallery_enabled: z.boolean().default(true),
});

/** Any signed-in user can list events (needed for filters and forms). */
eventsRouter.get('/', async (req, res) => {
  const withStats = can(req.user!, 'reports.view') || can(req.user!, 'events.manage');
  const { rows } = await pool.query(
    `SELECT e.*, ${
      withStats
        ? `(SELECT count(*) FROM donations d WHERE d.event_id = e.id AND NOT d.is_archived)::int AS donation_count,
           (SELECT coalesce(sum(estimated_value_cad),0) FROM donations d JOIN donation_statuses s ON s.code = d.status
             WHERE d.event_id = e.id AND NOT d.is_archived AND s.counts_as_approved) AS approved_value,
           (SELECT count(*) FROM donation_submissions s WHERE s.event_id = e.id AND s.status IN ('pending_review','awaiting_donor_info'))::int AS pending_submissions`
        : 'NULL AS donation_count'
    }
     FROM events e ORDER BY (e.status = 'active') DESC, e.event_date DESC NULLS LAST, e.id DESC`,
  );
  res.json(rows);
});

eventsRouter.post('/', requirePermission('events.manage'), async (req, res) => {
  const input = parse(eventSchema, req.body);
  if (['closed', 'archived'].includes(input.status) && input.accepting_submissions) {
    throw badRequest('A closed event cannot accept submissions.', { fields: { accepting_submissions: 'Closed events cannot accept submissions' } });
  }
  const exists = await pool.query('SELECT 1 FROM events WHERE code = $1', [input.code]);
  if (exists.rows.length) throw badRequest('Please correct the highlighted fields.', { fields: { code: 'This event code is already used' } });
  const { rows } = await pool.query(
    `INSERT INTO events (code, name, event_date, description, location, status, accepting_submissions, gallery_enabled, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [input.code, input.name, input.event_date, input.description, input.location, input.status, input.accepting_submissions, input.gallery_enabled, req.user!.id],
  );
  await audit({ userId: req.user!.id, action: 'event.create', recordType: 'event', recordId: rows[0].id, summary: `Created event "${input.name}"`, req });
  res.status(201).json(rows[0]);
});

eventsRouter.get('/:id', async (req, res) => {
  const id = parse(idParam, req.params.id);
  const ev = (await pool.query('SELECT * FROM events WHERE id = $1', [id])).rows[0];
  if (!ev) throw notFound('Event not found.');
  res.json(ev);
});

eventsRouter.patch('/:id', requirePermission('events.manage'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  const current = (await pool.query('SELECT * FROM events WHERE id = $1', [id])).rows[0];
  if (!current) throw notFound('Event not found.');
  const input = parse(eventSchema, { ...current, ...req.body });
  if (['closed', 'archived'].includes(input.status)) input.accepting_submissions = false;
  if (input.code !== current.code) {
    const exists = await pool.query('SELECT 1 FROM events WHERE code = $1 AND id <> $2', [input.code, id]);
    if (exists.rows.length) throw badRequest('Please correct the highlighted fields.', { fields: { code: 'This event code is already used' } });
  }
  const { rows } = await pool.query(
    `UPDATE events SET code=$2, name=$3, event_date=$4, description=$5, location=$6, status=$7, accepting_submissions=$8,
       gallery_enabled=$9, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, input.code, input.name, input.event_date, input.description, input.location, input.status, input.accepting_submissions, input.gallery_enabled],
  );
  const changes = diff(current, rows[0], ['code', 'name', 'event_date', 'description', 'location', 'status', 'accepting_submissions', 'gallery_enabled']);
  await audit({ userId: req.user!.id, action: 'event.update', recordType: 'event', recordId: id, summary: `Updated event: ${Object.keys(changes).join(', ')}`, details: changes, req });
  res.json(rows[0]);
});
