import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { today } from '../src/config.js';
import { closePools, pool } from '../src/db/pool.js';
import {
  type Client,
  PNG,
  createEvent,
  createUser,
  getApp,
  login,
  resetDatabase,
  sampleSubmission,
  submitPublic,
} from './helpers.js';

let superAdmin: Client;
let admin: Client;
let volunteer: Client;
let owner: Client;
let eventA: number;
let eventB: number;
let adminId: number;
let volunteerId: number;
let ownerId: number;

const shared: { submissionId?: number; reference?: string; donationId?: number; donorId?: number } = {};

beforeAll(async () => {
  await resetDatabase();
  await createUser('super_admin', 'Sam Super', 'super@charity.test');
  adminId = await createUser('admin', 'Alex Admin', 'admin@charity.test');
  ownerId = await createUser('owner', 'Olive Owner', 'owner@charity.test');
  volunteerId = await createUser('volunteer', 'Val Volunteer', 'volunteer@charity.test');
  superAdmin = await login('super@charity.test');
  admin = await login('admin@charity.test');
  owner = await login('owner@charity.test');
  volunteer = await login('volunteer@charity.test');
  eventA = await createEvent('empty-bowls-2026', 'Empty Bowls 2026');
  eventB = await createEvent('spring-gala-2027', 'Spring Gala 2027');
});

afterAll(async () => {
  await closePools();
});

