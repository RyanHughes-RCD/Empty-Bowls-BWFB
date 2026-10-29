import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { TaskTable, type Task } from '../components/TaskTable';
import {
  Alert,
  Badge,
  ConfirmDialog,
  ErrorAlert,
  Field,
  Modal,
  PageHeader,
  PublicationBadge,
  Spinner,
  StatusBadge,
  YesNo,
  fieldErrors,
  useToast,
} from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEvents, useStatuses, useUserOptions } from '../lib/data';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  DELIVERY_LABELS,
  METHOD_LABELS,
  SUBCATEGORIES,
  SUBCATEGORY_LABELS,
  THANK_YOU_STAGE_LABELS,
  categoryText,
  date,
  dateTime,
  money,
  todayISO,
} from '../lib/format';
import { useApi } from '../lib/useApi';
import { NewTaskDialog } from './Tasks';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Detail {
  donation: Row;
  notes: Row[] | null;
  tasks: Task[];
  statusHistory: Row[];
  media: Row[];
  thankYouMessages: Row[] | null;
  shares: Row[] | null;
  submission: Row | null;
  audit: Row[] | null;
  permissions: {
    editAll: boolean;
    editAssigned: boolean;
    editPickup: boolean;
    assign: boolean;
    receive: boolean;
    thankYou: boolean;
    publish: boolean;
    requestPublication: boolean;
    archive: boolean;
    notes: boolean;
    contacts: boolean;
    tasks: boolean;
  };
}

export default function DonationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, loading, setData, reload } = useApi<Detail>(`/api/donations/${id}`);
  const [dialog, setDialog] = useState<null | 'receive' | 'pickup' | 'followup' | 'task' | 'publish' | 'unpublish' | 'archive' | 'thankyou'>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const run = async (fn: () => Promise<Detail | unknown>, message: string) => {
    setBusy(true);
    setActionError(null);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'donation' in (r as object)) setData(r as Detail);
      else await reload();
      toast(message);
      setDialog(null);
      return true;
    } catch (e) {
      setActionError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Spinner />;
  if (error) {
    return (
      <div className="stack">
        <PageHeader title={`Donation #${id}`} />
        <ErrorAlert error={error} />
        <Link to="/app/donations">← Back to donations</Link>
      </div>
    );
  }
  if (!data) return null;
  const d = data.donation;
  const p = data.permissions;
  const approved = !['new_submission', 'pending_review', 'awaiting_donor_info', 'declined'].includes(d.status);

  return (
    <div className="stack">
      <PageHeader
        title={`Donation #${d.id}`}
        subtitle={
          <span className="row" style={{ gap: '0.5rem' }}>
            <span>
              {d.donor_name} · {categoryText(d.category, d.subcategory)} · {d.event_name}
            </span>
            <StatusBadge code={d.status} label={d.status_label} />
            <PublicationBadge status={d.publication_status} />
            {d.is_archived && <Badge tone="red">Archived</Badge>}
          </span>
        }
        actions={<Link to="/app/donations" className="btn btn-secondary">← All donations</Link>}
      />
      {d.is_archived && (
        <Alert kind="warning">
          This donation is archived. {p.archive && <button className="btn-link" onClick={() => run(() => api.post(`/api/donations/${d.id}/restore`), 'Donation restored')}>Restore it</button>}
        </Alert>
      )}
      <ErrorAlert error={actionError} />

      {!d.is_archived && approved && (
        <section className="card" aria-label="Quick actions">
          <div className="quick-actions">
            {p.receive && !d.item_received && (
              <button className="btn btn-success" onClick={() => setDialog('receive')}>
                ✓ Mark item received
              </button>
            )}
            {p.editPickup && !d.item_received && (
              <button className="btn btn-secondary" onClick={() => setDialog('pickup')}>
                🚚 Schedule pickup
              </button>
            )}
            {p.editAssigned && (
              <button className="btn btn-secondary" onClick={() => setDialog('followup')}>
                📅 {d.next_follow_up_date ? 'Change follow-up' : 'Add follow-up'}
              </button>
            )}
            {p.tasks && (
              <button className="btn btn-secondary" onClick={() => setDialog('task')}>
                + Task
              </button>
            )}
            {p.thankYou && !d.thank_you_sent && d.thank_you_required && (
              <button className="btn btn-secondary" onClick={() => document.getElementById('thank-you')?.scrollIntoView({ behavior: 'smooth' })}>
                ✉ Thank-you
              </button>
            )}
            {p.publish && d.publication_status !== 'published' && (
              <button className="btn btn-secondary" onClick={() => setDialog('publish')}>
                🌐 Approve for publication
              </button>
            )}
            {p.publish && d.publication_status === 'published' && (
              <button className="btn btn-secondary" onClick={() => setDialog('unpublish')}>
                Unpublish
              </button>
            )}
            {!p.publish && p.requestPublication && !['published', 'pending_publication_approval'].includes(d.publication_status) && (
              <button className="btn btn-secondary" onClick={() => run(() => api.post(`/api/donations/${d.id}/request-publication`), 'Publication requested')}>
                Request publication
              </button>
            )}
            {p.archive && (
              <button className="btn btn-secondary" onClick={() => setDialog('archive')}>
                Archive
              </button>
            )}
          </div>
        </section>
      )}

      <div className="detail-grid">
        <div className="stack">
          <DonationDetailsCard detail={data} onSaved={setData} />
          <PickupCard detail={data} onSaved={setData} />
          <ReceiptCard d={d} />
          <ThankYouCard detail={data} onChanged={setData} reload={reload} />
          <PublicationCard detail={data} onChanged={setData} />
        </div>
        <div className="stack">
          <DonorCard d={d} contacts={p.contacts} />
          <AssignmentCard detail={data} onSaved={setData} />
          <NotesCard detail={data} reload={reload} />
          <section className="card">
            <div className="card-header">
              <h2>Follow-ups &amp; tasks</h2>
            </div>
            <TaskTable tasks={data.tasks} onChanged={reload} compact empty="No tasks for this donation." showAssignee />
          </section>
          <HistoryCard detail={data} />
        </div>
      </div>

      {dialog === 'receive' && <ReceiveDialog d={d} busy={busy} onClose={() => setDialog(null)} onSubmit={(body) => run(() => api.post(`/api/donations/${d.id}/receive`, body), 'Item marked as received')} />}
      {dialog === 'pickup' && <PickupDialog d={d} busy={busy} onClose={() => setDialog(null)} onSubmit={(body) => run(() => api.post(`/api/donations/${d.id}/pickup`, body), 'Pickup scheduled')} />}
      {dialog === 'followup' && <FollowUpDialog d={d} busy={busy} onClose={() => setDialog(null)} onSubmit={(date) => run(() => api.patch(`/api/donations/${d.id}`, { next_follow_up_date: date }), date ? 'Follow-up scheduled' : 'Follow-up cleared')} />}
      {dialog === 'task' && <NewTaskDialog donationId={d.id} onClose={() => setDialog(null)} onCreated={reload} />}
      <ConfirmDialog
        open={dialog === 'publish'}
        title="Publish to the public gallery?"
        confirmLabel="Yes, publish"
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => run(() => api.post(`/api/donations/${d.id}/publish`, { confirm: true }), 'Donation published')}
        message={
          <div className="stack-sm">
            <p>Only the reviewed public fields will be shown:</p>
            <ul>
              <li>Title: {d.public_title || <em>none</em>}</li>
              <li>Description: {d.public_description || <strong className="field-error">missing — add it under Publication settings</strong>}</li>
              <li>Donor name: {d.show_donor_name ? d.donor_public_display_name || d.donor_name : 'hidden'}</li>
              <li>Website: {d.show_website && d.show_donor_name ? d.donor_website || 'none on file' : 'hidden'}</li>
              <li>Value: {d.show_value ? money(d.estimated_value_cad) : 'hidden'}</li>
              <li>Public images: {data.media.filter((m) => m.is_public).length}</li>
            </ul>
            {!d.public_consent && <Alert kind="error">Public recognition consent has not been recorded, so this cannot be published.</Alert>}
            <p className="small muted">Contact details, notes, follow-ups and pickup information are never published.</p>
          </div>
        }
      />
      <ConfirmDialog
        open={dialog === 'unpublish'}
        title="Remove from the public gallery?"
        confirmLabel="Unpublish"
        danger
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => run(() => api.post(`/api/donations/${d.id}/unpublish`, {}), 'Donation unpublished')}
        message="The donation will disappear from the public gallery immediately. The internal record is kept."
      />
      <ConfirmDialog
        open={dialog === 'archive'}
        title="Archive this donation?"
        confirmLabel="Archive"
        danger
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => run(() => api.post(`/api/donations/${d.id}/archive`), 'Donation archived').then((ok) => ok && navigate('/app/donations'))}
        message="Archived donations are hidden from lists and reports, removed from the public gallery, and their open tasks are closed. A Super Admin can restore it later."
      />
    </div>
  );
}

