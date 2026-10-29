import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { SubmissionFields, fromServer, toPayload, type SubmissionData } from '../components/SubmissionFields';
import { Alert, Badge, ConfirmDialog, ErrorAlert, Field, Modal, PageHeader, Spinner, SubmissionBadge, YesNo, fieldErrors, useToast } from '../components/ui';
import { ApiError, api, qs } from '../lib/api';
import { useEvents, useStatuses, useUserOptions } from '../lib/data';
import { DELIVERY_LABELS, categoryText, dateTime, money } from '../lib/format';
import { useApi } from '../lib/useApi';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Duplicate {
  id: number;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  score: number;
  reasons: string[];
}
interface Detail {
  submission: Row;
  events: Row[];
  media: Row[];
  duplicates: Duplicate[];
  linkedDonor: Row | null;
  canReview: boolean;
}

const ACTION_LABELS: Record<string, string> = {
  submitted: 'Submitted',
  note: 'Internal note',
  edited: 'Details corrected',
  donor_linked: 'Donor linked',
  info_requested: 'More information requested',
  donor_response: 'Donor responded',
  approved: 'Approved',
  declined: 'Declined',
};

export default function ApprovalDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { data, error, loading, setData, reload } = useApi<Detail>(`/api/submissions/${id}`);
  const { data: events } = useEvents();
  const [editing, setEditing] = useState<SubmissionData | null>(null);
  const [editError, setEditError] = useState<unknown>(null);
  const [note, setNote] = useState('');
  const [dialog, setDialog] = useState<null | 'approve' | 'decline' | 'info'>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <ErrorAlert error={error} />;
  const s = data.submission;
  const current = (s.reviewed_data ?? s.submission_data) as Row;
  const open = ['pending_review', 'awaiting_donor_info'].includes(s.status);
  const can = data.canReview && open;

  const saveEdits = async () => {
    try {
      setData(await api.put<Detail>(`/api/submissions/${s.id}/reviewed-data`, toPayload(editing!)));
      toast('Corrections saved (original submission preserved)');
      setEditing(null);
    } catch (e) {
      setEditError(e);
    }
  };
  const addNote = async () => {
    try {
      await api.post(`/api/submissions/${s.id}/notes`, { text: note });
      setNote('');
      reload();
    } catch (e) {
      setActionError(e);
    }
  };

  return (
    <div className="stack">
      <PageHeader
        title={`Submission ${s.reference}`}
        subtitle={
          <span className="row" style={{ gap: '0.5rem' }}>
            <SubmissionBadge status={s.status} /> {s.event_name} · submitted {dateTime(s.submitted_at)} {s.source === 'internal' ? `by ${s.submitted_by_name}` : 'via public form'}
          </span>
        }
        actions={<Link to="/app/approvals" className="btn btn-secondary">← Approvals</Link>}
      />
      {s.donation_id && (
        <Alert kind="success">
          Approved {dateTime(s.reviewed_at)} by {s.reviewed_by_name}. <Link to={`/app/donations/${s.donation_id}`}>Open donation #{s.donation_id}</Link>
        </Alert>
      )}
      {s.status === 'declined' && <Alert kind="warning">Declined {dateTime(s.reviewed_at)} by {s.reviewed_by_name}{s.review_comments ? `: ${s.review_comments}` : ''}</Alert>}
      {s.status === 'awaiting_donor_info' && <Alert kind="info">Waiting for the donor to respond: “{s.info_request_message}”</Alert>}
      {data.canReview === false && open && s.submitted_by && <Alert kind="info">This submission is waiting for an administrator to review it.</Alert>}
      <ErrorAlert error={actionError} />

      {can && (
        <section className="card" aria-label="Review actions">
          <div className="quick-actions">
            <button className="btn btn-success" onClick={() => setDialog('approve')}>
              ✓ Approve…
            </button>
            <button className="btn btn-secondary" onClick={() => setDialog('info')}>
              Request more information…
            </button>
            <button className="btn btn-secondary" onClick={() => { setEditError(null); setEditing(fromServer(current)); }}>
              Edit details
            </button>
            <button className="btn btn-danger" onClick={() => setDialog('decline')}>
              Decline…
            </button>
          </div>
        </section>
      )}

      <div className="detail-grid">
        <div className="stack">
          <section className="card">
            <div className="card-header">
              <h2>Submitted information</h2>
              {s.reviewed_data && <Badge tone="amber">Corrected by reviewer</Badge>}
            </div>
            <SubmissionView d={current} hidden={Boolean(s.contact_hidden)} />
            {s.reviewed_data && (
              <details style={{ marginTop: '1rem' }}>
                <summary>View the original submission (unchanged)</summary>
                <SubmissionView d={s.submission_data} hidden={Boolean(s.contact_hidden)} />
              </details>
            )}
          </section>
          {data.media.length > 0 && (
            <section className="card">
              <h2>Photos</h2>
              <div className="thumbs">
                {data.media.map((m) => (
                  <div className="thumb" key={m.id}>
                    <img src={`/api/media/${m.id}`} alt={m.alt_text ?? ''} />
                    <div>{m.alt_text}</div>
                  </div>
                ))}
              </div>
              <p className="muted small">Photos stay private. They can be made public only after approval, from the donation's publication settings.</p>
            </section>
          )}
        </div>
        <div className="stack">
          {data.canReview && (
            <section className="card">
              <h2>Donor matching</h2>
              {data.linkedDonor && (
                <Alert kind="success">
                  Linked to existing donor <Link to={`/app/donors/${data.linkedDonor.id}`}>{data.linkedDonor.name}</Link>{' '}
                  {can && <button className="btn-link small" onClick={() => api.post<Detail>(`/api/submissions/${s.id}/link-donor`, { donor_id: null }).then(setData)}>unlink</button>}
                </Alert>
              )}
              {data.duplicates.length === 0 ? (
                <p className="muted">No likely existing donors found. A new donor record will be created on approval.</p>
              ) : (
                <>
                  <p className="muted small">Possible existing donor records:</p>
                  <ul className="dup-list">
                    {data.duplicates.map((d) => (
                      <li key={d.id}>
                        <div className="row between">
                          <Link to={`/app/donors/${d.id}`}>{d.name}</Link>
                          <Badge tone={d.score >= 60 ? 'red' : 'amber'}>{d.score >= 60 ? 'Likely match' : 'Possible match'}</Badge>
                        </div>
                        <div className="small">
                          {d.contact_name} {d.contact_email} {d.contact_phone}
                        </div>
                        <div className="small muted">{d.reasons.join(' · ')}</div>
                        {can && data.linkedDonor?.id !== d.id && (
                          <button className="btn btn-secondary btn-sm" style={{ marginTop: '0.4rem' }} onClick={() => api.post<Detail>(`/api/submissions/${s.id}/link-donor`, { donor_id: d.id }).then(setData)}>
                            Link to this donor
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
          <section className="card">
            <h2>
              Review history <span className="private-tag">· INTERNAL</span>
            </h2>
            <ul className="timeline">
              {data.events.map((e) => (
                <li key={e.id}>
                  <strong>{ACTION_LABELS[e.action] ?? e.action}</strong>
                  {e.comment && <div className={e.action === 'note' || e.action === 'donor_response' ? 'note' : ''}>{e.comment}</div>}
                  <div className="muted small">
                    {dateTime(e.created_at)} · {e.actor_name ?? (e.action === 'donor_response' || e.action === 'submitted' ? 'Donor' : 'System')}
                  </div>
                </li>
              ))}
            </ul>
            {data.canReview && (
              <div className="stack-sm">
                <label htmlFor="sub-note" className="visually-hidden">
                  Add internal note
                </label>
                <textarea id="sub-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add an internal note" style={{ minHeight: 60 }} />
                <button className="btn btn-secondary btn-sm" disabled={!note.trim()} onClick={addNote}>
                  Add note
                </button>
              </div>
            )}
          </section>
        </div>
      </div>

      <Modal open={Boolean(editing)} title="Correct submission details" onClose={() => setEditing(null)} wide>
        {editing && (
          <div className="stack">
            <Alert kind="info">The donor's original submission is preserved; your corrections are stored separately.</Alert>
            <ErrorAlert error={editError} />
            <SubmissionFields value={editing} onChange={setEditing} errors={fieldErrors(editError)} events={(events ?? []).filter((e) => e.status !== 'archived')} showConsent={false} idPrefix="rv" />
            <div className="button-row">
              <button className="btn btn-primary" onClick={saveEdits}>
                Save corrections
              </button>
              <button className="btn btn-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Modal>
      {dialog === 'approve' && <ApproveDialog detail={data} data={current} onClose={() => setDialog(null)} />}
      {dialog === 'decline' && <DeclineDialog id={s.id} onClose={() => setDialog(null)} onDone={(d) => { setData(d); setDialog(null); toast('Submission declined'); }} />}
      {dialog === 'info' && <InfoDialog id={s.id} onClose={() => { setDialog(null); reload(); }} />}
    </div>
  );
}

function SubmissionView({ d, hidden }: { d: Row; hidden: boolean }) {
  if (d.redacted) return <p className="muted">Personal information was removed under the data retention policy.</p>;
  const social = Array.isArray(d.social_media) ? d.social_media.map((x: Row) => x.handle).join(', ') : d.social_media;
  return (
    <dl className="details">
      <dt>Business / Donor / Org</dt>
      <dd>{d.donor_name}</dd>
      {hidden ? (
        <>
          <dt>Contact</dt>
          <dd className="muted">Restricted</dd>
        </>
      ) : (
        <>
          <dt>Contact name</dt>
          <dd>{d.contact_name || '—'}</dd>
          <dt>Contact email</dt>
          <dd>{d.contact_email ? <a href={`mailto:${d.contact_email}`}>{d.contact_email}</a> : '—'}</dd>
          <dt>Contact phone</dt>
          <dd>{d.contact_phone || '—'}</dd>
          <dt>Social media</dt>
          <dd>{social || '—'}</dd>
        </>
      )}
      <dt>Website</dt>
      <dd>{d.website || '—'}</dd>
      <dt>Category</dt>
      <dd>{d.category ? categoryText(d.category, d.subcategory) : '—'}</dd>
      <dt>Description</dt>
      <dd style={{ whiteSpace: 'pre-wrap' }}>{d.description}</dd>
      <dt>Quantity</dt>
      <dd>{d.quantity}</dd>
      <dt>Estimated value</dt>
      <dd>{money(d.estimated_value_cad)}</dd>
      <dt>Additional info</dt>
      <dd style={{ whiteSpace: 'pre-wrap' }}>{d.additional_info || '—'}</dd>
      <dt>Delivery</dt>
      <dd>{DELIVERY_LABELS[d.delivery_method] ?? '—'}</dd>
      {!hidden && (
        <>
          <dt>Pickup address</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{d.pickup_address || '—'}</dd>
          <dt>Availability</dt>
          <dd>{d.availability || '—'}</dd>
          <dt>Logistics notes</dt>
          <dd>{d.logistics_notes || '—'}</dd>
        </>
      )}
      <dt>Public recognition consent</dt>
      <dd>
        <YesNo value={Boolean(d.public_consent)} />
      </dd>
    </dl>
  );
}

function ApproveDialog({ detail, data, onClose }: { detail: Detail; data: Row; onClose: () => void }) {
  const s = detail.submission;
  const toast = useToast();
  const { data: users } = useUserOptions();
  const { data: statuses } = useStatuses();
  const top = detail.linkedDonor?.id ?? (detail.duplicates[0]?.score >= 60 ? detail.duplicates[0].id : null);
  const [donorMode, setDonorMode] = useState<'existing' | 'new'>(top ? 'existing' : 'new');
  const [donorId, setDonorId] = useState<number | ''>(top ?? '');
  const [updateContact, setUpdateContact] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [f, setF] = useState({
    status: 'approved',
    assigned_to: '' as number | '',
    next_follow_up_date: '',
    recognition: s.public_consent ? 'approve' : 'decide_later',
    value_is_estimate: false,
    estimated_value_cad: data.estimated_value_cad ?? '',
    comment: '',
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Row[]>([]);
  useEffect(() => {
    if (search.trim().length < 2) return setFound([]);
    const t = setTimeout(() => {
      api
        .get<{ rows: Row[] }>(`/api/donors${qs({ q: search, page_size: 10 })}`)
        .then((r) => setFound(r.rows))
        .catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(t);
  }, [search]);
  const base = [...(detail.linkedDonor ? [detail.linkedDonor] : []), ...detail.duplicates.filter((d) => d.id !== detail.linkedDonor?.id)];
  const donorChoices = [...base, ...found.filter((f) => !base.some((b) => b.id === f.id))];

  const approve = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ donationId: number }>(`/api/submissions/${s.id}/approve`, {
        donor: donorMode === 'existing' ? { mode: 'existing', donor_id: donorId, update_contact: updateContact } : { mode: 'new', confirm_not_duplicate: confirmNew },
        event_id: data.event_id ?? s.event_id,
        category: data.category,
        subcategory: data.category === 'food' ? data.subcategory : null,
        description: data.description,
        quantity: data.quantity,
        estimated_value_cad: f.estimated_value_cad === '' ? null : f.estimated_value_cad,
        value_is_estimate: f.value_is_estimate,
        status: f.status,
        assigned_to: f.assigned_to || null,
        next_follow_up_date: f.next_follow_up_date || null,
        recognition: f.recognition,
        comment: f.comment || null,
      });
      toast('Submission approved');
      setDone(r.donationId);
    } catch (e) {
      setError(e);
      if ((e as ApiError).details?.duplicates) setConfirmNew(false);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Modal open title="Approved" onClose={onClose}>
        <div className="stack">
          <Alert kind="success">
            Donation #{done} was created. It is <strong>not public</strong> — publication is a separate step in the donation's Publication settings.
          </Alert>
          <div className="button-row">
            <Link className="btn btn-primary" to={`/app/donations/${done}`}>
              Open donation
            </Link>
            <Link className="btn btn-secondary" to="/app/approvals">
              Back to queue
            </Link>
          </div>
        </div>
      </Modal>
    );
  }

  const dupErr = (error as ApiError)?.details?.duplicates;
  return (
    <Modal open title={`Approve ${s.reference}`} onClose={onClose} wide>
      <div className="stack">
        <p>
          <strong>{data.donor_name}</strong> · {categoryText(data.category, data.subcategory)} · qty {data.quantity} · {s.event_name}
        </p>
        <ErrorAlert error={error} />
        {dupErr ? <Alert kind="warning">Choose an existing donor below, or tick “This is a new donor” to confirm.</Alert> : null}
        <fieldset>
          <legend>Donor record</legend>
          <div className="radio-group">
            <label className="checkbox">
              <input type="radio" checked={donorMode === 'existing'} onChange={() => setDonorMode('existing')} />
              <span>Link to an existing donor</span>
            </label>
            {donorMode === 'existing' && (
              <div style={{ paddingLeft: '1.8rem' }} className="stack-sm">
                <input type="search" aria-label="Search existing donors" placeholder="Search donors by name, contact or email" value={search} onChange={(e) => setSearch(e.target.value)} />
                <select aria-label="Existing donor" value={donorId} onChange={(e) => setDonorId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">Choose…</option>
                  {donorChoices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} (#{d.id})
                    </option>
                  ))}
                </select>
                <label className="checkbox">
                  <input type="checkbox" checked={updateContact} onChange={(e) => setUpdateContact(e.target.checked)} />
                  <span>Update this donor's contact details with the submitted information (previous values are kept in history)</span>
                </label>
              </div>
            )}
            <label className="checkbox">
              <input type="radio" checked={donorMode === 'new'} onChange={() => setDonorMode('new')} />
              <span>Create a new donor record</span>
            </label>
            {donorMode === 'new' && detail.duplicates.length > 0 && (
              <label className="checkbox" style={{ paddingLeft: '1.8rem' }}>
                <input type="checkbox" checked={confirmNew} onChange={(e) => setConfirmNew(e.target.checked)} />
                <span>I checked the possible duplicates — this is a new donor</span>
              </label>
            )}
          </div>
        </fieldset>
        <div className="form-grid">
          <Field id="ap-status" label="Operational status">
            <select id="ap-status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              {(statuses ?? [])
                .filter((x) => x.counts_as_approved && x.is_active)
                .map((x) => (
                  <option key={x.code} value={x.code}>
                    {x.label}
                  </option>
                ))}
            </select>
          </Field>
          <Field id="ap-assign" label="Assign to">
            <select id="ap-assign" value={f.assigned_to} onChange={(e) => setF({ ...f, assigned_to: e.target.value ? Number(e.target.value) : '' })}>
              <option value="">Unassigned</option>
              {(users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <Field id="ap-fu" label="Schedule a follow-up (optional)">
            <input id="ap-fu" type="date" value={f.next_follow_up_date} onChange={(e) => setF({ ...f, next_follow_up_date: e.target.value })} />
          </Field>
          <Field id="ap-val" label="Estimated value (CAD)" error={fieldErrors(error).estimated_value_cad}>
            <input id="ap-val" type="number" min={0} step="0.01" value={f.estimated_value_cad} onChange={(e) => setF({ ...f, estimated_value_cad: e.target.value })} />
          </Field>
          <label className="checkbox span-2">
            <input type="checkbox" checked={f.value_is_estimate} onChange={(e) => setF({ ...f, value_is_estimate: e.target.checked })} />
            <span>Value estimated by staff (donor didn't know)</span>
          </label>
        </div>
        <fieldset>
          <legend>Public recognition</legend>
          {s.public_consent ? (
            <div className="radio-group">
              {[
                ['approve', 'Approve public recognition (moves to “Pending Publication Approval”; still not public)'],
                ['decline', 'Decline public recognition'],
                ['decide_later', 'Decide later'],
              ].map(([k, l]) => (
                <label className="checkbox" key={k}>
                  <input type="radio" checked={f.recognition === k} onChange={() => setF({ ...f, recognition: k })} />
                  <span>{l}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="muted">The donor did not consent to public recognition. The donation will stay unpublished unless consent is recorded later.</p>
          )}
        </fieldset>
        <Field id="ap-comment" label="Approval comment (optional, internal)">
          <input id="ap-comment" type="text" value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />
        </Field>
        <div className="button-row">
          <button className="btn btn-success" disabled={busy || (donorMode === 'existing' && !donorId)} onClick={approve}>
            {busy ? 'Approving…' : 'Approve donation'}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DeclineDialog({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: (d: Detail) => void }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <ConfirmDialog
      open
      title="Decline this submission?"
      confirmLabel="Decline"
      danger
      busy={busy}
      onCancel={onClose}
      onConfirm={async () => {
        setBusy(true);
        try {
          onDone(await api.post<Detail>(`/api/submissions/${id}/decline`, { comment: comment || null }));
        } catch (e) {
          setError(e);
        } finally {
          setBusy(false);
        }
      }}
      message="The submission and its history are kept for your records. The donor is not notified automatically."
    >
      <ErrorAlert error={error} />
      <Field id="dc" label="Reason (internal)">
        <textarea id="dc" value={comment} onChange={(e) => setComment(e.target.value)} style={{ minHeight: 70 }} />
      </Field>
    </ConfirmDialog>
  );
}

function InfoDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const [message, setMessage] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [result, setResult] = useState<{ link: string; emailStatus: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open title="Request more information" onClose={onClose}>
      {result ? (
        <div className="stack">
          {result.emailStatus === 'sent' ? (
            <Alert kind="success">The donor was emailed a secure link.</Alert>
          ) : (
            <Alert kind="warning">
              {result.emailStatus === 'not_configured' ? 'Email is not configured, so no email was sent.' : result.emailStatus === 'not_requested' ? 'No email was sent.' : 'The email could not be sent.'} Copy this secure link and send it to the donor yourself. It works once and expires in 30 days. It will not be shown again.
            </Alert>
          )}
          <input type="text" readOnly value={result.link} aria-label="Secure link" onFocus={(e) => e.target.select()} />
          <div className="button-row">
            <button className="btn btn-secondary" onClick={() => navigator.clipboard?.writeText(result.link)}>
              Copy link
            </button>
            <button className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <ErrorAlert error={error} />
          <Field id="ir-msg" label="What do you need from the donor?" hint="This message is shown to the donor.">
            <textarea id="ir-msg" value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
            <span>Email the donor a secure link (if email is configured)</span>
          </label>
          <div className="button-row">
            <button
              className="btn btn-primary"
              disabled={busy || !message.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  setResult(await api.post(`/api/submissions/${id}/request-info`, { message, send_email: sendEmail }));
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send request
            </button>
            <button className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
