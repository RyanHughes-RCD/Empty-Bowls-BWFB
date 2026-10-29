import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../auth/middleware.js';
import { today } from '../config.js';
import { pool } from '../db/pool.js';
import { toCsv } from '../lib/csv.js';
import { notFound } from '../lib/errors.js';
import { CATEGORY_LABELS, SUBCATEGORY_LABELS, idParam, parse } from '../lib/validation.js';
import { audit } from '../services/audit.js';

export const reportsRouter = Router();
reportsRouter.use(requirePermission('reports.view'));

/** Event-level report. Every query is filtered by event_id so events never mix. */
async function eventReport(eventId: number) {
  const event = (await pool.query('SELECT id, code, name, event_date, status FROM events WHERE id = $1', [eventId])).rows[0];
  if (!event) throw notFound('Event not found.');
  const t = today();
  const base = `FROM donations d JOIN donation_statuses s ON s.code = d.status WHERE d.event_id = $1 AND NOT d.is_archived`;
  const [subs, summary, byCategory, bySub, byDonor] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS submitted,
              count(*) FILTER (WHERE status = 'approved')::int AS approved,
              count(*) FILTER (WHERE status = 'declined')::int AS declined,
              count(*) FILTER (WHERE status IN ('pending_review','awaiting_donor_info'))::int AS awaiting_review
       FROM donation_submissions WHERE event_id = $1`,
      [eventId],
    ),
    pool.query(
      `SELECT count(*)::int AS donations,
              count(*) FILTER (WHERE d.submission_id IS NULL)::int AS added_directly,
              count(*) FILTER (WHERE s.counts_as_approved)::int AS approved,
              count(*) FILTER (WHERE d.publication_status = 'published')::int AS published,
              coalesce(sum(d.estimated_value_cad) FILTER (WHERE s.counts_as_approved), 0) AS approved_value,
              coalesce(sum(d.quantity) FILTER (WHERE s.counts_as_approved), 0)::int AS approved_units,
              count(*) FILTER (WHERE s.counts_as_approved AND NOT d.item_received
                               AND (d.delivery_method = 'pickup_required' OR d.pickup_scheduled_for IS NOT NULL))::int AS awaiting_pickup,
              count(*) FILTER (WHERE d.item_received)::int AS received,
              count(*) FILTER (WHERE s.counts_as_approved AND d.thank_you_required AND NOT d.thank_you_sent)::int AS thank_you_outstanding,
              count(*) FILTER (WHERE d.thank_you_sent)::int AS thank_you_sent,
              count(*) FILTER (WHERE d.next_follow_up_date < $2)::int AS overdue_follow_ups
       ${base}`,
      [eventId, t],
    ),
    pool.query(
      `SELECT d.category, count(*)::int AS count, coalesce(sum(d.quantity),0)::int AS units, coalesce(sum(d.estimated_value_cad),0) AS value
       ${base} AND s.counts_as_approved GROUP BY d.category ORDER BY d.category`,
      [eventId],
    ),
    pool.query(
      `SELECT d.subcategory, count(*)::int AS count, coalesce(sum(d.quantity),0)::int AS units, coalesce(sum(d.estimated_value_cad),0) AS value
       ${base} AND s.counts_as_approved AND d.category = 'food' GROUP BY d.subcategory ORDER BY d.subcategory`,
      [eventId],
    ),
    pool.query(
      `SELECT dn.id AS donor_id, dn.name AS donor_name, count(*)::int AS count, coalesce(sum(d.estimated_value_cad),0) AS value,
              count(*) FILTER (WHERE d.item_received)::int AS received, count(*) FILTER (WHERE d.thank_you_sent)::int AS thanked
       FROM donations d JOIN donation_statuses s ON s.code = d.status JOIN donors dn ON dn.id = d.donor_id
       WHERE d.event_id = $1 AND NOT d.is_archived AND s.counts_as_approved
       GROUP BY dn.id ORDER BY value DESC, dn.name`,
      [eventId],
    ),
  ]);
  return {
    event,
    generatedAt: new Date().toISOString(),
    submissions: subs.rows[0],
    summary: summary.rows[0],
    byCategory: Object.keys(CATEGORY_LABELS).map((c) => {
      const r = byCategory.rows.find((x) => x.category === c);
      return { category: c, label: CATEGORY_LABELS[c], count: r?.count ?? 0, units: r?.units ?? 0, value: r?.value ?? 0 };
    }),
    byFoodSubcategory: Object.keys(SUBCATEGORY_LABELS).map((c) => {
      const r = bySub.rows.find((x) => x.subcategory === c);
      return { subcategory: c, label: SUBCATEGORY_LABELS[c], count: r?.count ?? 0, units: r?.units ?? 0, value: r?.value ?? 0 };
    }),
    byDonor: byDonor.rows,
  };
}

reportsRouter.get('/events/:id', async (req, res) => {
  res.json(await eventReport(parse(idParam, req.params.id)));
});

reportsRouter.get('/events/:id/export.csv', requirePermission('exports.run'), async (req, res) => {
  const id = parse(idParam, req.params.id);
  const { section } = parse(z.object({ section: z.enum(['summary', 'categories', 'donors']).default('summary') }), req.query);
  const r = await eventReport(id);
  let csv: string;
  if (section === 'summary') {
    const rows = [
      ['Donations submitted (submissions + added directly)', r.submissions.submitted + r.summary.added_directly],
      ['Submissions awaiting review', r.submissions.awaiting_review],
      ['Submissions declined', r.submissions.declined],
      ['Donations approved', r.summary.approved],
      ['Donations published', r.summary.published],
      ['Total estimated value of approved donations (CAD)', r.summary.approved_value],
      ['Donations awaiting pickup', r.summary.awaiting_pickup],
      ['Donations received', r.summary.received],
      ['Thank-you messages outstanding', r.summary.thank_you_outstanding],
      ['Thank-you messages sent', r.summary.thank_you_sent],
      ['Overdue follow-ups', r.summary.overdue_follow_ups],
      ...r.byCategory.map((c) => [`Category: ${c.label} (count / value CAD)`, `${c.count} / ${c.value}`]),
      ...r.byFoodSubcategory.map((c) => [`Food - ${c.label} (count / value CAD)`, `${c.count} / ${c.value}`]),
    ].map(([metric, value]) => ({ metric, value }));
    csv = toCsv([{ key: 'metric', label: `${r.event.name} - Metric` }, { key: 'value', label: 'Value' }], rows);
  } else if (section === 'categories') {
    csv = toCsv(
      [
        { key: 'label', label: 'Category' },
        { key: 'count', label: 'Donations' },
        { key: 'units', label: 'Units' },
        { key: 'value', label: 'Estimated value (CAD)' },
      ],
      [...r.byCategory, ...r.byFoodSubcategory.map((s) => ({ ...s, label: `Food - ${s.label}` }))],
    );
  } else {
    csv = toCsv(
      [
        { key: 'donor_id', label: 'DonorID' },
        { key: 'donor_name', label: 'BusinessorDonor/Org' },
        { key: 'count', label: 'Approved donations' },
        { key: 'value', label: 'Estimated value (CAD)' },
        { key: 'received', label: 'Received' },
        { key: 'thanked', label: 'Thanked' },
      ],
      r.byDonor,
    );
  }
  await audit({ userId: req.user!.id, action: 'export.report', recordType: 'event', recordId: id, summary: `Exported ${section} report`, req });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${r.event.code}-${section}-${today()}.csv"`);
  res.send(csv);
});
