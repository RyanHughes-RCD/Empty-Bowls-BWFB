import { z } from 'zod';
import { type Db, pool } from '../db/pool.js';

export const settingsSchema = z.object({
  charity_name: z.string().trim().min(1).max(200),
  charity_contact_email: z.string().trim().max(320),
  privacy_notice: z.string().trim().min(1).max(10000),
  recognition_notice: z.string().trim().min(1).max(3000),
  submission_confirmation_message: z.string().trim().min(1).max(3000),
  submissions_enabled: z.boolean(),
  image_uploads_enabled: z.boolean(),
  send_donor_confirmation_email: z.boolean(),
  notify_extra_emails: z.array(z.string().trim().email()).max(20),
  gallery_title: z.string().trim().min(1).max(200),
  gallery_intro: z.string().trim().max(3000),
  gallery_show_totals: z.boolean(),
  thank_you_subject_template: z.string().trim().min(1).max(300),
  thank_you_body_template: z.string().trim().min(1).max(10000),
  declined_retention_days: z.number().int().min(30).max(3650),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  charity_name: 'Empty Bowls Charity Auction',
  charity_contact_email: '',
  privacy_notice:
    'We collect the contact and donation information on this form so that we can review your donation, ' +
    'arrange pickup or delivery, thank you, and keep records of our charity auction. Your information is ' +
    'stored securely, is only available to authorized staff and volunteers, and is never sold or shared ' +
    'with third parties. Your email address, phone number and pickup details will never be published. ' +
    'You may ask us to see, correct or delete your information at any time by contacting us.',
  recognition_notice:
    'With your permission we may acknowledge your donation on our website and at the event (for example, ' +
    'your business name, website and a description or photo of your donation). Public recognition is ' +
    'optional, is subject to review by our team, and does not affect whether we accept your donation. ' +
    'Private contact information is never published.',
  submission_confirmation_message:
    "Thank you for supporting our charity auction! Your donation information has been received and will be " +
    "reviewed by our team. We'll contact you if we need any additional information.",
  submissions_enabled: true,
  image_uploads_enabled: true,
  send_donor_confirmation_email: true,
  notify_extra_emails: [],
  gallery_title: 'Our Generous Donors',
  gallery_intro:
    'Our auction is made possible by the generosity of local businesses, artists and neighbours. ' +
    'Here are some of the wonderful donations you can look forward to.',
  gallery_show_totals: true,
  thank_you_subject_template: 'Thank you for supporting {{charity_name}}',
  thank_you_body_template:
    'Dear {{contact_name}},\n\nOn behalf of everyone at {{charity_name}}, thank you for your generous donation of ' +
    '{{donation_description}} to {{event_name}}.\n\nYour support makes a real difference in our community.\n\n' +
    'With gratitude,\n{{sender_name}}\n{{charity_name}}',
  declined_retention_days: 365,
};

/** Settings that are safe to show on public pages. */
export const PUBLIC_SETTING_KEYS = [
  'charity_name',
  'charity_contact_email',
  'privacy_notice',
  'recognition_notice',
  'submission_confirmation_message',
  'submissions_enabled',
  'image_uploads_enabled',
  'gallery_title',
  'gallery_intro',
  'gallery_show_totals',
] as const;

export async function getSettings(db: Db = pool): Promise<Settings> {
  const { rows } = await db.query('SELECT key, value FROM app_settings');
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) merged[r.key] = r.value;
  return merged as Settings;
}

export async function getPublicSettings(db: Db = pool) {
  const s = await getSettings(db);
  return Object.fromEntries(PUBLIC_SETTING_KEYS.map((k) => [k, s[k]]));
}

export async function saveSettings(values: Partial<Settings>, userId: number, db: Db = pool) {
  for (const [key, value] of Object.entries(values)) {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), userId],
    );
  }
}

export function fillTemplate(template: string, values: Record<string, string | null | undefined>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, key) => values[key] ?? '');
}
