# Empty Bowls: Charity Auction Donor Management

A web application for running a charity auction's donations. It has four parts that share one PostgreSQL database:

| Part | Who uses it | URL |
|---|---|---|
| **Donation submission portal** | Donors (no account needed) | `/submit` |
| **Public donation gallery** ("Our Generous Donors") | Everyone | `/gallery` |
| **Administration dashboard**: approvals, tasks, pickups, thank-yous, reports | Staff and volunteers (sign in) | `/app` |
| **Internal donor database**: donors, donations, events, users, audit log | Staff and volunteers (sign in) | `/app/...` |

**Central principle:** one database with several permission levels, and two separate experiences (internal and public). A public submission never becomes visible on its own. Approving a donation internally does not publish it.

---

## 1. Architecture

```
Browser (React + TypeScript SPA)
   │  same-origin HTTPS, session cookie + CSRF header
   ▼
Node.js 22 / Express 5 API  ──── private image storage (disk volume, never served statically)
   │  ├─ /api/public/*   anonymous: reads ONLY public_* SQL views (restricted DB role)
   │  └─ /api/*          signed-in: role/permission checks on every request
   ▼
PostgreSQL 16 (SQL migrations, foreign keys, CHECK constraints, unique indexes)
```

* **Why not Supabase?** A single self-contained Node + PostgreSQL app runs on any low-cost host (Render, Railway, Fly.io, DigitalOcean, a VPS or Docker). It doesn't depend on a third-party auth provider, and it can be fully tested on one machine. All authorization runs on the server. The public pages use a separate database role that can read only three public views (see §7), which plays the part that Row Level Security would play in Supabase.
* **Repository layout**
  * `server/src/db/migrations/001_init.sql`: the full schema (tables, constraints, triggers, public views)
  * `server/src/auth/`: password hashing (scrypt), sessions, CSRF, **roles and permissions** (`permissions.ts`)
  * `server/src/services/`: business rules (donations, submissions/approvals, donors/duplicates, tasks, publication, email)
  * `server/src/routes/`: the HTTP API (`public.ts` is the only anonymous surface)
  * `server/src/cli/`: `create-admin` and `setup-db-roles` commands
  * `server/test/`: automated tests for workflows A–G plus security tests
  * `client/src/`: the React app (`pages/public/*` are the public pages)

### Data model (summary)

`events` · `donors` (+ `donor_history` snapshots) · `donations` · `donation_submissions` (+ `submission_events` review history) · `donation_notes` · `follow_up_tasks` (+ `task_events`) · `donation_media` · `thank_you_messages` · `donation_status_history` · `donation_statuses` (configurable) · `donation_shares` · `users` (+ `user_permissions`) · `notifications` · `email_log` · `audit_log` · `app_settings`

The 19 required donation fields map to database columns as follows:

| Spreadsheet field | Where it lives |
|---|---|
| EventID | `donations.event_id` → `events.id` |
| DonorID | `donations.donor_id` → `donors.id` |
| BusinessorDonor/Org, ContactName, ContactEmail, ContactPhone, BusinessWebsite, SocialMediaID | `donors.name`, `contact_name`, `contact_email`, `contact_phone`, `website`, `social_media` (JSON list, several platforms). Stored once per donor, not copied into each donation. |
| DonationCategory / SubCategory | `donations.category` / `subcategory`. A database CHECK enforces that the subcategory exists only for Food. |
| DescriptionoftheDonation, Quantity | `donations.description`, `quantity` (positive integer) |
| $Value | `donations.estimated_value_cad` NUMERIC(12,2) CAD, plus `value_is_estimate` when staff estimated it |
| Status | `donations.status` → `donation_statuses` (configurable). Publication status is a separate column. |
| Notes | `donation_notes` table: many timestamped notes, each with an author. Never public. |
| NextFollowUpDate | `donations.next_follow_up_date`, kept in sync with one open task in `follow_up_tasks` |
| PickUpDetails | `delivery_method`, `pickup_address`, `pickup_instructions`, `pickup_preferred_dates`, `pickup_scheduled_for` (restricted) |
| ItemRec'd | `item_received` (default No) + `received_at`, `received_by`, `received_quantity` (partial receipt) |
| ThankYouStatus | `thank_you_sent` (default No) + `thank_you_stage` (not started / draft prepared / sent / not required), `thank_you_sent_at`, `thank_you_sent_by`, `thank_you_method` |