describe('Workflow A: new donor submission', () => {
  it('rejects Food without a subcategory and validates fields', async () => {
    const res = await submitPublic(sampleSubmission(eventA, { subcategory: '', contact_email: 'not-an-email', quantity: 0 }));
    expect(res.status).toBe(400);
    expect(res.body.details.fields.subcategory).toMatch(/Soup, Bread or Dessert/);
    expect(res.body.details.fields.contact_email).toBeTruthy();
    expect(res.body.details.fields.quantity).toBeTruthy();
  });

  it('requires a valid form token (anti-spam)', async () => {
    const res = await request(getApp())
      .post('/api/public/submissions')
      .field('data', JSON.stringify(sampleSubmission(eventA)));
    expect(res.status).toBe(400);
  });

  it('saves the submission, returns a unique reference, and notifies admins', async () => {
    const res = await submitPublic({ ...sampleSubmission(eventA), idempotency_key: '7f0c1e0a-1111-4a5b-9c9d-000000000001' }, PNG);
    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^EB-\d{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(res.body.message).toMatch(/will be reviewed/);
    expect(res.body.message).not.toMatch(/approved/i);
    shared.reference = res.body.reference;

    const row = (await pool.query('SELECT * FROM donation_submissions WHERE reference = $1', [res.body.reference])).rows[0];
    expect(row.status).toBe('pending_review');
    expect(row.submission_data.subcategory).toBe('bread');
    expect(row.submission_data.estimated_value_cad).toBe(160);
    shared.submissionId = row.id;

    const media = await pool.query('SELECT * FROM donation_media WHERE submission_id = $1', [row.id]);
    expect(media.rows).toHaveLength(1);
    expect(media.rows[0].is_public).toBe(false);

    // Admins with review permission are notified; volunteers are not.
    const n = await admin.get('/api/notifications');
    expect(n.body.rows.some((x: { message: string }) => x.message.includes(res.body.reference))).toBe(true);
    const nv = await volunteer.get('/api/notifications');
    expect(nv.body.rows).toHaveLength(0);
  });

  it('prevents duplicate submissions from a double click (idempotency)', async () => {
    const res = await submitPublic({ ...sampleSubmission(eventA), idempotency_key: '7f0c1e0a-1111-4a5b-9c9d-000000000001' });
    expect(res.status).toBe(201);
    expect(res.body.reference).toBe(shared.reference);
    const count = await pool.query('SELECT count(*)::int AS n FROM donation_submissions');
    expect(count.rows[0].n).toBe(1);
  });

  it('does not show the submission in the public gallery', async () => {
    const res = await request(getApp()).get('/api/public/gallery');
    expect(res.status).toBe(200);
    expect(res.body.donations).toHaveLength(0);
    expect(res.body.summary.count).toBe(0);
  });

  it('rejects non-image uploads', async () => {
    const res = await submitPublic(sampleSubmission(eventA), Buffer.from('<script>alert(1)</script>'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JPEG, PNG/);
  });
});

describe('Workflow B: administrative approval', () => {
  it('shows the submission in the Donation Approvals queue', async () => {
    const res = await admin.get('/api/submissions?status=open');
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: { reference: string }) => r.reference)).toContain(shared.reference);
  });

  it('detects a likely duplicate donor', async () => {
    // An existing donor with the same phone number in a different format
    const d = await admin.post('/api/donors', { name: 'Maple Leaf Bakery Inc.', contact_phone: '+1 (905) 555-0123', contact_email: 'orders@mapleleafbakery.ca' });
    expect(d.status).toBe(201);
    shared.donorId = d.body.id;
    const detail = await admin.get(`/api/submissions/${shared.submissionId}`);
    expect(detail.body.duplicates[0].id).toBe(shared.donorId);
    expect(detail.body.duplicates[0].reasons).toContain('Same phone number');

    // Creating a NEW donor despite the duplicate requires explicit confirmation
    const approveNew = await admin.post(`/api/submissions/${shared.submissionId}/approve`, {
      donor: { mode: 'new' },
      event_id: eventA,
      category: 'food',
      subcategory: 'bread',
      description: 'Sourdough',
      quantity: 20,
      estimated_value_cad: 160,
    });
    expect(approveNew.status).toBe(409);
    expect(approveNew.body.details.duplicates.length).toBeGreaterThan(0);
  });

  it('lets the admin add internal notes and correct submission details', async () => {
    const note = await admin.post(`/api/submissions/${shared.submissionId}/notes`, { text: 'Called Jane, confirmed 20 loaves' });
    expect(note.status).toBe(201);
    const detail = await admin.get(`/api/submissions/${shared.submissionId}`);
    const corrected = { ...detail.body.submission.submission_data, description: 'Twenty loaves of sourdough bread (corrected)' };
    const save = await admin.put(`/api/submissions/${shared.submissionId}/reviewed-data`, corrected);
    expect(save.status).toBe(200);
    expect(save.body.submission.reviewed_data.description).toMatch(/corrected/);
    // The original snapshot is preserved
    expect(save.body.submission.submission_data.description).toBe('Twenty loaves of fresh sourdough bread for the soup lunch');
  });

  it('approves the submission, links the existing donor, and keeps it unpublished', async () => {
    const res = await admin.post(`/api/submissions/${shared.submissionId}/approve`, {
      donor: { mode: 'existing', donor_id: shared.donorId, update_contact: false },
      event_id: eventA,
      category: 'food',
      subcategory: 'bread',
      description: 'Twenty loaves of sourdough bread (corrected)',
      quantity: 20,
      estimated_value_cad: 160,
      assigned_to: volunteerId,
      recognition: 'approve',
      comment: 'Looks great',
    });
    expect(res.status).toBe(200);
    shared.donationId = res.body.donationId;
    expect(res.body.donorId).toBe(shared.donorId);

    const d = await admin.get(`/api/donations/${shared.donationId}`);
    expect(d.status).toBe(200);
    const donation = d.body.donation;
    expect(donation.event_id).toBe(eventA);
    expect(donation.donor_id).toBe(shared.donorId);
    expect(donation.status).toBe('approved');
    expect(donation.approved_by).toBe(adminId);
    expect(donation.approved_at).toBeTruthy();
    expect(donation.public_consent).toBe(true);
    // Recognition approved != published
    expect(donation.publication_status).toBe('pending_publication_approval');
    expect(donation.item_received).toBe(false);
    expect(donation.thank_you_sent).toBe(false);
    expect(donation.submission_reference).toBe(shared.reference);
    // Review notes carried over; history preserved
    expect(d.body.notes.some((n: { note_text: string }) => n.note_text.includes('Called Jane'))).toBe(true);
    expect(d.body.media).toHaveLength(1);
    const sub = await admin.get(`/api/submissions/${shared.submissionId}`);
    expect(sub.body.submission.status).toBe('approved');
    expect(sub.body.events.map((e: { action: string }) => e.action)).toEqual(['submitted', 'note', 'edited', 'approved']);

    const gallery = await request(getApp()).get('/api/public/gallery');
    expect(gallery.body.donations).toHaveLength(0);
  });

  it('prevents approving the same submission twice', async () => {
    const res = await admin.post(`/api/submissions/${shared.submissionId}/approve`, {
      donor: { mode: 'existing', donor_id: shared.donorId },
      event_id: eventA,
      category: 'food',
      subcategory: 'bread',
      description: 'dup',
      quantity: 1,
      estimated_value_cad: 1,
    });
    expect(res.status).toBe(409);
    const count = await pool.query('SELECT count(*)::int AS n FROM donations WHERE submission_id = $1', [shared.submissionId]);
    expect(count.rows[0].n).toBe(1);
  });

  it('declines a submission but keeps its history', async () => {
    const s = await submitPublic(sampleSubmission(eventA, { donor_name: 'Spam Co', category: 'other', subcategory: null }));
    const id = (await pool.query('SELECT id FROM donation_submissions WHERE reference = $1', [s.body.reference])).rows[0].id;
    const res = await admin.post(`/api/submissions/${id}/decline`, { comment: 'Not suitable' });
    expect(res.status).toBe(200);
    expect(res.body.submission.status).toBe('declined');
    const still = await pool.query('SELECT * FROM donation_submissions WHERE id = $1', [id]);
    expect(still.rows).toHaveLength(1);
  });

  it('requests more information and accepts the donor response via a secure link', async () => {
    const s = await submitPublic(sampleSubmission(eventA, { donor_name: 'Pottery Studio', category: 'bowls', subcategory: null }));
    const id = (await pool.query('SELECT id FROM donation_submissions WHERE reference = $1', [s.body.reference])).rows[0].id;
    const r = await admin.post(`/api/submissions/${id}/request-info`, { message: 'How many bowls exactly?', send_email: true });
    expect(r.status).toBe(200);
    expect(r.body.emailStatus).toBe('not_configured');
    const token = r.body.link.split('/').pop();
    const info = await request(getApp()).get(`/api/public/info-request/${token}`);
    expect(info.status).toBe(200);
    expect(info.body.message).toBe('How many bowls exactly?');
    // The page reveals nothing else about the submission
    expect(Object.keys(info.body).sort()).toEqual(['event_name', 'message', 'reference']);
    const reply = await request(getApp()).post(`/api/public/info-request/${token}`).field('response', 'Exactly 40 bowls');
    expect(reply.status).toBe(201);
    const again = await request(getApp()).get(`/api/public/info-request/${token}`);
    expect(again.status).toBe(404);
    const detail = await admin.get(`/api/submissions/${id}`);
    expect(detail.body.submission.status).toBe('pending_review');
    expect(detail.body.events.some((e: { action: string; comment: string }) => e.action === 'donor_response' && e.comment === 'Exactly 40 bowls')).toBe(true);
  });
});

