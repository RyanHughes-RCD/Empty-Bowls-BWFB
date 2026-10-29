import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubmissionFields, emptySubmission, toPayload, type SubmissionData } from '../components/SubmissionFields';
import { Alert, ErrorAlert, Field, PageHeader, fieldErrors, useToast } from '../components/ui';
import { ApiError, api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { getStoredEvent, useEvents, useUserOptions } from '../lib/data';
import { CATEGORIES, CATEGORY_LABELS, SUBCATEGORIES, SUBCATEGORY_LABELS, newUuid } from '../lib/format';

interface DonorHit {
  id: number;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
}

export default function DonationForm() {
  const { can } = useAuth();
  const canDirect = can('donations.create');
  const [mode, setMode] = useState<'direct' | 'submit'>(canDirect ? 'direct' : 'submit');
  return (
    <div className="stack">
      <PageHeader
        title="Add donation"
        subtitle={mode === 'direct' ? 'Record a donation directly in the database (it is approved immediately, but not published).' : 'Submit a donation on behalf of a donor. It will go to Donation Approvals for review.'}
      />
      {canDirect && can('submissions.create') && (
        <div className="tabs" role="tablist">
          <button role="tab" className="tab" aria-selected={mode === 'direct'} onClick={() => setMode('direct')}>
            Add directly
          </button>
          <button role="tab" className="tab" aria-selected={mode === 'submit'} onClick={() => setMode('submit')}>
            Submit for approval
          </button>
        </div>
      )}
      {mode === 'direct' ? <DirectForm /> : <InternalSubmitForm />}
    </div>
  );
}

function InternalSubmitForm() {
  const { data: events } = useEvents();
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState<SubmissionData>(emptySubmission(getStoredEvent() ?? ''));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newUuid());
  const open = (events ?? []).filter((e) => ['active', 'planning'].includes(e.status));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ id: number; reference: string }>('/api/submissions', { ...toPayload(form), privacy_acknowledged: true, idempotency_key: key.current });
      toast(`Submitted for approval (${r.reference})`);
      navigate(`/app/approvals/${r.id}`);
    } catch (err) {
      setError(err);
      window.scrollTo({ top: 0 });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="stack" noValidate>
      <ErrorAlert error={error} />
      <Alert kind="info">Confirm the donor has agreed to our privacy notice before submitting their information. Only tick public recognition if the donor said yes.</Alert>
      <SubmissionFields value={form} onChange={setForm} errors={fieldErrors(error)} events={open} idPrefix="is" />
      <div className="button-row">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Submitting…' : 'Submit for approval'}
        </button>
      </div>
    </form>
  );
}