The original form data is stored unchanged in `donation_submissions.submission_data`. Reviewer corrections go in `reviewed_data`, so you can always see what the donor originally sent.

---

## 2. Run it locally

Requirements: Node.js 20+ and PostgreSQL 14+.

```bash
npm install
```

```bash
createdb empty_bowls
```

```bash
cp .env.example server/.env
```

Then edit `server/.env` and set `DATABASE_URL` and `SESSION_SECRET`, plus `NODE_ENV=development` for local use.

```bash
npm run migrate
```

```bash
npm run create-admin -- --email you@charity.ca --name "Your Name"
```

```bash
npm run dev
```

`npm run dev` starts the API on port 3000 and the React dev server on http://localhost:5173 (it proxies `/api`).

To try it with sample users, use a separate, empty database:

```bash
DEMO_PASSWORD="choose-a-long-password" npm run seed-demo --workspace server
```

This creates `super@demo.test`, `admin@demo.test`, `owner@demo.test` and `volunteer@demo.test`, plus a demo event. Never run it against your real database (it refuses to run when `NODE_ENV=production`).

### Tests

The tests need a separate, disposable database. They wipe and recreate its schema.

```bash
createdb empty_bowls_test
```

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/empty_bowls_test npm test
```

The test setup also creates a restricted role named `eb_public_test`, so the test database user needs the `CREATEROLE` privilege. CI (`.github/workflows/ci.yml`) runs type-checks, tests and a production build on every push.

---

## 3. Environment variables

The full annotated list is in [`.env.example`](.env.example). Never commit real values.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection used by the app |
| `SESSION_SECRET` | ✅ (prod) | 32+ random characters that sign session cookies. Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `APP_BASE_URL` | ✅ | Public URL, used in email links |
| `NODE_ENV` | ✅ | `production` enables secure cookies and strict checks |
| `PUBLIC_DATABASE_URL` | recommended | Restricted role for the public pages (§7) |
| `DATABASE_SSL` | if needed | `true` for managed databases that require SSL |
| `UPLOAD_DIR` | recommended | Folder for images. **Must be persistent storage.** |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | optional | Turns on email. Without it, notifications appear in the app only. |
| `EMBED_ALLOWED_ORIGINS` | optional | Websites allowed to show the form or gallery in an iframe |
| `APP_TIMEZONE` | optional | Time zone used for "today" and "overdue" (default `America/Toronto`) |
| `TRUST_PROXY` | optional | Number of reverse proxies in front of the app (default `1` in production). Needed for correct rate limiting. |
| `HASH_SALT`, `MAX_UPLOAD_MB`, `SESSION_MAX_AGE_HOURS`, `PUBLIC_SUBMISSION_RATE_LIMIT`, `AUTO_MIGRATE`, `PORT` | optional | See `.env.example` |

**Getting SMTP credentials:** use your email provider's SMTP settings. Examples are Google Workspace (an app password), Microsoft 365, or a transactional service such as Postmark, Mailgun, Amazon SES or Brevo, many of which have nonprofit or free tiers. Set `EMAIL_FROM` to an address on a domain you have verified with that provider.

---

## 4. Deployment

The app is one Node process plus PostgreSQL plus a persistent folder for images.

**Option A: a Node host (Render, Railway, Fly.io, Heroku-style).**
1. Create a managed PostgreSQL database. Turn on **automatic daily backups and point-in-time recovery**, which is your backup and recovery plan.
2. Create a web service from this repository:
   * Build command: `npm ci && npm run build`
   * Start command: `npm start`
3. Attach a **persistent disk** and set `UPLOAD_DIR` to a folder on it. Without one, uploaded images are lost on redeploy.
4. Set the environment variables from §3. Migrations run automatically at start-up (`AUTO_MIGRATE`).
5. Open a shell on the service and create the first Super Admin (§5).
6. Optional but recommended: set up the least-privilege database roles (§7).

**Option B: Docker / a VPS.**

```bash
docker compose up -d --build
```

This uses `docker-compose.yml` (PostgreSQL plus the app, with volumes for data and images). Put a `.env` file with `POSTGRES_PASSWORD`, `SESSION_SECRET` and `APP_BASE_URL` next to it, and put an HTTPS reverse proxy (Caddy or Nginx) in front. *The Dockerfile was written but not built in the development environment, which had no Docker daemon. Test it before relying on it.*

Back up the image volume as well as the database (for example with a nightly `pg_dump` plus a copy of `UPLOAD_DIR`). Test a restore at least once before your event.

---

## 5. Create the first Super Admin

Run this once, on the server:

```bash
npm run create-admin -- --email you@charity.ca --name "Your Name"
```

In Docker, or after `npm run build` without dev tools:

```bash
node server/dist/cli/create-admin.js --email you@charity.ca --name "Your Name"
```

The command asks for a password (12+ characters) without showing it, or reads it from `ADMIN_PASSWORD`. It refuses to run if a Super Admin already exists, unless you add `--additional`. Keep at least two Super Admins so the charity is never locked out. The app will not let you deactivate or demote the last one.

## 6. Add users and assign roles

1. Sign in and go to **Administration → Users and Permissions → Add user**.
2. Enter a name, email and role. The app shows a **temporary password once**. Give it to the person in person or by phone, not by email. They must change it at their first sign-in.
3. To fine-tune what someone can do, a Super Admin clicks **Permissions**. For example, you can let an Admin publish donations, let a volunteer see contact details, or let a volunteer submit donations for donors.
4. To give someone access to particular records, assign the donation to them, use **Shared with** on the donation page, set them as the donor's **Record owner**, or give them a task on that donation.

| Role | Default abilities |
|---|---|
| **Super Admin** | Everything: users and permissions, settings, audit log, archive and restore, delete donors and erase their personal information, exports, publishing |
| **Admin** | Day-to-day work: all donors and donations, approvals, assignments, tasks, pickups, thank-yous, events, reports, exports, and managing Record Owner and Volunteer accounts. **Publishing is off by default** and a Super Admin grants it. Admins can't change Super Admins or Admins. |
| **Record Owner** | Records assigned or shared to them, or donors they own: edit permitted fields, notes, follow-ups, pickups, mark received, thank-yous, submit donations for approval |
| **Volunteer** | Records assigned or shared to them only, their own tasks and permitted fields. **No contact or pickup details by default.** |
| **Donor (public)** | Submit the form, get a reference number, and answer a secure "more information" link. No access to anything else. |

## 7. Least-privilege database roles (recommended)

After the first migration, run this once with the owner or admin connection:

```bash
ADMIN_DATABASE_URL=postgres://owner:...@host/db APP_DB_PASSWORD=... PUBLIC_DB_PASSWORD=... npm run setup-db-roles
```

This creates two roles:
* `charity_app`: can read and write data but **cannot change the schema**, and the audit log is append-only for it. Use it in `DATABASE_URL`. Then set `AUTO_MIGRATE=false` and run `npm run migrate` with the owner role when you upgrade.
* `charity_public`: can **only** `SELECT` from `public_events`, `public_gallery_donations` and `public_gallery_media`. Use it in `PUBLIC_DATABASE_URL`. Even a bug in the public pages could not read donors, contacts, notes, submissions or users.

I verified this setup end to end: every browser workflow passed with the app connected as these two roles.

## 8. Connect the form and gallery to your website

* **Link to them:**
  * Donation form: `https://YOUR-APP/submit`
  * Form for one event: `https://YOUR-APP/submit?event=EVENT-CODE` (the event code is shown under Event Management)
  * Gallery: `https://YOUR-APP/gallery`, or `https://YOUR-APP/gallery?event=EVENT-CODE` for one event
