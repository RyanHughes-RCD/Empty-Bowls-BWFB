-- =====================================================================
-- Charity Auction Donor Management System - initial schema
-- =====================================================================
-- Conventions
--   * Integer identity primary keys for internal records.
--   * Random UUIDs for media (never guessable from a URL).
--   * All timestamps are timestamptz (UTC in storage).
--   * Money is numeric(12,2) in Canadian dollars.
--   * Publication state is kept separate from operational status.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Application settings (privacy notice, charity name, etc.)
-- ---------------------------------------------------------------------
CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  integer
);

-- ---------------------------------------------------------------------
-- Users, roles and per-user permission overrides
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  email                text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  password_hash        text,
  role                 text NOT NULL CHECK (role IN ('super_admin', 'admin', 'owner', 'volunteer')),
  account_status       text NOT NULL DEFAULT 'active'
                         CHECK (account_status IN ('active', 'suspended', 'deactivated')),
  must_change_password boolean NOT NULL DEFAULT false,
  failed_login_count   integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           integer REFERENCES users(id),
  last_login_at        timestamptz
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

ALTER TABLE app_settings
  ADD CONSTRAINT app_settings_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users(id);

-- granted = true adds a permission on top of the role defaults,
-- granted = false removes a role-default permission for this user.
CREATE TABLE user_permissions (
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  text NOT NULL CHECK (permission ~ '^[a-z_]+\.[a-z_]+$'),
  granted     boolean NOT NULL,
  granted_by  integer REFERENCES users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission)
);

-- Session store used by express-session / connect-pg-simple
CREATE TABLE user_sessions (
  sid     varchar NOT NULL PRIMARY KEY,
  sess    json NOT NULL,
  expire  timestamp(6) NOT NULL
);
CREATE INDEX user_sessions_expire_idx ON user_sessions (expire);

-- ---------------------------------------------------------------------
-- Events (auctions)
-- ---------------------------------------------------------------------
CREATE TABLE events (
  id                     integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                   text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
  name                   text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  event_date             date,
  description            text CHECK (length(description) <= 5000),
  location               text CHECK (length(location) <= 500),
  status                 text NOT NULL DEFAULT 'planning'
                           CHECK (status IN ('planning', 'active', 'closed', 'archived')),
  accepting_submissions  boolean NOT NULL DEFAULT false,
  gallery_enabled        boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by             integer REFERENCES users(id),
  -- A closed or archived event can never accept new public submissions.
  CONSTRAINT events_closed_not_accepting
    CHECK (NOT (status IN ('closed', 'archived') AND accepting_submissions))
);

-- ---------------------------------------------------------------------
-- Donors (one record per business / individual / organization)
-- ---------------------------------------------------------------------
CREATE TABLE donors (
  id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),  -- BusinessorDonor/Org
  donor_type           text NOT NULL DEFAULT 'business'
                         CHECK (donor_type IN ('business', 'individual', 'organization')),
  contact_name         text CHECK (length(contact_name) <= 200),
  contact_email        text CHECK (length(contact_email) <= 320),
  contact_phone        text CHECK (length(contact_phone) <= 40),
  website              text CHECK (length(website) <= 500),
  social_media         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(social_media) = 'array'),
  public_display_name  text CHECK (length(public_display_name) <= 200),
  owner_id             integer REFERENCES users(id),           -- record owner
  -- normalized values used for duplicate detection (maintained by the app)
  norm_name            text,
  norm_email           text,
  norm_phone           text,
  is_archived          boolean NOT NULL DEFAULT false,
  archived_at          timestamptz,
  merged_into_id       integer REFERENCES donors(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           integer REFERENCES users(id),
  CONSTRAINT donors_not_merged_into_self CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);
CREATE INDEX donors_norm_email_idx ON donors (norm_email) WHERE norm_email IS NOT NULL;
CREATE INDEX donors_norm_phone_idx ON donors (norm_phone) WHERE norm_phone IS NOT NULL;
CREATE INDEX donors_norm_name_idx  ON donors (norm_name);
CREATE INDEX donors_owner_idx      ON donors (owner_id);

