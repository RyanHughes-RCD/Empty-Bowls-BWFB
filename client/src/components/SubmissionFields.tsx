import { CATEGORIES, CATEGORY_LABELS, SUBCATEGORIES, SUBCATEGORY_LABELS } from '../lib/format';
import { Field, describedBy } from './ui';

export interface SubmissionData {
  event_id: number | '';
  donor_name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  website: string;
  social_media: string;
  category: string;
  subcategory: string;
  description: string;
  quantity: string;
  estimated_value_cad: string;
  additional_info: string;
  delivery_method: string;
  pickup_address: string;
  availability: string;
  logistics_notes: string;
  public_consent: boolean;
}

export const emptySubmission = (eventId: number | '' = ''): SubmissionData => ({
  event_id: eventId,
  donor_name: '',
  contact_name: '',
  contact_email: '',
  contact_phone: '',
  website: '',
  social_media: '',
  category: '',
  subcategory: '',
  description: '',
  quantity: '1',
  estimated_value_cad: '',
  additional_info: '',
  delivery_method: '',
  pickup_address: '',
  availability: '',
  logistics_notes: '',
  public_consent: false,
});

/** Converts stored submission JSON (from the server) into form state. */
export function fromServer(d: Record<string, unknown>): SubmissionData {
  const social = d.social_media as { handle: string }[] | string | null;
  return {
    ...emptySubmission(),
    ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === null || v === undefined ? '' : v])),
    social_media: Array.isArray(social) ? social.map((s) => s.handle).join(', ') : (social ?? ''),
    quantity: String(d.quantity ?? '1'),
    estimated_value_cad: d.estimated_value_cad === null || d.estimated_value_cad === undefined ? '' : String(d.estimated_value_cad),
    public_consent: Boolean(d.public_consent),
  } as SubmissionData;
}