* **Embed them:** set `EMBED_ALLOWED_ORIGINS=https://www.yourcharity.ca`, then add:

  ```html
  <iframe src="https://YOUR-APP/submit?event=empty-bowls-2026&embed=1" style="width:100%;min-height:1600px;border:0" title="Donate an item"></iframe>
  <iframe src="https://YOUR-APP/gallery?embed=1" style="width:100%;min-height:1200px;border:0" title="Auction donations"></iframe>
  ```

  `embed=1` hides the app's own header and footer.
* Staff sign in at `https://YOUR-APP/login`.
* Edit the privacy notice, recognition wording, confirmation message and gallery text in **Settings**.

---

## 9. How the key requirements are met

**Submission → approval → publication**
* Public submissions are stored as *Pending Review* with a unique reference such as `EB-2026-7KQ4-M9TX`. Reviewers get an in-app notification, plus email if configured. The donor sees a confirmation that says the donation will be reviewed, not that it has been approved.
* Anti-abuse protections: a hidden honeypot field, a signed form token with a minimum fill time, per-IP rate limits, an idempotency key (so a double-click creates one record), a 5 MB image limit, and image type checked from the file's bytes (JPEG, PNG, WebP or GIF).
* Reviewers can correct details (the original is kept), link to an existing donor, see likely duplicates (matching email, phone or name, including variants such as "Inc."), add notes, request more information (a single-use link that expires in 30 days), decline (history kept), or approve.
* Approval creates the donor (or links an existing one) and the donation in **one transaction**. A unique constraint on `donations.submission_id` makes double approval impossible. Creating a new donor when likely duplicates exist requires an explicit confirmation.
* Public recognition is decided separately. Even "approve recognition" only moves the donation to *Pending Publication Approval*.
* **Publishing** requires all of: the `publication.manage` permission, an explicit confirmation, an internally approved status, recorded public consent, and a reviewed public description. The database refuses to store a published donation without consent. Unpublishing sets the donation to *Withdrawn* and keeps the record.