-- Historical snapshots of donor records taken before every change.
CREATE TABLE donor_history (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  donor_id    integer NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
  snapshot    jsonb NOT NULL,
  reason      text,
  changed_by  integer REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX donor_history_donor_idx ON donor_history (donor_id);

-- ---------------------------------------------------------------------
-- Configurable operational statuses
-- ---------------------------------------------------------------------
CREATE TABLE donation_statuses (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z_]{2,40}$'),
  label        text NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  is_system    boolean NOT NULL DEFAULT false,   -- system statuses cannot be deleted
  -- Can a donation in this status be displayed publicly (if also published)?
  publishable  boolean NOT NULL DEFAULT false,
  -- Does this status count as "approved" for reporting?
  counts_as_approved boolean NOT NULL DEFAULT false
);

INSERT INTO donation_statuses (code, label, sort_order, is_system, publishable, counts_as_approved) VALUES
  ('new_submission',      'New Submission',             10,  true, false, false),
  ('pending_review',      'Pending Review',             20,  true, false, false),
  ('awaiting_donor_info', 'Awaiting Donor Information', 30,  true, false, false),
  ('approved',            'Approved',                   40,  true, true,  true),
  ('declined',            'Declined',                   50,  true, false, false),
  ('follow_up_required',  'Follow-Up Required',         60,  true, true,  true),
  ('confirmed',           'Confirmed',                  70,  true, true,  true),
  ('pickup_scheduled',    'Pickup Scheduled',           80,  true, true,  true),
  ('item_received',       'Item Received',              90,  true, true,  true),
  ('thank_you_pending',   'Thank-You Pending',          100, true, true,  true),
  ('complete',            'Complete',                   110, true, true,  true);