describe('Workflow C: publication', () => {
  it('blocks publication by an admin without the publication permission', async () => {
    const res = await admin.post(`/api/donations/${shared.donationId}/publish`, { confirm: true });
    expect(res.status).toBe(403);
  });

  it('requires a reviewed public description before publishing', async () => {
    const res = await superAdmin.post(`/api/donations/${shared.donationId}/publish`, { confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.details.problems.join(' ')).toMatch(/public description/);
  });

  it('publishes with explicit confirmation and exposes only approved public fields', async () => {
    const content = await superAdmin.put(`/api/donations/${shared.donationId}/public-content`, {
      public_title: 'Fresh Sourdough Loaves',
      public_description: 'Twenty loaves of artisan sourdough for our soup lunch.',
      show_donor_name: true,
      show_website: true,
      show_value: true,
      show_quantity: true,
    });
    expect(content.status).toBe(200);
    const media = content.body.media[0];
    await superAdmin.patch(`/api/donations/${shared.donationId}/media/${media.id}`, { is_public: true, alt_text: 'Loaves of bread' });

    const noConfirm = await superAdmin.post(`/api/donations/${shared.donationId}/publish`, {});
    expect(noConfirm.status).toBe(400);
    const res = await superAdmin.post(`/api/donations/${shared.donationId}/publish`, { confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.donation.publication_status).toBe('published');

    // Add a private note and follow-up so we can check they never leak
    await admin.post(`/api/donations/${shared.donationId}/notes`, { text: 'PRIVATE-NOTE-XYZ' });
    await admin.patch(`/api/donations/${shared.donationId}`, { next_follow_up_date: '2030-01-15' });

    const gallery = await request(getApp()).get('/api/public/gallery?category=food&subcategory=bread');
    expect(gallery.status).toBe(200);
    expect(gallery.body.donations).toHaveLength(1);
    const card = gallery.body.donations[0];
    expect(card.title).toBe('Fresh Sourdough Loaves');
    expect(card.category).toBe('food');
    expect(card.subcategory).toBe('bread');
    expect(card.donor_name).toBe('Maple Leaf Bakery Inc.');
    expect(card.donor_website).toBeNull(); // donor record has no website
    expect(card.estimated_value_cad).toBe(160);
    expect(card.images).toHaveLength(1);
    expect(Object.keys(card).sort()).toEqual(
      ['category', 'description', 'donor_name', 'donor_website', 'estimated_value_cad', 'event_code', 'event_name', 'id', 'images', 'published_at', 'quantity', 'subcategory', 'title'].sort(),
    );
    const raw = JSON.stringify(gallery.body);
    for (const secret of ['jane@', '905', '555-0123', 'Secret Lane', 'PRIVATE-NOTE', '2030-01-15', 'Val Volunteer', 'ring bell', 'Looks great', 'Called Jane']) {
      expect(raw).not.toContain(secret);
    }
    expect(gallery.body.summary.count).toBe(1);

    const img = await request(getApp()).get(`/api/public/media/${card.images[0].id}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');

    // Other categories are empty
    const bowls = await request(getApp()).get('/api/public/gallery?category=bowls');
    expect(bowls.body.donations).toHaveLength(0);
  });

  it('unpublishing removes it from the gallery but keeps the internal record', async () => {
    const res = await superAdmin.post(`/api/donations/${shared.donationId}/unpublish`, { reason: 'Donor asked' });
    expect(res.status).toBe(200);
    expect(res.body.donation.publication_status).toBe('withdrawn');
    const gallery = await request(getApp()).get('/api/public/gallery');
    expect(gallery.body.donations).toHaveLength(0);
    const media = (await pool.query('SELECT id FROM donation_media WHERE donation_id = $1', [shared.donationId])).rows[0];
    const img = await request(getApp()).get(`/api/public/media/${media.id}`);
    expect(img.status).toBe(404);
    const internal = await admin.get(`/api/donations/${shared.donationId}`);
    expect(internal.status).toBe(200);
    // Republish for later tests
    await superAdmin.post(`/api/donations/${shared.donationId}/publish`, { confirm: true });
  });

  it('the database itself refuses to publish without consent', async () => {
    await expect(
      pool.query(`UPDATE donations SET public_consent = false WHERE id = $1`, [shared.donationId]),
    ).rejects.toThrow(/donations_published_requires_consent/);
  });
});

describe('Workflow D: follow-up task', () => {
  it('creates exactly one task for the NextFollowUpDate and shows it on the assignee dashboard', async () => {
    // Set by Workflow C (2030-01-15), donation assigned to the volunteer
    const t = await volunteer.get('/api/tasks');
    expect(t.status).toBe(200);
    const mine = t.body.rows.filter((r: { donation_id: number }) => r.donation_id === shared.donationId);
    expect(mine).toHaveLength(1);
    expect(mine[0].due_date).toBe('2030-01-15');
    expect(mine[0].event_id).toBe(eventA);
    expect(mine[0].is_next_follow_up).toBe(true);
  });

  it('saving the donation again does not create duplicates; changing the date updates the open task', async () => {
    await admin.patch(`/api/donations/${shared.donationId}`, { next_follow_up_date: '2030-01-15', description: 'Twenty loaves of sourdough bread' });
    await admin.patch(`/api/donations/${shared.donationId}`, { next_follow_up_date: '2020-01-01' }); // in the past => overdue
    const tasks = await pool.query('SELECT * FROM follow_up_tasks WHERE donation_id = $1 AND is_next_follow_up', [shared.donationId]);
    expect(tasks.rows).toHaveLength(1);
    expect(tasks.rows[0].due_date).toBe('2020-01-01');
    const list = await volunteer.get('/api/tasks?due=overdue');
    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0].overdue).toBe(true);
    const dash = await volunteer.get(`/api/dashboard?event_id=${eventA}`);
    expect(dash.body.myTasks.overdue).toBe(1);
  });

  it('completing the task keeps history and clears the next follow-up date', async () => {
    const task = (await pool.query('SELECT id FROM follow_up_tasks WHERE donation_id = $1 AND is_next_follow_up', [shared.donationId])).rows[0];
    const res = await volunteer.post(`/api/tasks/${task.id}/actions`, { action: 'complete', outcome: 'Spoke with Jane' });
    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('completed');
    expect(res.body.task.completed_at).toBeTruthy();
    expect(res.body.events.map((e: { action: string }) => e.action)).toContain('completed');
    const d = await admin.get(`/api/donations/${shared.donationId}`);
    expect(d.body.donation.next_follow_up_date).toBeNull();
    expect(d.body.tasks.find((t: { id: number }) => t.id === task.id).status).toBe('completed');

    // Scheduling a new follow-up creates a new open task, history retained
    await admin.patch(`/api/donations/${shared.donationId}`, { next_follow_up_date: today() });
    const all = await pool.query('SELECT status FROM follow_up_tasks WHERE donation_id = $1 AND is_next_follow_up ORDER BY id', [shared.donationId]);
    expect(all.rows.map((r) => r.status)).toEqual(['completed', 'open']);
    const dueToday = await volunteer.get('/api/tasks?due=today');
    expect(dueToday.body.rows).toHaveLength(1);
  });

  it('rescheduling the task updates the donation; volunteers cannot reassign', async () => {
    const task = (await pool.query(`SELECT id FROM follow_up_tasks WHERE donation_id = $1 AND status = 'open' AND is_next_follow_up`, [shared.donationId])).rows[0];
    const r = await volunteer.post(`/api/tasks/${task.id}/actions`, { action: 'reschedule', due_date: '2031-02-02' });
    expect(r.status).toBe(200);
    const d = (await pool.query('SELECT next_follow_up_date FROM donations WHERE id = $1', [shared.donationId])).rows[0];
    expect(d.next_follow_up_date).toBe('2031-02-02');
    const reassign = await volunteer.post(`/api/tasks/${task.id}/actions`, { action: 'reassign', assigned_to: ownerId });
    expect(reassign.status).toBe(403);
    const ok = await admin.post(`/api/tasks/${task.id}/actions`, { action: 'reassign', assigned_to: ownerId });
    expect(ok.status).toBe(200);
  });
});

describe('Workflow E: item received and thank-you', () => {
  it('schedules pickup, records receipt with who/when', async () => {
    const p = await admin.post(`/api/donations/${shared.donationId}/pickup`, { pickup_scheduled_for: '2026-11-10T14:00', assign_task_to: volunteerId });
    expect(p.status).toBe(200);
    expect(p.body.donation.status).toBe('pickup_scheduled');
    expect(p.body.tasks.some((t: { task_type: string; status: string }) => t.task_type === 'pickup' && t.status === 'open')).toBe(true);

    // Volunteer does not have donations.receive by default
    const denied = await volunteer.post(`/api/donations/${shared.donationId}/receive`, { received: true });
    expect(denied.status).toBe(403);

    const r = await admin.post(`/api/donations/${shared.donationId}/receive`, { received: true });
    expect(r.status).toBe(200);
    expect(r.body.donation.item_received).toBe(true);
    expect(r.body.donation.received_by).toBe(adminId);
    expect(r.body.donation.received_by_name).toBe('Alex Admin');
    expect(r.body.donation.received_at).toBeTruthy();
    expect(r.body.donation.status).toBe('item_received');
    expect(r.body.tasks.find((t: { task_type: string }) => t.task_type === 'pickup').status).toBe('completed');
  });

  it('appears in the thank-you tracking list; a draft does not count as sent', async () => {
    const list = await admin.get('/api/donations?thank_you=ready');
    expect(list.body.rows.map((r: { id: number }) => r.id)).toContain(shared.donationId);

    const tpl = await admin.get(`/api/donations/${shared.donationId}/thank-you/template`);
    expect(tpl.status).toBe(200);
    expect(tpl.body.body).toContain('Dear');
    expect(tpl.body.emailConfigured).toBe(false);
    const draft = await admin.post(`/api/donations/${shared.donationId}/thank-you/drafts`, {
      method: 'email',
      recipient: 'orders@mapleleafbakery.ca',
      subject: tpl.body.subject,
      body: tpl.body.body,
    });
    expect(draft.status).toBe(201);
    let d = await admin.get(`/api/donations/${shared.donationId}`);
    expect(d.body.donation.thank_you_sent).toBe(false);
    expect(d.body.donation.thank_you_stage).toBe('draft_prepared');

    // Email not configured: sending via the app is refused (and nothing is marked sent)
    const send = await admin.post(`/api/donations/${shared.donationId}/thank-you/drafts/${draft.body.id}/send-email`, { confirm: true });
    expect(send.status).toBe(400);
    d = await admin.get(`/api/donations/${shared.donationId}`);
    expect(d.body.donation.thank_you_sent).toBe(false);

    // The user confirms they sent it themselves
    const noConfirm = await admin.post(`/api/donations/${shared.donationId}/thank-you/confirm-sent`, { method: 'email', message_id: draft.body.id });
    expect(noConfirm.status).toBe(400);
    const ok = await admin.post(`/api/donations/${shared.donationId}/thank-you/confirm-sent`, { method: 'email', message_id: draft.body.id, confirm: true });
    expect(ok.status).toBe(200);
    expect(ok.body.donation.thank_you_sent).toBe(true);
    expect(ok.body.donation.thank_you_sent_by).toBe(adminId);
    expect(ok.body.donation.thank_you_sent_at).toBeTruthy();
    expect(ok.body.donation.thank_you_method).toBe('email');
    expect(ok.body.donation.status).toBe('complete');
    expect(ok.body.thankYouMessages[0].status).toBe('sent');

    const twice = await admin.post(`/api/donations/${shared.donationId}/thank-you/confirm-sent`, { method: 'email', confirm: true });
    expect(twice.status).toBe(409);
  });
});

describe('Workflow F: permission enforcement', () => {
  let otherDonationId: number;

  beforeAll(async () => {
    // A donation that is NOT assigned or shared with the volunteer
    const res = await admin.post('/api/donations', {
      event_id: eventA,
      new_donor: { name: 'Secret Supporter Ltd', contact_email: 'ceo@secret.example', contact_phone: '416-555-0199' },
      category: 'auction',
      description: 'Weekend cottage getaway',
      quantity: 1,
      estimated_value_cad: 1200,
      pickup_address: '1 Private Rd',
    });
    expect(res.status).toBe(201);
    otherDonationId = res.body.id;
    await admin.post(`/api/donations/${otherDonationId}/notes`, { text: 'Confidential negotiation note' });
  });

  it('volunteers only see their assigned records in lists', async () => {
    const list = await volunteer.get('/api/donations');
    expect(list.status).toBe(200);
    const ids = list.body.rows.map((r: { id: number }) => r.id);
    expect(ids).toContain(shared.donationId);
    expect(ids).not.toContain(otherDonationId);
    // Contact info hidden even for their own assigned record (no contacts permission by default)
    const mine = list.body.rows.find((r: { id: number }) => r.id === shared.donationId);
    expect(mine.contact_email).toBeNull();
    expect(mine.contact_phone).toBeNull();
    expect(mine.pickup_address).toBeNull();
    expect(mine.contact_hidden).toBe(true);
  });

  it('direct URL / API access to another record is denied', async () => {
    expect((await volunteer.get(`/api/donations/${otherDonationId}`)).status).toBe(403);
    expect((await volunteer.patch(`/api/donations/${otherDonationId}`, { description: 'hacked' })).status).toBe(403);
    expect((await volunteer.post(`/api/donations/${otherDonationId}/notes`, { text: 'x' })).status).toBe(403);
    const donorId = (await pool.query('SELECT donor_id FROM donations WHERE id = $1', [otherDonationId])).rows[0].donor_id;
    expect((await volunteer.get(`/api/donors/${donorId}`)).status).toBe(403);
    const donors = await volunteer.get('/api/donors?q=secret');
    expect(donors.body.rows).toHaveLength(0);
  });

  it('restricted APIs are denied to volunteers', async () => {
    expect((await volunteer.get('/api/submissions')).status).toBe(403);
    expect((await volunteer.post(`/api/submissions/1/approve`, {})).status).toBe(403);
    expect((await volunteer.get('/api/users')).status).toBe(403);
    expect((await volunteer.get('/api/audit')).status).toBe(403);
    expect((await volunteer.get('/api/settings')).status).toBe(403);
    expect((await volunteer.get('/api/donations/export.csv')).status).toBe(403);
    expect((await volunteer.get(`/api/reports/events/${eventA}`)).status).toBe(403);
    expect((await volunteer.post('/api/events', { code: 'x-event', name: 'X' })).status).toBe(403);
    expect((await volunteer.post('/api/donations', { event_id: eventA })).status).toBe(403);
    expect((await volunteer.post(`/api/donations/${shared.donationId}/publish`, { confirm: true })).status).toBe(403);
    expect((await volunteer.post(`/api/donations/${shared.donationId}/unpublish`, {})).status).toBe(403);
    expect((await volunteer.put(`/api/users/${volunteerId}/permissions`, { overrides: [{ permission: 'donations.view_all', granted: true }] })).status).toBe(403);
  });

  it('volunteers cannot change restricted fields even on their own records', async () => {
    const r = await volunteer.patch(`/api/donations/${shared.donationId}`, { assigned_to: volunteerId, event_id: eventB });
    expect(r.status).toBe(403);
    const s = await volunteer.patch(`/api/donations/${shared.donationId}`, { status: 'declined' });
    expect(s.status).toBe(403);
    const ok = await volunteer.patch(`/api/donations/${shared.donationId}`, { quantity: 21 });
    expect(ok.status).toBe(200);
  });

  it('volunteers do not see internal notes on records they cannot access, and see notes on their own', async () => {
    const own = await volunteer.get(`/api/donations/${shared.donationId}`);
    expect(own.status).toBe(200);
    expect(Array.isArray(own.body.notes)).toBe(true);
    // Revoke notes permission => notes not returned at all
    await superAdmin.put(`/api/users/${volunteerId}/permissions`, { overrides: [{ permission: 'notes.assigned', granted: false }] });
    const without = await volunteer.get(`/api/donations/${shared.donationId}`);
    expect(without.body.notes).toBeNull();
    expect((await volunteer.post(`/api/donations/${shared.donationId}/notes`, { text: 'x' })).status).toBe(403);
    await superAdmin.put(`/api/users/${volunteerId}/permissions`, { overrides: [] });
  });

  it('requires a CSRF token for state-changing requests', async () => {
    const res = await volunteer.agent.patch(`/api/donations/${shared.donationId}`).send({ quantity: 5 });
    expect(res.status).toBe(403);
  });

  it('unauthenticated users get 401', async () => {
    expect((await request(getApp()).get('/api/donations')).status).toBe(401);
    expect((await request(getApp()).get(`/api/donations/${shared.donationId}`)).status).toBe(401);
  });

  it('owners cannot grant themselves permissions or approve submissions', async () => {
    expect((await owner.put(`/api/users/${ownerId}/permissions`, { overrides: [{ permission: 'submissions.review', granted: true }] })).status).toBe(403);
    const sub = await owner.post('/api/submissions', {
      ...sampleSubmission(eventA, { donor_name: 'Owner Friend Cafe', category: 'door_prize', subcategory: null }),
    });
    expect(sub.status).toBe(201);
    expect((await owner.post(`/api/submissions/${sub.body.id}/approve`, {})).status).toBe(403);
    // They can see their own submission but not others'
    const list = await owner.get('/api/submissions');
    expect(list.body.rows.every((r: { submitted_by_name: string }) => r.submitted_by_name === 'Olive Owner')).toBe(true);
    expect((await owner.get(`/api/submissions/${shared.submissionId}`)).status).toBe(403);
  });

  it('admins cannot modify the Super Admin; the last Super Admin cannot be removed', async () => {
    const superId = (await pool.query(`SELECT id FROM users WHERE role = 'super_admin'`)).rows[0].id;
    expect((await admin.patch(`/api/users/${superId}`, { account_status: 'deactivated' })).status).toBe(403);
    expect((await admin.patch(`/api/users/${adminId}`, { role: 'super_admin' })).status).toBe(403);
    expect((await admin.post(`/api/users/${superId}/reset-password`)).status).toBe(403);
    expect((await admin.post('/api/users', { name: 'New Admin', email: 'na@x.test', role: 'admin' })).status).toBe(403);
    const vol = await admin.post('/api/users', { name: 'New Vol', email: 'nv@x.test', role: 'volunteer' });
    expect(vol.status).toBe(201);
    expect(vol.body.temporaryPassword.length).toBeGreaterThanOrEqual(12);
    expect((await superAdmin.patch(`/api/users/${superId}`, { role: 'admin' })).status).toBe(403); // cannot change own role
  });

  it('the Super Admin retains full control and can grant publish rights', async () => {
    const r = await superAdmin.put(`/api/users/${adminId}/permissions`, { overrides: [{ permission: 'publication.manage', granted: true }] });
    expect(r.status).toBe(200);
    const pub = await admin.post(`/api/donations/${shared.donationId}/unpublish`, {});
    expect(pub.status).toBe(200);
    expect((await admin.post(`/api/donations/${shared.donationId}/publish`, { confirm: true })).status).toBe(200);
    expect((await superAdmin.get('/api/audit')).status).toBe(200);
    expect((await superAdmin.get('/api/settings')).status).toBe(200);
  });

  it('deactivated users are signed out immediately', async () => {
    const tmpId = await createUser('volunteer', 'Temp', 'temp@charity.test');
    const tmp = await login('temp@charity.test');
    expect((await tmp.get('/api/dashboard')).status).toBe(200);
    await superAdmin.patch(`/api/users/${tmpId}`, { account_status: 'deactivated' });
    expect((await tmp.get('/api/dashboard')).status).toBe(401);
  });
});

describe('Workflow G: multiple events', () => {
  it('keeps event totals and reports separate, including after an event closes', async () => {
    const s = await submitPublic(sampleSubmission(eventB, { donor_name: 'Gala Florist', contact_email: 'hi@galaflorist.ca', contact_phone: '', category: 'auction', subcategory: null, estimated_value_cad: '500' }));
    expect(s.status).toBe(201);
    const subId = (await pool.query('SELECT id FROM donation_submissions WHERE reference = $1', [s.body.reference])).rows[0].id;
    const ap = await admin.post(`/api/submissions/${subId}/approve`, {
      donor: { mode: 'new' },
      event_id: eventB,
      category: 'auction',
      description: 'Floral arrangement',
      quantity: 1,
      estimated_value_cad: 500,
    });
    expect(ap.status).toBe(200);

    const repA = await admin.get(`/api/reports/events/${eventA}`);
    const repB = await admin.get(`/api/reports/events/${eventB}`);
    expect(repB.body.summary.approved).toBe(1);
    expect(repB.body.summary.approved_value).toBe(500);
    expect(repA.body.summary.approved_value).toBe(160 + 1200);
    expect(repA.body.byCategory.find((c: { category: string }) => c.category === 'auction').value).toBe(1200);
    expect(repB.body.byDonor.map((d: { donor_name: string }) => d.donor_name)).toEqual(['Gala Florist']);
    expect(repA.body.byFoodSubcategory.find((c: { subcategory: string }) => c.subcategory === 'bread').count).toBe(1);

    const dashB = await admin.get(`/api/dashboard?event_id=${eventB}`);
    expect(dashB.body.cards.approved).toBe(1);
    expect(dashB.body.cards.total_value).toBe(500);

    const listB = await admin.get(`/api/donations?event_id=${eventB}`);
    expect(listB.body.rows).toHaveLength(1);

    // Close event A: records remain; public form no longer accepts submissions for it
    const close = await admin.patch(`/api/events/${eventA}`, { status: 'closed', accepting_submissions: true });
    expect(close.status).toBe(200);
    expect(close.body.accepting_submissions).toBe(false);
    const late = await submitPublic(sampleSubmission(eventA));
    expect(late.status).toBe(400);
    const stillThere = await admin.get(`/api/donations?event_id=${eventA}`);
    expect(stillThere.body.total).toBeGreaterThanOrEqual(2);
    const repAfter = await admin.get(`/api/reports/events/${eventA}`);
    expect(repAfter.body.summary.approved_value).toBe(1360);

    // Gallery filters by event
    const galleryA = await request(getApp()).get('/api/public/gallery?event=empty-bowls-2026');
    expect(galleryA.body.donations).toHaveLength(1);
    const galleryB = await request(getApp()).get('/api/public/gallery?event=spring-gala-2027');
    expect(galleryB.body.donations).toHaveLength(0);
  });

  it('moving a donation to another event must be explicitly confirmed', async () => {
    const res = await admin.patch(`/api/donations/${shared.donationId}`, { event_id: eventB });
    expect(res.status).toBe(400);
    expect(res.body.details.fields.event_id).toMatch(/Confirm/);
  });
});

describe('Exports and audit', () => {
  it('exports CSV with permission-aware columns and formula-injection protection', async () => {
    await admin.post('/api/donations', {
      event_id: eventB,
      new_donor: { name: '=HYPERLINK("http://evil")' },
      category: 'other',
      description: '@SUM(1+1)',
      quantity: 1,
      estimated_value_cad: 5,
    });
    const res = await admin.get(`/api/donations/export.csv?event_id=${eventB}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('ContactEmail');
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(res.text).toContain(`'@SUM(1+1)`);
    expect(res.text).not.toContain('PRIVATE-NOTE');

    // An owner granted export rights (no view_all) only exports what they can see.
    const exporterId = await createUser('volunteer', 'Exporter', 'exporter@charity.test', [{ permission: 'exports.run', granted: true }]);
    const exporter = await login('exporter@charity.test');
    const ex = await exporter.get('/api/donations/export.csv');
    expect(ex.status).toBe(200);
    expect(ex.text.trim().split('\r\n')).toHaveLength(1); // header only
    expect(ex.text).not.toContain('ContactEmail');
    void exporterId;
  });

  it('records an audit trail of important changes', async () => {
    const res = await superAdmin.get(`/api/audit?record_type=donation&record_id=${shared.donationId}`);
    const actions = res.body.rows.map((r: { action: string }) => r.action);
    for (const a of ['donation.create', 'donation.publish', 'donation.unpublish', 'donation.received', 'donation.thank_you_sent', 'donation.update']) {
      expect(actions).toContain(a);
    }
  });
});