**Public data never leaks.** The gallery API queries only the `public_gallery_donations` view. That view contains only approved public fields: title, public description, category, quantity and value when approved for display, and donor name and website when approved. Images are served by random UUID, and only if the image is marked public **and** its donation is currently published.

**Follow-ups.** Setting *NextFollowUpDate* creates or updates exactly **one** open task for the responsible user (enforced by a partial unique index). Changing the date reschedules that task. Clearing the date marks it *no longer required*. Completing it keeps the task as history and clears the date. Overdue items are highlighted everywhere.

**Receipt and thank-you.** Marking an item received records who and when, and supports partial receipt. Thank-you drafts never count as sent. A thank-you is marked sent only when a user confirms it, or when SMTP accepts a reviewed email that the user explicitly chose to send.

**Security.** Passwords are hashed with scrypt. Sessions are server-side in PostgreSQL, sign-in regenerates the session, cookies are HttpOnly and SameSite (and Secure in production), and sessions expire after 8 hours of inactivity. Every state-changing request needs a CSRF token. Accounts lock for 15 minutes after 8 failed sign-ins, and sign-ins are rate-limited. Deactivating a user ends their sessions immediately. Every route checks permissions on the server, and record-level scoping is done in SQL. Inputs are validated with zod on the server. Queries are parameterised. Helmet sets security headers, including a strict CSP. CSV exports guard against spreadsheet formula injection. An audit log records sign-ins, changes, approvals, publications and exports.

**Privacy.** Contact details and pickup addresses are visible only with `donors.view_all` or `contacts.view_assigned`. Settings include a configurable retention clean-up for declined submissions. A donor's personal information can be erased for privacy requests while their donation amounts are kept. Exports respect permissions and are audited. *These features support your privacy obligations (for example under PIPEDA), but they do not by themselves make the charity compliant. Review the privacy notice and your retention periods with someone qualified.*

---

## 10. Testing performed

* **Automated (`npm test`, 48 tests)** against a real PostgreSQL database. They cover workflows A–G from the specification, CSRF and authentication, account lockout, forced password change, the public role's lack of access, CSV injection, and phone and duplicate normalisation.
* **Browser end-to-end** (Playwright, run during development; the script is not in the repository): the public form on a phone-sized screen (including the Food → Soup/Bread/Dessert behaviour), confirmation, admin approval, follow-up, pickup, receipt, thank-you, publish and unpublish, a volunteer's restricted view and blocked admin URLs, and every internal page. There were no browser console errors. This was repeated with the app connected through the least-privilege database roles.

## 11. Not finished, or needs configuration

* **Email** is built in but sends nothing until SMTP variables are set. Until then, notifications are in-app only, the "more information" link must be copied and sent by staff, and thank-yous are sent manually and then confirmed.
* **Image storage** uses a local or persistent disk. To use S3, Cloudflare R2 or Supabase Storage instead, replace `server/src/services/media.ts`. Uploaded images are not resized, and their EXIF/GPS metadata is **not stripped**. Ask donors to avoid photos taken at home, or add an image-processing step.
* **Rate limiting** keeps its counters in memory, which works for one app instance. With several instances, use a shared store such as Redis.
* **Donor accounts** (donors signing in to see their own submissions) are not built. The data model links submissions to donors, so this can be added later.
* **No password-reset email.** Admins reset passwords and get a one-time temporary password. Two-factor authentication is not built in.
* **Backups** rely on your database host. Set them up and test a restore.
* **Spam protection** has no CAPTCHA. A service such as hCaptcha or Cloudflare Turnstile can be added to the form if abuse becomes a problem.
* The Docker setup has not been built or run (no Docker daemon was available in development).