-- ---------------------------------------------------------------------
-- Donation submissions (public form + internal "submit for approval")
-- ---------------------------------------------------------------------
CREATE TABLE donation_submissions (
  id                       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference                text NOT NULL UNIQUE,
  event_id                 integer NOT NULL REFERENCES events(id),
  submitted_by             integer REFERENCES users(id),          -- NULL for public submitters
  source                   text NOT NULL CHECK (source IN ('public_form', 'internal')),
  submission_data          jsonb NOT NULL,                         -- immutable original snapshot
  reviewed_data            jsonb,                                  -- reviewer corrections
  status                   text NOT NULL DEFAULT 'pending_review'
                             CHECK (status IN ('pending_review', 'awaiting_donor_info', 'approved', 'declined', 'withdrawn')),
  public_consent           boolean NOT NULL DEFAULT false,
  privacy_acknowledged     boolean NOT NULL DEFAULT false,
  idempotency_key          uuid UNIQUE,
  submitter_fingerprint    text,                                   -- salted hash of IP, for abuse checks
  linked_donor_id          integer REFERENCES donors(id),
  submitted_at             timestamptz NOT NULL DEFAULT now(),
  reviewed_by              integer REFERENCES users(id),
  reviewed_at              timestamptz,
  review_comments          text,
  info_request_token_hash  text UNIQUE,
  info_request_message     text,
  info_request_expires_at  timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX donation_submissions_status_idx ON donation_submissions (status, submitted_at);
CREATE INDEX donation_submissions_event_idx  ON donation_submissions (event_id);

-- Review history: every action taken on a submission.
CREATE TABLE submission_events (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id  integer NOT NULL REFERENCES donation_submissions(id) ON DELETE CASCADE,
  action         text NOT NULL,
  actor_id       integer REFERENCES users(id),
  comment        text,
  data           jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX submission_events_submission_idx ON submission_events (submission_id);

-- ---------------------------------------------------------------------
-- Donations
-- ---------------------------------------------------------------------
CREATE TABLE donations (
  id                          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id                    integer NOT NULL REFERENCES events(id),
  donor_id                    integer NOT NULL REFERENCES donors(id),
  submission_id               integer UNIQUE REFERENCES donation_submissions(id),  -- prevents double approval
  category                    text NOT NULL CHECK (category IN ('bowls', 'food', 'auction', 'door_prize', 'other')),
  subcategory                 text CHECK (subcategory IN ('soup', 'bread', 'dessert')),
  description                 text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 5000),
  quantity                    integer NOT NULL DEFAULT 1 CHECK (quantity > 0 AND quantity <= 100000),
  estimated_value_cad         numeric(12, 2) CHECK (estimated_value_cad >= 0),
  value_is_estimate           boolean NOT NULL DEFAULT false,   -- value estimated by staff
  status                      text NOT NULL DEFAULT 'approved' REFERENCES donation_statuses(code) ON UPDATE CASCADE,
  next_follow_up_date         date,
  assigned_to                 integer REFERENCES users(id),

  -- Pickup / delivery (private)
  delivery_method             text NOT NULL DEFAULT 'undecided'
                                CHECK (delivery_method IN ('donor_delivers', 'pickup_required', 'undecided')),
  pickup_address              text CHECK (length(pickup_address) <= 1000),
  pickup_instructions         text CHECK (length(pickup_instructions) <= 3000),
  pickup_preferred_dates      text CHECK (length(pickup_preferred_dates) <= 1000),
  pickup_scheduled_for        timestamptz,

  -- ItemRec'd
  item_received               boolean NOT NULL DEFAULT false,
  received_quantity           integer CHECK (received_quantity >= 0),
  received_at                 timestamptz,
  received_by                 integer REFERENCES users(id),

  -- ThankYouStatus
  thank_you_required          boolean NOT NULL DEFAULT true,
  thank_you_sent              boolean NOT NULL DEFAULT false,
  thank_you_stage             text NOT NULL DEFAULT 'not_started'
                                CHECK (thank_you_stage IN ('not_started', 'draft_prepared', 'sent', 'not_required')),
  thank_you_sent_at           timestamptz,
  thank_you_sent_by           integer REFERENCES users(id),
  thank_you_method            text CHECK (thank_you_method IN ('email', 'letter', 'card', 'phone', 'in_person', 'other')),
  thank_you_notes             text,

  -- Publication (independent of operational status)
  publication_status          text NOT NULL DEFAULT 'unpublished'
                                CHECK (publication_status IN ('unpublished', 'pending_publication_approval', 'published', 'withdrawn')),
  public_consent              boolean NOT NULL DEFAULT false,
  public_consent_source       text,
  public_consent_recorded_at  timestamptz,
  public_consent_recorded_by  integer REFERENCES users(id),
  public_title                text CHECK (length(public_title) <= 200),
  public_description          text CHECK (length(public_description) <= 3000),
  show_donor_name             boolean NOT NULL DEFAULT false,
  show_website                boolean NOT NULL DEFAULT false,
  show_value                  boolean NOT NULL DEFAULT false,
  show_quantity               boolean NOT NULL DEFAULT true,
  published_at                timestamptz,
  published_by                integer REFERENCES users(id),

  is_archived                 boolean NOT NULL DEFAULT false,
  archived_at                 timestamptz,
  archived_by                 integer REFERENCES users(id),

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  integer REFERENCES users(id),
  approved_by                 integer REFERENCES users(id),
  approved_at                 timestamptz,

  -- SubCategory only applies to Food (and Food requires one)
  CONSTRAINT donations_subcategory_food_only
    CHECK ((category = 'food' AND subcategory IS NOT NULL) OR (category <> 'food' AND subcategory IS NULL)),
  -- A donation can never be published without recorded public consent and public text
  CONSTRAINT donations_published_requires_consent
    CHECK (publication_status <> 'published' OR (public_consent AND public_description IS NOT NULL AND NOT is_archived)),
  CONSTRAINT donations_thank_you_sent_consistent
    CHECK (thank_you_sent = (thank_you_stage = 'sent')),
  CONSTRAINT donations_received_consistent
    CHECK (NOT item_received OR received_at IS NOT NULL)
);
CREATE INDEX donations_event_idx        ON donations (event_id);
CREATE INDEX donations_donor_idx        ON donations (donor_id);
CREATE INDEX donations_status_idx       ON donations (status);
CREATE INDEX donations_assigned_idx     ON donations (assigned_to);
CREATE INDEX donations_publication_idx  ON donations (publication_status);
CREATE INDEX donations_follow_up_idx    ON donations (next_follow_up_date) WHERE next_follow_up_date IS NOT NULL;

-- Records explicitly shared with a user (beyond assignment)
CREATE TABLE donation_shares (
  donation_id  integer NOT NULL REFERENCES donations(id) ON DELETE CASCADE,
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by   integer REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (donation_id, user_id)
);

CREATE TABLE donation_status_history (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  donation_id  integer NOT NULL REFERENCES donations(id) ON DELETE CASCADE,
  from_status  text,
  to_status    text NOT NULL,
  changed_by   integer REFERENCES users(id),
  comment      text,
  changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX donation_status_history_donation_idx ON donation_status_history (donation_id);

-- Internal timestamped notes. NEVER exposed publicly.
CREATE TABLE donation_notes (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  donation_id  integer NOT NULL REFERENCES donations(id) ON DELETE CASCADE,
  author_id    integer REFERENCES users(id),
  note_text    text NOT NULL CHECK (length(btrim(note_text)) BETWEEN 1 AND 5000),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX donation_notes_donation_idx ON donation_notes (donation_id);

-- ---------------------------------------------------------------------
-- Follow-up tasks / To Do list
-- ---------------------------------------------------------------------
CREATE TABLE follow_up_tasks (
  id                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  donation_id        integer REFERENCES donations(id) ON DELETE CASCADE,
  event_id           integer REFERENCES events(id),
  assigned_to        integer REFERENCES users(id),
  description        text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  due_date           date,
  priority           text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  task_type          text NOT NULL DEFAULT 'general'
                       CHECK (task_type IN ('follow_up', 'pickup', 'receipt', 'thank_you', 'info_request', 'general')),
  -- true for the single task that mirrors donations.next_follow_up_date
  is_next_follow_up  boolean NOT NULL DEFAULT false,
  completed_at       timestamptz,
  completed_by       integer REFERENCES users(id),
  outcome            text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         integer REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_completed_has_time CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CONSTRAINT tasks_next_follow_up_needs_donation CHECK (NOT is_next_follow_up OR donation_id IS NOT NULL)
);
-- At most one OPEN "next follow-up" task per donation => no duplicates on repeated saves.
CREATE UNIQUE INDEX follow_up_tasks_one_open_next
  ON follow_up_tasks (donation_id) WHERE is_next_follow_up AND status IN ('open', 'in_progress');
CREATE INDEX follow_up_tasks_assigned_idx ON follow_up_tasks (assigned_to, status, due_date);
CREATE INDEX follow_up_tasks_donation_idx ON follow_up_tasks (donation_id);
CREATE INDEX follow_up_tasks_event_idx    ON follow_up_tasks (event_id);

-- History of each task (notes, reschedules, reassignments, completion)
CREATE TABLE task_events (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id     integer NOT NULL REFERENCES follow_up_tasks(id) ON DELETE CASCADE,
  action      text NOT NULL,
  detail      text,
  actor_id    integer REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task_idx ON task_events (task_id);

-- Keep a task's event in sync with its donation's event (prevents mismatches).
CREATE FUNCTION follow_up_tasks_sync_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.donation_id IS NOT NULL THEN
    SELECT event_id INTO NEW.event_id FROM donations WHERE id = NEW.donation_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER follow_up_tasks_sync_event_trg
  BEFORE INSERT OR UPDATE OF donation_id, event_id ON follow_up_tasks
  FOR EACH ROW EXECUTE FUNCTION follow_up_tasks_sync_event();

CREATE FUNCTION donations_propagate_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_id IS DISTINCT FROM OLD.event_id THEN
    UPDATE follow_up_tasks SET event_id = NEW.event_id WHERE donation_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER donations_propagate_event_trg
  AFTER UPDATE OF event_id ON donations
  FOR EACH ROW EXECUTE FUNCTION donations_propagate_event();

-- ---------------------------------------------------------------------
-- Media (images). Files live in private storage; served only through
-- authorization-checked endpoints. IDs are random UUIDs.
-- ---------------------------------------------------------------------
CREATE TABLE donation_media (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  donation_id    integer REFERENCES donations(id) ON DELETE CASCADE,
  submission_id  integer REFERENCES donation_submissions(id) ON DELETE CASCADE,
  storage_key    text NOT NULL UNIQUE,
  mime_type      text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  size_bytes     integer NOT NULL CHECK (size_bytes > 0),
  original_name  text,
  alt_text       text CHECK (length(alt_text) <= 300),
  is_public      boolean NOT NULL DEFAULT false,
  sort_order     integer NOT NULL DEFAULT 0,
  uploaded_by    integer REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT donation_media_has_parent CHECK (donation_id IS NOT NULL OR submission_id IS NOT NULL)
);
CREATE INDEX donation_media_donation_idx   ON donation_media (donation_id);
CREATE INDEX donation_media_submission_idx ON donation_media (submission_id);

-- ---------------------------------------------------------------------
-- Thank-you communications (drafts are never counted as "sent")
-- ---------------------------------------------------------------------
CREATE TABLE thank_you_messages (
  id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  donation_id         integer NOT NULL REFERENCES donations(id) ON DELETE CASCADE,
  method              text NOT NULL CHECK (method IN ('email', 'letter', 'card', 'phone', 'in_person', 'other')),
  recipient           text,
  subject             text CHECK (length(subject) <= 300),
  body                text CHECK (length(body) <= 20000),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'failed', 'discarded')),
  created_by          integer REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  sent_by             integer REFERENCES users(id),
  sent_at             timestamptz,
  delivery_reference  text,
  error               text
);
CREATE INDEX thank_you_messages_donation_idx ON thank_you_messages (donation_id);

-- ---------------------------------------------------------------------
-- In-app notifications and outgoing email log
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  message     text NOT NULL,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, read_at);

CREATE TABLE email_log (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient   text NOT NULL,
  subject     text NOT NULL,
  purpose     text NOT NULL,
  status      text NOT NULL CHECK (status IN ('sent', 'failed', 'not_configured')),
  error       text,
  message_id  text,
  created_by  integer REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      integer REFERENCES users(id),
  action       text NOT NULL,
  record_type  text NOT NULL,
  record_id    text,
  summary      text,
  details      jsonb,
  ip_hash      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_record_idx  ON audit_log (record_type, record_id);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_user_idx    ON audit_log (user_id);

-- =====================================================================
-- PUBLIC, READ-ONLY VIEWS
-- These are the ONLY relations the public website queries. They contain
-- explicitly approved public fields only. No contact details, notes,
-- follow-ups, pickup data, assignments or review comments exist here.
-- =====================================================================
CREATE VIEW public_events AS
SELECT e.id, e.code, e.name, e.event_date, e.description, e.location,
       e.accepting_submissions, e.gallery_enabled, e.status
FROM events e
WHERE e.status IN ('active', 'closed');

CREATE VIEW public_gallery_donations AS
SELECT d.id,
       d.event_id,
       e.code AS event_code,
       e.name AS event_name,
       d.category,
       d.subcategory,
       d.public_title AS title,
       d.public_description AS description,
       CASE WHEN d.show_quantity THEN d.quantity END AS quantity,
       CASE WHEN d.show_value THEN d.estimated_value_cad END AS estimated_value_cad,
       CASE WHEN d.show_donor_name THEN COALESCE(NULLIF(btrim(dn.public_display_name), ''), dn.name) END AS donor_name,
       CASE WHEN d.show_donor_name AND d.show_website THEN dn.website END AS donor_website,
       d.published_at
FROM donations d
JOIN donors dn ON dn.id = d.donor_id
JOIN events e ON e.id = d.event_id
JOIN donation_statuses s ON s.code = d.status
WHERE d.publication_status = 'published'
  AND d.public_consent
  AND d.public_description IS NOT NULL
  AND NOT d.is_archived
  AND s.publishable
  AND e.gallery_enabled
  AND e.status IN ('active', 'closed');

CREATE VIEW public_gallery_media AS
SELECT m.id, m.donation_id, m.alt_text, m.sort_order, m.mime_type, m.storage_key
FROM donation_media m
JOIN public_gallery_donations g ON g.id = m.donation_id
WHERE m.is_public;
