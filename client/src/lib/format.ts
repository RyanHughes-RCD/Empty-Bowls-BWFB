export const CATEGORY_LABELS: Record<string, string> = {
  bowls: 'Bowls',
  food: 'Food',
  auction: 'Auction',
  door_prize: 'Door Prize',
  other: 'Other',
};
export const CATEGORIES = Object.keys(CATEGORY_LABELS);
export const SUBCATEGORY_LABELS: Record<string, string> = { soup: 'Soup', bread: 'Bread', dessert: 'Dessert' };
export const SUBCATEGORIES = Object.keys(SUBCATEGORY_LABELS);

export const PUBLICATION_LABELS: Record<string, string> = {
  unpublished: 'Unpublished',
  pending_publication_approval: 'Pending Publication Approval',
  published: 'Published',
  withdrawn: 'Unpublished / Withdrawn',
};
export const SUBMISSION_STATUS_LABELS: Record<string, string> = {
  pending_review: 'Pending Review',
  awaiting_donor_info: 'Awaiting Donor Information',
  approved: 'Approved',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};
export const DELIVERY_LABELS: Record<string, string> = {
  donor_delivers: 'Donor will deliver',
  pickup_required: 'Pickup required',
  undecided: 'Not decided yet',
};
export const THANK_YOU_STAGE_LABELS: Record<string, string> = {
  not_started: 'Not started',
  draft_prepared: 'Draft prepared (not sent)',
  sent: 'Sent',
  not_required: 'Not required',
};
export const METHOD_LABELS: Record<string, string> = {
  email: 'Email',
  letter: 'Letter',
  card: 'Card',
  phone: 'Phone call',
  in_person: 'In person',
  other: 'Other',
};
export const PRIORITY_LABELS: Record<string, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export const TASK_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'No longer required',
};
export const EVENT_STATUS_LABELS: Record<string, string> = { planning: 'Planning', active: 'Active', closed: 'Closed', archived: 'Archived' };

const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
export function money(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  return cad.format(Number(v));
}

export function date(v: string | null | undefined): string {
  if (!v) return '—';
  // Plain dates (YYYY-MM-DD) must not be shifted by time zones.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  return new Date(v).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function dateTime(v: string | null | undefined): string {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function categoryText(category: string, sub?: string | null) {
  return sub ? `${CATEGORY_LABELS[category]} – ${SUBCATEGORY_LABELS[sub]}` : (CATEGORY_LABELS[category] ?? category);
}

export function newUuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16),
  );
}