function Card({ title, children, actions, id, privateTag }: { title: string; children: ReactNode; actions?: ReactNode; id?: string; privateTag?: boolean }) {
  return (
    <section className="card" id={id}>
      <div className="card-header">
        <h2>
          {title} {privateTag && <span className="private-tag">· INTERNAL</span>}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
function DonationDetailsCard({ detail, onSaved }: { detail: Detail; onSaved: (d: Detail) => void }) {
  const d = detail.donation;
  const p = detail.permissions;
  const { data: events } = useEvents();
  const { data: statuses } = useStatuses();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Row>({});
  const [error, setError] = useState<unknown>(null);
  const [confirmEvent, setConfirmEvent] = useState(false);
  const [busy, setBusy] = useState(false);
  const reviewStatuses = ['new_submission', 'pending_review', 'awaiting_donor_info', 'approved', 'declined'];

  const start = () => {
    setForm({
      event_id: d.event_id,
      category: d.category,
      subcategory: d.subcategory ?? '',
      description: d.description,
      quantity: d.quantity,
      estimated_value_cad: d.estimated_value_cad ?? '',
      value_is_estimate: d.value_is_estimate,
      status: d.status,
      status_comment: '',
    });
    setError(null);
    setEditing(true);
  };
  const save = async (confirmEventChange = false) => {
    const body: Row = {};
    const fields = p.editAll ? ['event_id', 'category', 'subcategory', 'value_is_estimate', 'description', 'quantity', 'estimated_value_cad', 'status'] : ['description', 'quantity', 'estimated_value_cad', 'status'];
    for (const f of fields) {
      const before = d[f] ?? '';
      const after = form[f] ?? '';
      if (String(before) !== String(after)) body[f] = f === 'subcategory' && !after ? null : after;
    }
    if (body.category && body.category !== 'food') body.subcategory = null;
    if (!Object.keys(body).length) return setEditing(false);
    if (body.event_id && !confirmEventChange) return setConfirmEvent(true);
    if (body.status && form.status_comment) body.status_comment = form.status_comment;
    if (confirmEventChange) body.confirm_event_change = true;
    setBusy(true);
    try {
      onSaved(await api.patch<Detail>(`/api/donations/${d.id}`, body));
      toast('Donation updated');
      setEditing(false);
      setConfirmEvent(false);
    } catch (e) {
      setError(e);
      setConfirmEvent(false);
    } finally {
      setBusy(false);
    }
  };
  const errs = fieldErrors(error);

  return (
    <Card title="Donation details" actions={p.editAssigned && !d.is_archived && !editing ? <button className="btn btn-secondary btn-sm" onClick={start}>Edit</button> : null}>
      {!editing ? (
        <dl className="details">
          <dt>DonationID</dt>
          <dd>#{d.id}</dd>
          <dt>Event</dt>
          <dd>{d.event_name}</dd>
          <dt>Category</dt>
          <dd>{CATEGORY_LABELS[d.category]}</dd>
          <dt>SubCategory</dt>
          <dd>{d.subcategory ? SUBCATEGORY_LABELS[d.subcategory] : '—'}</dd>
          <dt>Description</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{d.description}</dd>
          <dt>Quantity</dt>
          <dd>{d.quantity}</dd>
          <dt>Estimated value</dt>
          <dd>
            {money(d.estimated_value_cad)} {d.value_is_estimate && <Badge tone="amber">Estimated by staff</Badge>}
          </dd>
          <dt>Status</dt>
          <dd>
            <StatusBadge code={d.status} label={d.status_label} />
          </dd>
          <dt>Submission</dt>
          <dd>{d.submission_reference ? <Link to={`/app/approvals/${d.submission_id}`}>{d.submission_reference}</Link> : 'Added directly by staff'}</dd>
          <dt>Approved</dt>
          <dd>{d.approved_at ? `${dateTime(d.approved_at)} by ${d.approved_by_name ?? '—'}` : '—'}</dd>
          <dt>Created</dt>
          <dd>
            {dateTime(d.created_at)} {d.created_by_name && `by ${d.created_by_name}`}
          </dd>
        </dl>
      ) : (
        <div className="stack">
          <ErrorAlert error={error} />
          <div className="form-grid">
            {p.editAll && events && (
              <Field id="e-event" label="Event" error={errs.event_id} hint="Changing the event requires confirmation.">
                <select id="e-event" value={form.event_id} onChange={(e) => setForm({ ...form, event_id: Number(e.target.value) })}>
                  {events
                    .filter((ev) => ev.status !== 'archived' || ev.id === d.event_id)
                    .map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {ev.name}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <Field id="e-status" label="Status" error={errs.status}>
              <select id="e-status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {(statuses ?? [])
                  .filter((s) => (s.is_active || s.code === d.status) && (p.editAll || !reviewStatuses.includes(s.code) || s.code === d.status))
                  .map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.label}
                    </option>
                  ))}
              </select>
            </Field>
            {form.status !== d.status && (
              <div className="span-2">
                <Field id="e-status-comment" label="Reason for status change (optional)">
                  <input id="e-status-comment" type="text" value={form.status_comment} onChange={(e) => setForm({ ...form, status_comment: e.target.value })} />
                </Field>
              </div>
            )}
            {p.editAll && (
              <>
                <Field id="e-cat" label="Category" error={errs.category}>
                  <select id="e-cat" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value, subcategory: e.target.value === 'food' ? form.subcategory : '' })}>
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </Field>
                {form.category === 'food' ? (
                  <Field id="e-sub" label="Food type" error={errs.subcategory}>
                    <select id="e-sub" value={form.subcategory} onChange={(e) => setForm({ ...form, subcategory: e.target.value })}>
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
              </>
            )}
            <div className="span-2">
              <Field id="e-desc" label="Description" error={errs.description}>
                <textarea id="e-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </Field>
            </div>
            <Field id="e-qty" label="Quantity" error={errs.quantity}>
              <input id="e-qty" type="number" min={1} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
            </Field>
            <Field id="e-val" label="Estimated value (CAD)" error={errs.estimated_value_cad}>
              <input id="e-val" type="number" min={0} step="0.01" value={form.estimated_value_cad} onChange={(e) => setForm({ ...form, estimated_value_cad: e.target.value })} />
            </Field>
            {p.editAll && (
              <label className="checkbox span-2">
                <input type="checkbox" checked={form.value_is_estimate} onChange={(e) => setForm({ ...form, value_is_estimate: e.target.checked })} />
                <span>Value was estimated by staff (donor did not know the exact value)</span>
              </label>
            )}
          </div>
          <div className="button-row">
            <button className="btn btn-primary" disabled={busy} onClick={() => save()}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            <button className="btn btn-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmEvent}
        title="Move to a different event?"
        confirmLabel="Yes, move it"
        busy={busy}
        onCancel={() => setConfirmEvent(false)}
        onConfirm={() => save(true)}
        message={`This donation will be moved from "${d.event_name}" to "${events?.find((e) => e.id === form.event_id)?.name}". Its totals and tasks will move with it.`}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
function PickupCard({ detail, onSaved }: { detail: Detail; onSaved: (d: Detail) => void }) {
  const d = detail.donation;
  const p = detail.permissions;
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Row>({});
  const [error, setError] = useState<unknown>(null);
  if (!p.contacts) {
    return (
      <Card title="Pickup arrangements" privateTag>
        <dl className="details">
          <dt>Delivery</dt>
          <dd>{DELIVERY_LABELS[d.delivery_method]}</dd>
          <dt>Scheduled</dt>
          <dd>{dateTime(d.pickup_scheduled_for)}</dd>
        </dl>
        <p className="muted small">Pickup address and instructions are restricted.</p>
      </Card>
    );
  }
  const start = () => {
    setForm({
      delivery_method: d.delivery_method,
      pickup_address: d.pickup_address ?? '',
      pickup_preferred_dates: d.pickup_preferred_dates ?? '',
      pickup_instructions: d.pickup_instructions ?? '',
      pickup_scheduled_for: d.pickup_scheduled_for ? toLocalInput(d.pickup_scheduled_for) : '',
    });
    setEditing(true);
  };
  const save = async () => {
    try {
      onSaved(
        await api.patch<Detail>(`/api/donations/${d.id}`, {
          ...form,
          pickup_scheduled_for: form.pickup_scheduled_for ? new Date(form.pickup_scheduled_for).toISOString() : null,
        }),
      );
      toast('Pickup details saved');
      setEditing(false);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Card title="Pickup arrangements" privateTag actions={p.editPickup && !d.is_archived && !editing ? <button className="btn btn-secondary btn-sm" onClick={start}>Edit</button> : null}>
      {!editing ? (
        <dl className="details">
          <dt>Delivery</dt>
          <dd>{DELIVERY_LABELS[d.delivery_method]}</dd>
          <dt>Pickup address</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{d.pickup_address || '—'}</dd>
          <dt>Preferred dates</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{d.pickup_preferred_dates || '—'}</dd>
          <dt>Instructions / notes</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{d.pickup_instructions || '—'}</dd>
          <dt>Scheduled for</dt>
          <dd>{dateTime(d.pickup_scheduled_for)}</dd>
        </dl>
      ) : (
        <div className="stack">
          <ErrorAlert error={error} />
          <Field id="p-method" label="Delivery method">
            <select id="p-method" value={form.delivery_method} onChange={(e) => setForm({ ...form, delivery_method: e.target.value })}>
              {Object.entries(DELIVERY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field id="p-addr" label="Pickup address">
            <textarea id="p-addr" value={form.pickup_address} onChange={(e) => setForm({ ...form, pickup_address: e.target.value })} style={{ minHeight: 60 }} />
          </Field>
          <Field id="p-pref" label="Preferred dates / availability">
            <textarea id="p-pref" value={form.pickup_preferred_dates} onChange={(e) => setForm({ ...form, pickup_preferred_dates: e.target.value })} style={{ minHeight: 60 }} />
          </Field>
          <Field id="p-instr" label="Contact instructions / notes">
            <textarea id="p-instr" value={form.pickup_instructions} onChange={(e) => setForm({ ...form, pickup_instructions: e.target.value })} style={{ minHeight: 60 }} />
          </Field>
          <Field id="p-when" label="Scheduled for">
            <input id="p-when" type="datetime-local" value={form.pickup_scheduled_for} onChange={(e) => setForm({ ...form, pickup_scheduled_for: e.target.value })} />
          </Field>
          <div className="button-row">
            <button className="btn btn-primary" onClick={save}>
              Save
            </button>
            <button className="btn btn-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

function toLocalInput(iso: string) {
  const dt = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function ReceiptCard({ d }: { d: Row }) {
  return (
    <Card title="Receipt confirmation">
      <dl className="details">
        <dt>Item received</dt>
        <dd>
          <YesNo value={d.item_received} />
          {!d.item_received && d.received_quantity > 0 && (
            <span className="muted">
              {' '}
              Partially received: {d.received_quantity} of {d.quantity}
            </span>
          )}
        </dd>
        <dt>Received on</dt>
        <dd>{dateTime(d.received_at)}</dd>
        <dt>Confirmed by</dt>
        <dd>{d.received_by_name ?? '—'}</dd>
        {d.item_received && d.quantity > 1 && (
          <>
            <dt>Units received</dt>
            <dd>
              {d.received_quantity ?? d.quantity} of {d.quantity}
            </dd>
          </>
        )}
      </dl>
    </Card>
  );
}

// ---------------------------------------------------------------------------
function ThankYouCard({ detail, onChanged, reload }: { detail: Detail; onChanged: (d: Detail) => void; reload: () => void }) {
  const d = detail.donation;
  const p = detail.permissions;
  const toast = useToast();
  const [draft, setDraft] = useState<Row | null>(null);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [confirm, setConfirm] = useState<null | { messageId: number | null; method: string }>(null);
  const [sendEmail, setSendEmail] = useState<Row | null>(null);
  const [sentOn, setSentOn] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const drafts = (detail.thankYouMessages ?? []).filter((m) => m.status === 'draft' || m.status === 'failed');

  const newDraft = async () => {
    setError(null);
    try {
      const t = await api.get<{ recipient: string | null; subject: string; body: string; emailConfigured: boolean }>(`/api/donations/${d.id}/thank-you/template`);
      setEmailConfigured(t.emailConfigured);
      setDraft({ method: 'email', recipient: t.recipient ?? '', subject: t.subject, body: t.body });
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    if (p.thankYou && !d.is_archived) api.get<{ emailConfigured: boolean }>(`/api/donations/${d.id}/thank-you/template`).then((t) => setEmailConfigured(t.emailConfigured)).catch(() => undefined);
  }, [d.id, p.thankYou, d.is_archived]);

  const saveDraft = async () => {
    setBusy(true);
    try {
      if (draft!.id) await api.put(`/api/donations/${d.id}/thank-you/drafts/${draft!.id}`, draft);
      else await api.post(`/api/donations/${d.id}/thank-you/drafts`, draft);
      toast('Draft saved — it is NOT marked as sent');
      setDraft(null);
      reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const confirmSent = async () => {
    setBusy(true);
    try {
      onChanged(await api.post<Detail>(`/api/donations/${d.id}/thank-you/confirm-sent`, { method: confirm!.method, message_id: confirm!.messageId, sent_on: sentOn, notes, confirm: true }));
      toast('Thank-you recorded as sent');
      setConfirm(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const doSendEmail = async () => {
    setBusy(true);
    try {
      onChanged(await api.post<Detail>(`/api/donations/${d.id}/thank-you/drafts/${sendEmail!.id}/send-email`, { confirm: true }));
      toast('Thank-you email sent');
      setSendEmail(null);
    } catch (e) {
      setError(e);
      setSendEmail(null);
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Thank-you" id="thank-you">
      <dl className="details">
        <dt>ThankYouStatus</dt>
        <dd>
          <YesNo value={d.thank_you_sent} /> <span className="muted small">{THANK_YOU_STAGE_LABELS[d.thank_you_stage]}</span>
        </dd>
        <dt>Required</dt>
        <dd>{d.thank_you_required ? 'Yes' : 'No'}</dd>
        {d.thank_you_sent && (
          <>
            <dt>Sent</dt>
            <dd>
              {date(d.thank_you_sent_at)} by {d.thank_you_sent_by_name} ({METHOD_LABELS[d.thank_you_method] ?? d.thank_you_method})
            </dd>
            {d.thank_you_notes && (
              <>
                <dt>Notes</dt>
                <dd>{d.thank_you_notes}</dd>
              </>
            )}
          </>
        )}
      </dl>
      <ErrorAlert error={error} />
      {p.thankYou && !d.thank_you_sent && !d.is_archived && (
        <div className="stack" style={{ marginTop: '1rem' }}>
          {drafts.map((m) => (
            <div key={m.id} className="card stack-sm" style={{ background: '#fafafa' }}>
              <div className="row between">
                <strong>
                  Draft ({METHOD_LABELS[m.method]}) {m.status === 'failed' && <Badge tone="red">Send failed</Badge>}
                </strong>
                <span className="muted small">
                  Prepared {dateTime(m.created_at)} by {m.created_by_name}
                </span>
              </div>
              {m.recipient && <div className="small">To: {m.recipient}</div>}
              {m.subject && <div className="small">Subject: {m.subject}</div>}
              <div className="note small">{m.body}</div>
              <div className="button-row">
                <button className="btn btn-secondary btn-sm" onClick={() => setDraft({ ...m })}>
                  Edit draft
                </button>
                {m.method === 'email' && emailConfigured && m.status === 'draft' && (
                  <button className="btn btn-primary btn-sm" onClick={() => setSendEmail(m)}>
                    Send email…
                  </button>
                )}
                <button className="btn btn-success btn-sm" onClick={() => setConfirm({ messageId: m.id, method: m.method })}>
                  I sent this — confirm sent
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => api.post(`/api/donations/${d.id}/thank-you/drafts/${m.id}/discard`).then(reload)}>
                  Discard
                </button>
              </div>
            </div>
          ))}
          {!emailConfigured && <p className="muted small">Email sending is not configured, so send thank-yous yourself and then confirm them here.</p>}
          <div className="button-row">
            <button className="btn btn-secondary" onClick={newDraft}>
              ✎ Prepare thank-you draft
            </button>
            <button className="btn btn-secondary" onClick={() => setConfirm({ messageId: null, method: 'email' })}>
              Record a thank-you already sent
            </button>
            {d.thank_you_required && (
              <button className="btn btn-link" onClick={() => api.post<Detail>(`/api/donations/${d.id}/thank-you/not-required`).then(onChanged)}>
                Thank-you not required
              </button>
            )}
          </div>
        </div>
      )}
      {detail.thankYouMessages && detail.thankYouMessages.some((m) => m.status === 'sent') && (
        <details style={{ marginTop: '0.75rem' }}>
          <summary>Thank-you history</summary>
          <ul className="timeline">
            {detail.thankYouMessages
              .filter((m) => m.status === 'sent')
              .map((m) => (
                <li key={m.id}>
                  {METHOD_LABELS[m.method]} sent {dateTime(m.sent_at)} by {m.sent_by_name}
                  {m.subject && <div className="small muted">{m.subject}</div>}
                </li>
              ))}
          </ul>
        </details>
      )}

      <Modal open={Boolean(draft)} title={draft?.id ? 'Edit thank-you draft' : 'Prepare thank-you draft'} onClose={() => setDraft(null)} wide>
        {draft && (
          <div className="stack">
            <Alert kind="info">Saving a draft does not mark the thank-you as sent.</Alert>
            <div className="grid-2">
              <Field id="ty-method" label="Method">
                <select id="ty-method" value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value })}>
                  {Object.entries(METHOD_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              {p.contacts && (
                <Field id="ty-to" label="Recipient">
                  <input id="ty-to" type="text" value={draft.recipient ?? ''} onChange={(e) => setDraft({ ...draft, recipient: e.target.value })} />
                </Field>
              )}
            </div>
            <Field id="ty-subject" label="Subject">
              <input id="ty-subject" type="text" value={draft.subject ?? ''} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
            </Field>
            <Field id="ty-body" label="Message">
              <textarea id="ty-body" value={draft.body ?? ''} onChange={(e) => setDraft({ ...draft, body: e.target.value })} style={{ minHeight: 220 }} />
            </Field>
            <div className="button-row">
              <button className="btn btn-primary" disabled={busy} onClick={saveDraft}>
                Save draft
              </button>
              <button className="btn btn-secondary" onClick={() => navigator.clipboard?.writeText(draft.body ?? '').then(() => toast('Message copied'))}>
                Copy message
              </button>
              <button className="btn btn-secondary" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title="Confirm the thank-you was sent"
        confirmLabel="Yes, it was sent"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={confirmSent}
        message="Only confirm once the message has actually been sent to the donor."
      >
        {confirm && (
          <div className="grid-2">
            <Field id="cs-method" label="Method">
              <select id="cs-method" value={confirm.method} onChange={(e) => setConfirm({ ...confirm, method: e.target.value })}>
                {Object.entries(METHOD_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="cs-date" label="Date sent">
              <input id="cs-date" type="date" max={todayISO()} value={sentOn} onChange={(e) => setSentOn(e.target.value)} />
            </Field>
            <div className="span-2" style={{ gridColumn: '1 / -1' }}>
              <Field id="cs-notes" label="Notes (optional)">
                <input id="cs-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </div>
          </div>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={Boolean(sendEmail)}
        title="Send this thank-you email?"
        confirmLabel="Send email now"
        busy={busy}
        onCancel={() => setSendEmail(null)}
        onConfirm={doSendEmail}
        message={sendEmail ? `The email "${sendEmail.subject}" will be sent to ${sendEmail.recipient}. It will be marked as sent only if delivery to the mail server succeeds.` : ''}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
function PublicationCard({ detail, onChanged }: { detail: Detail; onChanged: (d: Detail) => void }) {
  const d = detail.donation;
  const p = detail.permissions;
  const toast = useToast();
  const canEdit = (p.publish || (p.editAll && d.publication_status !== 'published')) && !d.is_archived;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Row>({});
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentSource, setConsentSource] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [upload, setUpload] = useState<File | null>(null);
  const [alt, setAlt] = useState('');

  const start = () => {
    setForm({
      public_title: d.public_title ?? '',
      public_description: d.public_description ?? d.description,
      show_donor_name: d.show_donor_name,
      show_website: d.show_website,
      show_value: d.show_value,
      show_quantity: d.show_quantity,
    });
    setEditing(true);
  };
  const save = async () => {
    try {
      onChanged(await api.put<Detail>(`/api/donations/${d.id}/public-content`, form));
      toast('Public content saved');
      setEditing(false);
    } catch (e) {
      setError(e);
    }
  };
  const media = async (mid: string, body: Row) => {
    try {
      await api.patch(`/api/donations/${d.id}/media/${mid}`, body);
      onChanged(await api.get<Detail>(`/api/donations/${d.id}`));
    } catch (e) {
      setError(e);
    }
  };
  const doUpload = async () => {
    if (!upload) return;
    const fd = new FormData();
    fd.set('image', upload);
    fd.set('alt_text', alt);
    try {
      await api.post(`/api/donations/${d.id}/media`, fd);
      setUpload(null);
      setAlt('');
      onChanged(await api.get<Detail>(`/api/donations/${d.id}`));
      toast('Image uploaded (private until marked public)');
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Card title="Publication settings" actions={canEdit && !editing ? <button className="btn btn-secondary btn-sm" onClick={start}>Edit public content</button> : null}>
      <ErrorAlert error={error} />
      {!editing ? (
        <dl className="details">
          <dt>Publication status</dt>
          <dd>
            <PublicationBadge status={d.publication_status} />
            {d.published_at && d.publication_status === 'published' && <div className="muted small">Published {dateTime(d.published_at)} by {d.published_by_name}</div>}
          </dd>
          <dt>Public consent</dt>
          <dd>
            <YesNo value={d.public_consent} /> {d.public_consent_source && <span className="muted small">{d.public_consent_source}</span>}
            {p.publish && (
              <div>
                <button className="btn-link small" onClick={() => setConsentOpen(true)}>
                  {d.public_consent ? 'Withdraw consent' : 'Record consent'}
                </button>
              </div>
            )}
          </dd>
          <dt>Public title</dt>
          <dd>{d.public_title || '—'}</dd>
          <dt>Public description</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{d.public_description || <span className="muted">Not written yet</span>}</dd>
          <dt>Shown publicly</dt>
          <dd>
            {[d.show_donor_name && 'Donor name', d.show_donor_name && d.show_website && 'Website', d.show_value && 'Estimated value', d.show_quantity && 'Quantity'].filter(Boolean).join(', ') || 'Description only'}
          </dd>
        </dl>
      ) : (
        <div className="stack">
          <Field id="pub-title" label="Public title">
            <input id="pub-title" type="text" maxLength={200} value={form.public_title} onChange={(e) => setForm({ ...form, public_title: e.target.value })} />
          </Field>
          <Field id="pub-desc" label="Public description" hint="Reviewed text shown on the public gallery. Do not include private details.">
            <textarea id="pub-desc" maxLength={3000} value={form.public_description} onChange={(e) => setForm({ ...form, public_description: e.target.value })} />
          </Field>
          {(
            [
              ['show_donor_name', 'Show donor / business name (requires consent)'],
              ['show_website', 'Show donor website link'],
              ['show_value', 'Show estimated value'],
              ['show_quantity', 'Show quantity'],
            ] as const
          ).map(([k, l]) => (
            <label className="checkbox" key={k}>
              <input type="checkbox" checked={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} />
              <span>{l}</span>
            </label>
          ))}
          <div className="button-row">
            <button className="btn btn-primary" onClick={save}>
              Save public content
            </button>
            <button className="btn btn-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <h3 style={{ marginTop: '1rem' }}>Images</h3>
      {detail.media.length === 0 ? (
        <p className="muted small">No images.</p>
      ) : (
        <div className="thumbs">
          {detail.media.map((m) => (
            <div className="thumb" key={m.id}>
              <img src={`/api/media/${m.id}`} alt={m.alt_text ?? ''} />
              <div>
                {m.is_public ? <Badge tone="green">Public</Badge> : <Badge tone="gray">Private</Badge>}
                {p.publish && (
                  <div>
                    <button className="btn-link small" onClick={() => media(m.id, { is_public: !m.is_public })}>
                      {m.is_public ? 'Make private' : 'Approve for public'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {p.editAssigned && !d.is_archived && (
        <div className="row" style={{ marginTop: '0.75rem', alignItems: 'flex-end' }}>
          <Field id="up-file" label="Add image">
            <input id="up-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(e) => setUpload(e.target.files?.[0] ?? null)} />
          </Field>
          {upload && (
            <>
              <Field id="up-alt" label="Image description">
                <input id="up-alt" type="text" value={alt} onChange={(e) => setAlt(e.target.value)} />
              </Field>
              <button className="btn btn-secondary" onClick={doUpload}>
                Upload
              </button>
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={consentOpen}
        title={d.public_consent ? 'Withdraw public recognition consent?' : 'Record public recognition consent'}
        confirmLabel={d.public_consent ? 'Withdraw consent' : 'Record consent'}
        danger={d.public_consent}
        onCancel={() => setConsentOpen(false)}
        onConfirm={async () => {
          try {
            onChanged(await api.post<Detail>(`/api/donations/${d.id}/consent`, { public_consent: !d.public_consent, source: consentSource || null }));
            setConsentOpen(false);
            setConsentSource('');
          } catch (e) {
            setError(e);
            setConsentOpen(false);
          }
        }}
        message={d.public_consent ? 'If the donation is published it will be removed from the gallery immediately.' : 'Only record consent the donor has actually given (for example by email or phone).'}
      >
        <Field id="consent-src" label="How was this given / why? (recorded in history)">
          <input id="consent-src" type="text" value={consentSource} onChange={(e) => setConsentSource(e.target.value)} placeholder="e.g. Donor confirmed by email on Nov 3" />
        </Field>
      </ConfirmDialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
function DonorCard({ d, contacts }: { d: Row; contacts: boolean }) {
  return (
    <Card title="Donor details">
      <dl className="details">
        <dt>DonorID</dt>
        <dd>
          <Link to={`/app/donors/${d.donor_id}`}>#{d.donor_id}</Link>
        </dd>
        <dt>Business / Donor / Org</dt>
        <dd>
          <Link to={`/app/donors/${d.donor_id}`}>{d.donor_name}</Link>
        </dd>
        {contacts ? (
          <>
            <dt>Contact name</dt>
            <dd>{d.contact_name || '—'}</dd>
            <dt>Contact email</dt>
            <dd>{d.contact_email ? <a href={`mailto:${d.contact_email}`}>{d.contact_email}</a> : '—'}</dd>
            <dt>Contact phone</dt>
            <dd>{d.contact_phone ? <a href={`tel:${d.contact_phone}`}>{d.contact_phone}</a> : '—'}</dd>
            <dt>Social media</dt>
            <dd>{(d.donor_social_media ?? []).map((s: Row) => s.handle).join(', ') || '—'}</dd>
          </>
        ) : (
          <>
            <dt>Contact</dt>
            <dd className="muted">Restricted — ask an administrator if you need contact details.</dd>
          </>
        )}
        <dt>Website</dt>
        <dd>
          {d.donor_website ? (
            <a href={d.donor_website} target="_blank" rel="noopener noreferrer">
              {d.donor_website}
            </a>
          ) : (
            '—'
          )}
        </dd>
      </dl>
    </Card>
  );
}

function AssignmentCard({ detail, onSaved }: { detail: Detail; onSaved: (d: Detail) => void }) {
  const d = detail.donation;
  const p = detail.permissions;
  const { data: users } = useUserOptions();
  const toast = useToast();
  const [shareUser, setShareUser] = useState<number | ''>('');
  const [error, setError] = useState<unknown>(null);
  const assign = async (v: string) => {
    try {
      onSaved(await api.patch<Detail>(`/api/donations/${d.id}`, { assigned_to: v ? Number(v) : null }));
      toast('Assignment updated');
    } catch (e) {
      setError(e);
    }
  };
  const share = async () => {
    try {
      await api.post(`/api/donations/${d.id}/shares`, { user_id: shareUser });
      onSaved(await api.get<Detail>(`/api/donations/${d.id}`));
      setShareUser('');
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Card title="Event, assignment & follow-up">
      <ErrorAlert error={error} />
      <dl className="details">
        <dt>EventID</dt>
        <dd>
          #{d.event_id} · {d.event_name}
        </dd>
        <dt>Assigned to</dt>
        <dd>
          {p.assign && !d.is_archived ? (
            <select aria-label="Assigned to" value={d.assigned_to ?? ''} onChange={(e) => assign(e.target.value)}>
              <option value="">Unassigned</option>
              {(users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          ) : (
            (d.assigned_to_name ?? 'Unassigned')
          )}
        </dd>
        <dt>Next follow-up</dt>
        <dd>
          {date(d.next_follow_up_date)} {d.follow_up_overdue && <Badge tone="red">Overdue</Badge>}
          {d.follow_up_due_today && <Badge tone="amber">Today</Badge>}
        </dd>
      </dl>
      {detail.shares && (
        <div style={{ marginTop: '0.75rem' }}>
          <h3>Shared with</h3>
          {detail.shares.length === 0 ? (
            <p className="muted small">Not shared with anyone else.</p>
          ) : (
            <ul>
              {detail.shares.map((s) => (
                <li key={s.user_id}>
                  {s.name}{' '}
                  <button className="btn-link small" onClick={() => api.del(`/api/donations/${d.id}/shares/${s.user_id}`).then(() => api.get<Detail>(`/api/donations/${d.id}`).then(onSaved))}>
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="row">
            <select aria-label="Share with user" value={shareUser} onChange={(e) => setShareUser(e.target.value ? Number(e.target.value) : '')} style={{ flex: 1 }}>
              <option value="">Share with…</option>
              {(users ?? [])
                .filter((u) => u.id !== d.assigned_to && !detail.shares!.some((s) => s.user_id === u.id))
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
            <button className="btn btn-secondary btn-sm" disabled={!shareUser} onClick={share}>
              Share
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

function NotesCard({ detail, reload }: { detail: Detail; reload: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  if (!detail.notes) return null;
  const add = async () => {
    try {
      await api.post(`/api/donations/${detail.donation.id}/notes`, { text });
      setText('');
      toast('Note added');
      reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Card title="Internal notes" privateTag>
      <ErrorAlert error={error} />
      {!detail.donation.is_archived && (
        <div className="stack-sm">
          <label htmlFor="new-note" className="visually-hidden">
            New note
          </label>
          <textarea id="new-note" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add an internal note (never shown publicly)" style={{ minHeight: 70 }} />
          <button className="btn btn-secondary btn-sm" disabled={!text.trim()} onClick={add}>
            Add note
          </button>
        </div>
      )}
      <ul className="timeline">
        {detail.notes.map((n) => (
          <li key={n.id}>
            <div className="note">{n.note_text}</div>
            <div className="muted small">
              {n.author_name ?? 'Unknown'} · {dateTime(n.created_at)}
            </div>
          </li>
        ))}
        {detail.notes.length === 0 && <li className="muted small">No notes yet.</li>}
      </ul>
    </Card>
  );
}

function HistoryCard({ detail }: { detail: Detail }) {
  const { can } = useAuth();
  return (
    <Card title="History">
      <h3>Status history</h3>
      <ul className="timeline">
        {detail.statusHistory.map((h) => (
          <li key={h.id}>
            {h.from_status ? `${h.from_status.replace(/_/g, ' ')} → ` : ''}
            <strong>{h.to_status.replace(/_/g, ' ')}</strong>
            {h.comment && <> — {h.comment}</>}
            <div className="muted small">
              {dateTime(h.changed_at)} · {h.changed_by_name ?? 'System'}
            </div>
          </li>
        ))}
      </ul>
      {detail.audit && (
        <details>
          <summary>Audit trail ({detail.audit.length})</summary>
          <ul className="timeline">
            {detail.audit.map((a) => (
              <li key={a.id}>
                {a.summary ?? a.action}
                <div className="muted small">
                  {dateTime(a.created_at)} · {a.user_name ?? 'Public / system'}
                </div>
              </li>
            ))}
          </ul>
          {can('audit.view') && <Link to={`/app/audit?record_type=donation&record_id=${detail.donation.id}`}>Open in audit log</Link>}
        </details>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function ReceiveDialog({ d, busy, onClose, onSubmit }: { d: Row; busy: boolean; onClose: () => void; onSubmit: (b: Row) => void }) {
  const [qty, setQty] = useState(String(d.quantity));
  const [note, setNote] = useState('');
  return (
    <ConfirmDialog
      open
      title="Mark item received"
      confirmLabel="Confirm receipt"
      busy={busy}
      onCancel={onClose}
      onConfirm={() => onSubmit({ received: true, received_quantity: Number(qty), note: note || null })}
      message="Your name and the current time will be recorded as confirming receipt."
    >
      {d.quantity > 1 && (
        <Field id="rq" label={`Units received (of ${d.quantity})`} hint="Record a partial delivery by entering fewer units.">
          <input id="rq" type="number" min={1} max={d.quantity} value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
      )}
      <Field id="rn" label="Note (optional)">
        <input id="rn" type="text" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}

function PickupDialog({ d, busy, onClose, onSubmit }: { d: Row; busy: boolean; onClose: () => void; onSubmit: (b: Row) => void }) {
  const { canAny, user } = useAuth();
  const { data: users } = useUserOptions();
  const [when, setWhen] = useState(d.pickup_scheduled_for ? toLocalInput(d.pickup_scheduled_for) : '');
  const [address, setAddress] = useState(d.pickup_address ?? '');
  const [instr, setInstr] = useState(d.pickup_instructions ?? '');
  const [who, setWho] = useState<number | ''>(d.assigned_to ?? user?.id ?? '');
  return (
    <ConfirmDialog
      open
      title="Schedule pickup"
      confirmLabel="Schedule pickup"
      busy={busy}
      onCancel={onClose}
      onConfirm={() => when && onSubmit({ pickup_scheduled_for: new Date(when).toISOString(), pickup_address: address || null, pickup_instructions: instr || null, assign_task_to: who || null })}
      message="A pickup task will be added to the responsible person's To Do list."
    >
      <Field id="pw" label="Pickup date and time" required>
        <input id="pw" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </Field>
      <Field id="pa" label="Pickup address">
        <textarea id="pa" value={address} onChange={(e) => setAddress(e.target.value)} style={{ minHeight: 60 }} />
      </Field>
      <Field id="pi" label="Instructions">
        <textarea id="pi" value={instr} onChange={(e) => setInstr(e.target.value)} style={{ minHeight: 60 }} />
      </Field>
      {canAny('tasks.manage', 'donations.assign') && (
        <Field id="pwho" label="Who will pick it up?">
          <select id="pwho" value={who} onChange={(e) => setWho(e.target.value ? Number(e.target.value) : '')}>
            {(users ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
      )}
    </ConfirmDialog>
  );
}

function FollowUpDialog({ d, busy, onClose, onSubmit }: { d: Row; busy: boolean; onClose: () => void; onSubmit: (date: string | null) => void }) {
  const [value, setValue] = useState(d.next_follow_up_date ?? '');
  return (
    <Modal open title="Next follow-up date" onClose={onClose}>
      <div className="stack">
        <p className="muted">
          A follow-up task is created on {d.assigned_to_name ? `${d.assigned_to_name}'s` : 'your'} To Do list. Changing the date updates that task — it does not create a new one.
        </p>
        <Field id="fu" label="Follow up on">
          <input id="fu" type="date" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <div className="button-row">
          <button className="btn btn-primary" disabled={busy || !value} onClick={() => onSubmit(value)}>
            Save follow-up
          </button>
          {d.next_follow_up_date && (
            <button className="btn btn-secondary" disabled={busy} onClick={() => onSubmit(null)}>
              Clear (no longer required)
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
