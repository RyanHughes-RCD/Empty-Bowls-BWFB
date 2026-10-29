import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PublicLayout, usePublicSettings } from '../../components/PublicLayout';
import { SubmissionFields, emptySubmission, toPayload, type SubmissionData } from '../../components/SubmissionFields';
import { Alert, ErrorAlert, Field, Spinner, fieldErrors } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { newUuid } from '../../lib/format';
import { useApi } from '../../lib/useApi';

interface PublicEvent {
  id: number;
  code: string;
  name: string;
  accepting_submissions: boolean;
}

const MAX_MB = 5;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export default function Submit() {
  const [params] = useSearchParams();
  const { data: settings, loading: sLoading } = usePublicSettings();
  const { data: events, loading: eLoading } = useApi<PublicEvent[]>('/api/public/events');
  const open = useMemo(() => (events ?? []).filter((e) => e.accepting_submissions), [events]);
  const preselected = open.find((e) => e.code === params.get('event'));

  const [form, setForm] = useState<SubmissionData>(emptySubmission());
  const [privacy, setPrivacy] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [imageAlt, setImageAlt] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ reference: string; message: string } | null>(null);
  const formToken = useRef<string | null>(null);
  const idempotencyKey = useRef(newUuid());
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<{ token: string }>('/api/public/form-token').then((r) => (formToken.current = r.token)).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (preselected) setForm((f) => ({ ...f, event_id: preselected.id }));
    else if (open.length === 1) setForm((f) => ({ ...f, event_id: open[0].id }));
  }, [preselected, open]);

  const onImage = (f: File | null) => {
    setErrors((e) => ({ ...e, image: '' }));
    if (f && !IMAGE_TYPES.includes(f.type)) {
      setErrors((e) => ({ ...e, image: 'Please choose a JPEG, PNG, WebP or GIF image.' }));
      return setImage(null);
    }
    if (f && f.size > MAX_MB * 1024 * 1024) {
      setErrors((e) => ({ ...e, image: `Images must be ${MAX_MB} MB or smaller.` }));
      return setImage(null);
    }
    setImage(f);
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.event_id) e.event_id = 'Choose an event';
    if (!form.donor_name.trim()) e.donor_name = 'Business, donor or organization name is required';
    if (!form.contact_name.trim()) e.contact_name = 'Contact name is required';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.contact_email.trim())) e.contact_email = 'Enter a valid email address';
    if (!form.category) e.category = 'Choose a donation category';
    if (form.category === 'food' && !form.subcategory) e.subcategory = 'Choose Soup, Bread or Dessert';
    if (!form.description.trim()) e.description = 'Please describe the donation';
    if (!/^\d+$/.test(form.quantity) || Number(form.quantity) < 1) e.quantity = 'Quantity must be a whole number of at least 1';
    if (form.estimated_value_cad && (Number.isNaN(Number(form.estimated_value_cad)) || Number(form.estimated_value_cad) < 0)) e.estimated_value_cad = 'Enter a dollar amount of 0 or more';
    if (!form.delivery_method) e.delivery_method = 'Tell us how the donation will reach us';
    if (form.delivery_method === 'pickup_required' && !form.pickup_address.trim()) e.pickup_address = 'Enter the pickup address';
    if (!privacy) e.privacy = 'Please confirm that you have read the privacy notice';
    return e;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (submitting) return; // prevent double submission
    const e = validate();
    setErrors(e);
    setError(null);
    if (Object.values(e).some(Boolean)) {
      setTimeout(() => errorRef.current?.focus(), 0);
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set(
        'data',
        JSON.stringify({
          ...toPayload(form),
          privacy_acknowledged: privacy,
          form_token: formToken.current,
          idempotency_key: idempotencyKey.current,
          company_fax: honeypot,
          image_alt: imageAlt,
        }),
      );
      if (image) fd.set('image', image);
      const r = await api.post<{ reference: string; message: string }>('/api/public/submissions', fd);
      setDone(r);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err);
      if ((err as ApiError).message?.includes('expired')) {
        api.get<{ token: string }>('/api/public/form-token').then((r) => (formToken.current = r.token)).catch(() => undefined);
      }
      setTimeout(() => errorRef.current?.focus(), 0);
    } finally {
      setSubmitting(false);
    }
  };

  if (sLoading || eLoading) return <PublicLayout title="Donate" narrow settings={settings}><Spinner /></PublicLayout>;

  if (done) {
    return (
      <PublicLayout title="Thank you" narrow settings={settings}>
        <div className="card confirmation stack">
          <div style={{ fontSize: '3rem' }} aria-hidden="true">
            🥣
          </div>
          <h1>Thank you!</h1>
          <p>{done.message}</p>
          <p>Your submission reference number is:</p>
          <p className="reference">{done.reference}</p>
          <p className="muted small">Please keep this reference for your records. Your donation has been received for review — it has not yet been confirmed.</p>
          <div className="button-row" style={{ justifyContent: 'center' }}>
            <button
              className="btn btn-secondary"
              onClick={() => {
                idempotencyKey.current = newUuid();
                setForm({ ...emptySubmission(form.event_id), donor_name: form.donor_name, contact_name: form.contact_name, contact_email: form.contact_email, contact_phone: form.contact_phone, website: form.website, social_media: form.social_media });
                setImage(null);
                setDone(null);
              }}
            >
              Submit another donation
            </button>
            <Link className="btn btn-primary" to="/gallery">
              See our auction donations
            </Link>
          </div>
        </div>
      </PublicLayout>
    );
  }

  const fieldErrorList = Object.entries(errors).filter(([, v]) => v);

  return (
    <PublicLayout title="Donate an item" narrow settings={settings}>
      <h1>Donate to our charity auction</h1>
      <p className="muted">Thank you for considering a donation! Fields marked * are required. It takes about 5 minutes.</p>
      {settings && !settings.submissions_enabled ? (
        <Alert kind="warning">Donation submissions are currently closed. Please contact us directly.</Alert>
      ) : open.length === 0 ? (
        <Alert kind="info">No events are accepting donations right now. Please check back soon.</Alert>
      ) : (
        <form onSubmit={submit} noValidate className="stack">
          <div ref={errorRef} tabIndex={-1}>
            {fieldErrorList.length > 0 && (
              <Alert kind="error" title="Please correct the following:">
                <ul>
                  {fieldErrorList.map(([k, v]) => (
                    <li key={k}>{v}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {error && !fieldErrorList.length ? <ErrorAlert error={error} /> : null}
          </div>
          <SubmissionFields value={form} onChange={setForm} errors={errors} events={open} eventLocked={Boolean(preselected)} recognitionNotice={settings?.recognition_notice} />

          {settings?.image_uploads_enabled && (
            <fieldset>
              <legend>Photo (optional)</legend>
              <div className="stack">
                <Field id="image" label="Upload a photo of your donation" error={errors.image} hint={`JPEG, PNG, WebP or GIF, up to ${MAX_MB} MB.`}>
                  <input id="image" type="file" accept={IMAGE_TYPES.join(',')} onChange={(e) => onImage(e.target.files?.[0] ?? null)} />
                </Field>
                {image && (
                  <Field id="image-alt" label="Short description of the photo" hint="Helps people using screen readers.">
                    <input id="image-alt" type="text" maxLength={300} value={imageAlt} onChange={(e) => setImageAlt(e.target.value)} />
                  </Field>
                )}
              </div>
            </fieldset>
          )}

          <fieldset>
            <legend>Privacy</legend>
            <p className="small" style={{ whiteSpace: 'pre-wrap' }}>
              {settings?.privacy_notice}
            </p>
            <label className="checkbox">
              <input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} aria-invalid={Boolean(errors.privacy)} />
              <span>
                I have read the privacy notice and agree that my information may be used as described. <span className="required">*</span>
              </span>
            </label>
            {errors.privacy && <div className="field-error">{errors.privacy}</div>}
          </fieldset>

          {/* Honeypot field: hidden from people, bots tend to fill it in */}
          <div className="honeypot" aria-hidden="true">
            <label htmlFor="company_fax">Company fax</label>
            <input id="company_fax" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </div>

          <button className="btn btn-primary" type="submit" disabled={submitting} style={{ fontSize: '1.1rem', padding: '0.8rem 1.5rem' }}>
            {submitting ? 'Submitting…' : 'Submit donation'}
          </button>
        </form>
      )}
    </PublicLayout>
  );
}