function DirectForm() {
  const { can } = useAuth();
  const { data: events } = useEvents();
  const { data: users } = useUserOptions();
  const navigate = useNavigate();
  const toast = useToast();
  const [donorMode, setDonorMode] = useState<'existing' | 'new'>('existing');
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<DonorHit[]>([]);
  const [donor, setDonor] = useState<DonorHit | null>(null);
  const [newDonor, setNewDonor] = useState({ name: '', contact_name: '', contact_email: '', contact_phone: '', website: '' });
  const [f, setF] = useState({
    event_id: (getStoredEvent() ?? '') as number | '',
    category: '',
    subcategory: '',
    description: '',
    quantity: '1',
    estimated_value_cad: '',
    value_is_estimate: false,
    assigned_to: '' as number | '',
    next_follow_up_date: '',
    delivery_method: 'undecided',
    pickup_address: '',
    pickup_instructions: '',
    public_consent: false,
    public_consent_source: '',
    note: '',
  });
  const [error, setError] = useState<unknown>(null);
  const [dups, setDups] = useState<{ id: number; name: string; reasons: string[] }[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (donorMode !== 'existing' || search.trim().length < 2) return setHits([]);
    const t = setTimeout(() => {
      api
        .get<{ rows: DonorHit[] }>(`/api/donors${qs({ q: search, page_size: 8 })}`)
        .then((r) => setHits(r.rows))
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [search, donorMode]);

  const submit = async (e: FormEvent, confirmNotDuplicate = false) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        ...f,
        subcategory: f.category === 'food' ? f.subcategory || null : null,
        assigned_to: f.assigned_to || null,
        next_follow_up_date: f.next_follow_up_date || null,
        donor_id: donorMode === 'existing' ? donor?.id : undefined,
        new_donor: donorMode === 'new' ? newDonor : undefined,
        confirm_not_duplicate: confirmNotDuplicate,
      };
      const r = await api.post<{ id: number }>('/api/donations', body);
      toast('Donation added');
      navigate(`/app/donations/${r.id}`);
    } catch (err) {
      if ((err as ApiError).status === 409 && (err as ApiError).details?.duplicates) setDups((err as ApiError).details!.duplicates as never);
      else setError(err);
    } finally {
      setBusy(false);
    }
  };
  const errs = fieldErrors(error);
  const usable = (events ?? []).filter((e) => !['closed', 'archived'].includes(e.status));

  return (
    <form onSubmit={submit} className="stack" noValidate>
      <ErrorAlert error={error} />
      <fieldset>
        <legend>Donor</legend>
        <div className="stack">
          <div className="radio-group" role="radiogroup" aria-label="Donor">
            <label className="checkbox">
              <input type="radio" checked={donorMode === 'existing'} onChange={() => setDonorMode('existing')} /> <span>Existing donor</span>
            </label>
            {can('donors.create') && (
              <label className="checkbox">
                <input type="radio" checked={donorMode === 'new'} onChange={() => setDonorMode('new')} /> <span>New donor</span>
              </label>
            )}
          </div>
          {donorMode === 'existing' ? (
            donor ? (
              <div className="row">
                <strong>{donor.name}</strong> <span className="muted">{donor.contact_name}</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDonor(null)}>
                  Change
                </button>
              </div>
            ) : (
              <Field id="donor-search" label="Search donors" error={errs.donor_id} hint="Type at least 2 letters of the name, contact or email">
                <input id="donor-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
                {hits.length > 0 && (
                  <ul className="dup-list" style={{ marginTop: '0.5rem' }}>
                    {hits.map((h) => (
                      <li key={h.id}>
                        <button type="button" className="btn-link" onClick={() => setDonor(h)}>
                          {h.name}
                        </button>{' '}
                        <span className="muted small">
                          {h.contact_name} {h.contact_email}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Field>
            )
          ) : (
            <div className="form-grid">
              {(
                [
                  ['name', 'Business, donor or organization name', 'text'],
                  ['contact_name', 'Contact name', 'text'],
                  ['contact_email', 'Contact email', 'email'],
                  ['contact_phone', 'Contact phone', 'tel'],
                  ['website', 'Website', 'text'],
                ] as const
              ).map(([k, l, t]) => (
                <Field key={k} id={`nd-${k}`} label={l} required={k === 'name'} error={errs[`new_donor.${k}`]}>
                  <input id={`nd-${k}`} type={t} value={newDonor[k]} onChange={(e) => setNewDonor({ ...newDonor, [k]: e.target.value })} />
                </Field>
              ))}
            </div>
          )}
        </div>
      </fieldset>

      <fieldset>
        <legend>Donation</legend>
        <div className="form-grid">
          <Field id="df-event" label="Event" required error={errs.event_id}>
            <select id="df-event" value={f.event_id} onChange={(e) => setF({ ...f, event_id: e.target.value ? Number(e.target.value) : '' })}>
              <option value="">Choose an event…</option>
              {usable.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.name}
                </option>
              ))}
            </select>
          </Field>
          <div />
          <Field id="df-cat" label="Category" required error={errs.category}>
            <select id="df-cat" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value, subcategory: e.target.value === 'food' ? f.subcategory : '' })}>
              <option value="">Choose…</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
          {f.category === 'food' ? (
            <Field id="df-sub" label="Food type" required error={errs.subcategory}>
              <select id="df-sub" value={f.subcategory} onChange={(e) => setF({ ...f, subcategory: e.target.value })}>
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
            <Field id="df-desc" label="Description" required error={errs.description}>
              <textarea id="df-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            </Field>
          </div>
          <Field id="df-qty" label="Quantity" required error={errs.quantity}>
            <input id="df-qty" type="number" min={1} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
          </Field>
          <Field id="df-val" label="Estimated value (CAD)" error={errs.estimated_value_cad}>
            <input id="df-val" type="number" min={0} step="0.01" value={f.estimated_value_cad} onChange={(e) => setF({ ...f, estimated_value_cad: e.target.value })} />
          </Field>
          <label className="checkbox span-2">
            <input type="checkbox" checked={f.value_is_estimate} onChange={(e) => setF({ ...f, value_is_estimate: e.target.checked })} />
            <span>Value estimated by staff</span>
          </label>
          <Field id="df-assign" label="Assign to">
            <select id="df-assign" value={f.assigned_to} onChange={(e) => setF({ ...f, assigned_to: e.target.value ? Number(e.target.value) : '' })}>
              <option value="">Unassigned</option>
              {(users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <Field id="df-fu" label="Next follow-up date">
            <input id="df-fu" type="date" value={f.next_follow_up_date} onChange={(e) => setF({ ...f, next_follow_up_date: e.target.value })} />
          </Field>
          <Field id="df-del" label="Delivery">
            <select id="df-del" value={f.delivery_method} onChange={(e) => setF({ ...f, delivery_method: e.target.value })}>
              <option value="undecided">Not decided yet</option>
              <option value="donor_delivers">Donor will deliver</option>
              <option value="pickup_required">Pickup required</option>
            </select>
          </Field>
          <Field id="df-paddr" label="Pickup address">
            <input id="df-paddr" type="text" value={f.pickup_address} onChange={(e) => setF({ ...f, pickup_address: e.target.value })} />
          </Field>
          <div className="span-2">
            <Field id="df-note" label="Internal note (optional)">
              <textarea id="df-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} style={{ minHeight: 60 }} />
            </Field>
          </div>
          <label className="checkbox span-2">
            <input type="checkbox" checked={f.public_consent} onChange={(e) => setF({ ...f, public_consent: e.target.checked })} />
            <span>The donor has consented to public recognition</span>
          </label>
          {f.public_consent && (
            <div className="span-2">
              <Field id="df-cs" label="How was consent given?">
                <input id="df-cs" type="text" value={f.public_consent_source} onChange={(e) => setF({ ...f, public_consent_source: e.target.value })} placeholder="e.g. Phone call with owner, Oct 30" />
              </Field>
            </div>
          )}
        </div>
      </fieldset>
      <div className="button-row">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Add donation'}
        </button>
      </div>
      {dups && (
        <Alert kind="warning" title="This donor may already exist">
          <ul>
            {dups.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => {
                    setDonorMode('existing');
                    setDonor({ id: d.id, name: d.name, contact_name: null, contact_email: null });
                    setDups(null);
                  }}
                >
                  Use {d.name}
                </button>{' '}
                <span className="small">({d.reasons.join(', ')})</span>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-secondary btn-sm" onClick={(e) => submit(e as unknown as FormEvent, true)}>
            No — this is a new donor
          </button>
        </Alert>
      )}
    </form>
  );
}
