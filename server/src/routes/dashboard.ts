import { Router } from 'express';
import { z } from 'zod';
import { can } from '../auth/permissions.js';
import { today } from '../config.js';
import { pool } from '../db/pool.js';
import { parse } from '../lib/validation.js';
import { donationScopeSql } from '../services/access.js';

export const dashboardRouter = Router();

async function defaultEventId(): Promise<number | null> {
  const r = await pool.query(
    `SELECT id FROM events ORDER BY (status = 'active') DESC, (status = 'planning') DESC, event_date DESC NULLS LAST, id DESC LIMIT 1`,
  );
  return r.rows[0]?.id ?? null;
}

dashboardRouter.get('/', async (req, res) => {
  const user = req.user!;
  const q = parse(z.object({ event_id: z.coerce.number().int().positive().optional() }), req.query);
  const eventId = q.event_id ?? (await defaultEventId());
  const t = today();

  let cards: Record<string, number> | null = null;
  if (eventId) {
    const params: unknown[] = [eventId, t];
    const scope = donationScopeSql(user, params);
    const d = (
      await pool.query(
        `SELECT
           count(*)::int AS donations,
           count(*) FILTER (WHERE s.counts_as_approved)::int AS approved,
           count(*) FILTER (WHERE d.publication_status = 'published')::int AS published,
           coalesce(sum(d.estimated_value_cad) FILTER (WHERE s.counts_as_approved), 0) AS total_value,
           count(*) FILTER (WHERE s.counts_as_approved AND NOT d.item_received
                            AND (d.delivery_method = 'pickup_required' OR d.pickup_scheduled_for IS NOT NULL))::int AS awaiting_pickup,
           count(*) FILTER (WHERE d.item_received)::int AS items_received,
           count(*) FILTER (WHERE s.counts_as_approved AND d.thank_you_required AND NOT d.thank_you_sent)::int AS thank_you_outstanding,
           count(*) FILTER (WHERE d.next_follow_up_date = $2)::int AS follow_ups_today,
           count(*) FILTER (WHERE d.next_follow_up_date < $2)::int AS follow_ups_overdue
         FROM donations d JOIN donation_statuses s ON s.code = d.status
         WHERE d.event_id = $1 AND NOT d.is_archived AND ${scope}`,
        params,
      )
    ).rows[0];
    let submitted = d.donations;
    let awaitingReview = 0;
    if (can(user, 'submissions.review')) {
      const s = (
        await pool.query(
          `SELECT count(*)::int AS submitted,
                  count(*) FILTER (WHERE status IN ('pending_review','awaiting_donor_info'))::int AS awaiting
           FROM donation_submissions WHERE event_id = $1`,
          [eventId],
        )
      ).rows[0];
      // Submissions plus donations added directly by staff (which never had a submission).
      const direct = (await pool.query('SELECT count(*)::int AS n FROM donations WHERE event_id = $1 AND submission_id IS NULL AND NOT is_archived', [eventId])).rows[0].n;
      submitted = s.submitted + direct;
      awaitingReview = s.awaiting;
    }
    cards = { total_submitted: submitted, awaiting_review: awaitingReview, ...d };
  }

  const tasks = (
    await pool.query(
      `SELECT count(*) FILTER (WHERE status IN ('open','in_progress'))::int AS open,
              count(*) FILTER (WHERE status IN ('open','in_progress') AND due_date < $2)::int AS overdue,
              count(*) FILTER (WHERE status IN ('open','in_progress') AND due_date = $2)::int AS today
       FROM follow_up_tasks WHERE assigned_to = $1`,
      [user.id, t],
    )
  ).rows[0];
  res.json({ eventId, today: t, cards, myTasks: tasks, canReview: can(user, 'submissions.review') });
});