export function toPayload(d: SubmissionData) {
  return {
    ...d,
    event_id: d.event_id === '' ? undefined : d.event_id,
    social_media: d.social_media
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((handle) => ({ platform: /^https?:\/\//.test(handle) ? 'Profile' : 'Handle', handle })),
    subcategory: d.category === 'food' ? d.subcategory || null : null,
    pickup_address: d.delivery_method === 'pickup_required' ? d.pickup_address : d.pickup_address || null,
  };
}

interface Props {
  value: SubmissionData;
  onChange: (v: SubmissionData) => void;
  errors: Record<string, string>;
  events: { id: number; name: string }[];
  eventLocked?: boolean;
  showConsent?: boolean;
  recognitionNotice?: string;
  idPrefix?: string;
}

/** Donor, donation and pickup fields shared by the public form, internal submissions and review edits. */
export function SubmissionFields({ value, onChange, errors, events, eventLocked, showConsent = true, recognitionNotice, idPrefix = 'f' }: Props) {
  const set = <K extends keyof SubmissionData>(k: K, v: SubmissionData[K]) => onChange({ ...value, [k]: v });
  const id = (k: string) => `${idPrefix}-${k}`;
  const text = (k: keyof SubmissionData, label: string, opts: { type?: string; required?: boolean; hint?: string; autoComplete?: string; span?: boolean } = {}) => (
    <div className={opts.span ? 'span-2' : ''}>
      <Field id={id(k)} label={label} required={opts.required} error={errors[k]} hint={opts.hint}>
        <input
          id={id(k)}
          type={opts.type ?? 'text'}
          value={value[k] as string}
          onChange={(e) => set(k, e.target.value as never)}
          required={opts.required}
          autoComplete={opts.autoComplete}
          aria-invalid={Boolean(errors[k])}
          aria-describedby={describedBy(id(k), errors[k], Boolean(opts.hint))}
        />
      </Field>
    </div>
  );

  return (
    <div className="stack">
      <fieldset>
        <legend>Event</legend>
        <Field id={id('event_id')} label="Which event is this donation for?" required error={errors.event_id}>
          <select
            id={id('event_id')}
            value={value.event_id}
            disabled={eventLocked}
            onChange={(e) => set('event_id', e.target.value ? Number(e.target.value) : '')}
            required
            aria-invalid={Boolean(errors.event_id)}
          >
            <option value="">Choose an event…</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>

      <fieldset>
        <legend>Donor information</legend>
        <div className="form-grid">
          {text('donor_name', 'Business, donor or organization name', { required: true, autoComplete: 'organization', span: true })}
          {text('contact_name', 'Contact name', { required: true, autoComplete: 'name' })}
          {text('contact_email', 'Contact email', { type: 'email', required: true, autoComplete: 'email' })}
          {text('contact_phone', 'Contact phone', { type: 'tel', autoComplete: 'tel', hint: 'e.g. 905-555-0123' })}
          {text('website', 'Business website', { type: 'text', autoComplete: 'url', hint: 'Optional, e.g. www.example.ca' })}
          {text('social_media', 'Social media', { hint: 'Optional. Handles or profile links, separated by commas (e.g. @ourbakery)', span: true })}
        </div>
      </fieldset>

      <fieldset>
        <legend>Donation information</legend>
        <div className="form-grid">
          <Field id={id('category')} label="Donation category" required error={errors.category}>
            <select
              id={id('category')}
              value={value.category}
              onChange={(e) => onChange({ ...value, category: e.target.value, subcategory: e.target.value === 'food' ? value.subcategory : '' })}
              required
              aria-invalid={Boolean(errors.category)}
            >
              <option value="">Choose a category…</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
          {value.category === 'food' ? (
            <Field id={id('subcategory')} label="Food type" required error={errors.subcategory}>
              <select id={id('subcategory')} value={value.subcategory} onChange={(e) => set('subcategory', e.target.value)} required aria-invalid={Boolean(errors.subcategory)}>
                <option value="">Choose…</option>
                {SUBCATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {SUBCATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div />
          )}
          <div className="span-2">
            <Field id={id('description')} label="Description of the donation" required error={errors.description} hint="What is it? Include size, brand, number of servings, expiry dates, etc.">
              <textarea
                id={id('description')}
                value={value.description}
                maxLength={5000}
                onChange={(e) => set('description', e.target.value)}
                required
                aria-invalid={Boolean(errors.description)}
                aria-describedby={describedBy(id('description'), errors.description, true)}
              />
            </Field>
          </div>
          <Field id={id('quantity')} label="Quantity" required error={errors.quantity} hint="Number of items, packages or certificates">
            <input id={id('quantity')} type="number" min={1} step={1} value={value.quantity} onChange={(e) => set('quantity', e.target.value)} required aria-invalid={Boolean(errors.quantity)} />
          </Field>
          <Field id={id('estimated_value_cad')} label="Estimated value (CAD $)" error={errors.estimated_value_cad} hint="Your best estimate of the retail value. Leave blank if unsure.">
            <input
              id={id('estimated_value_cad')}
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={value.estimated_value_cad}
              onChange={(e) => set('estimated_value_cad', e.target.value)}
              aria-invalid={Boolean(errors.estimated_value_cad)}
            />
          </Field>
          <div className="span-2">
            <Field id={id('additional_info')} label="Additional information" error={errors.additional_info} hint="Optional">
              <textarea id={id('additional_info')} value={value.additional_info} maxLength={3000} onChange={(e) => set('additional_info', e.target.value)} />
            </Field>
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Pickup / delivery</legend>
        <div className="stack">
          <div role="radiogroup" aria-labelledby={id('delivery-label')} className="stack-sm">
            <div className="label" id={id('delivery-label')}>
              How will the donation reach us? <span className="required">*</span>
            </div>
            <div className="radio-group">
              {[
                ['donor_delivers', 'I will deliver it'],
                ['pickup_required', 'Please pick it up'],
                ['undecided', 'Not sure yet'],
              ].map(([v, l]) => (
                <label key={v} className="checkbox">
                  <input type="radio" name={id('delivery')} value={v} checked={value.delivery_method === v} onChange={() => set('delivery_method', v)} />
                  <span>{l}</span>
                </label>
              ))}
            </div>
            {errors.delivery_method && <div className="field-error">{errors.delivery_method}</div>}
          </div>
          {value.delivery_method === 'pickup_required' && (
            <Field id={id('pickup_address')} label="Pickup address" required error={errors.pickup_address} hint="Kept private — only our team will see it.">
              <textarea id={id('pickup_address')} value={value.pickup_address} onChange={(e) => set('pickup_address', e.target.value)} style={{ minHeight: 70 }} />
            </Field>
          )}
          <div className="form-grid">
            <Field id={id('availability')} label="General availability / preferred dates" error={errors.availability} hint="Optional">
              <textarea id={id('availability')} value={value.availability} onChange={(e) => set('availability', e.target.value)} style={{ minHeight: 70 }} />
            </Field>
            <Field id={id('logistics_notes')} label="Logistical notes" error={errors.logistics_notes} hint="Optional — parking, refrigeration, fragile items…">
              <textarea id={id('logistics_notes')} value={value.logistics_notes} onChange={(e) => set('logistics_notes', e.target.value)} style={{ minHeight: 70 }} />
            </Field>
          </div>
        </div>
      </fieldset>

      {showConsent && (
        <fieldset>
          <legend>Public recognition (optional)</legend>
          {recognitionNotice && <p className="muted">{recognitionNotice}</p>}
          <label className="checkbox">
            <input type="checkbox" checked={value.public_consent} onChange={(e) => set('public_consent', e.target.checked)} />
            <span>Yes, you may publicly acknowledge this donation (subject to review). My contact details will not be published.</span>
          </label>
        </fieldset>
      )}
    </div>
  );
}
