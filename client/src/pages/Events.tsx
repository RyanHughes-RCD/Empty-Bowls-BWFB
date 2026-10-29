import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, ConfirmDialog, EmptyState, ErrorAlert, Field, Modal, PageHeader, Spinner, fieldErrors, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type EventRow, useEvents } from '../lib/data';
import { EVENT_STATUS_LABELS, date, money } from '../lib/format';

export default function Events() {
  const { can } = useAuth();
  const { data, error, loading, reload } = useEvents();
  const [editing, setEditing] = useState<Partial<EventRow> | null>(null);
  const [closing, setClosing] = useState<EventRow | null>(null);
  const toast = useToast();
  const manage = can('events.manage');
  const origin = window.location.origin;

  return (
    <div className="stack">
      <PageHeader
        title="Event Management"
        subtitle="Each auction is a separate event. Closed events keep all their records and reports."
        actions={
          manage ? (
            <button className="btn btn-primary" onClick={() => setEditing({ status: 'planning', accepting_submissions: false, gallery_enabled: true })}>
              + New event
            </button>
          ) : null
        }
      />
      <ErrorAlert error={error} />
      {loading && !data ? (
        <Spinner />
      ) : !data?.length ? (
        <EmptyState title="No events yet" icon="📅" />
      ) : (
        <div className="stack">
          {data.map((e) => (
            <section key={e.id} className="card">
              <div className="card-header">
                <div>
                  <h2>{e.name}</h2>
                  <div className="muted small">
                    EventID #{e.id} · code <code>{e.code}</code> · {date(e.event_date)} {e.location && `· ${e.location}`}
                  </div>
                </div>
                <div className="row">
                  <Badge tone={e.status === 'active' ? 'green' : e.status === 'closed' ? 'gray' : e.status === 'archived' ? 'red' : 'blue'}>{EVENT_STATUS_LABELS[e.status]}</Badge>
                  {e.accepting_submissions ? <Badge tone="green">Accepting submissions</Badge> : <Badge tone="gray">Submissions closed</Badge>}
                  {!e.gallery_enabled && <Badge tone="amber">Gallery hidden</Badge>}
                </div>
              </div>
              {e.description && <p>{e.description}</p>}
              {e.donation_count !== null && e.donation_count !== undefined && (
                <p>
                  <strong>{e.donation_count}</strong> donations · <strong>{money(e.approved_value)}</strong> approved estimated value · <strong>{e.pending_submissions}</strong> awaiting review
                </p>
              )}
              <div className="button-row">
                <Link className="btn btn-secondary btn-sm" to={`/app/donations?event_id=${e.id}`}>
                  View donations
                </Link>
                <Link className="btn btn-secondary btn-sm" to={`/app/donations?event_id=${e.id}&view=awaiting_pickup`}>
                  Outstanding pickups
                </Link>
                <Link className="btn btn-secondary btn-sm" to={`/app/donations?event_id=${e.id}&thank_you=outstanding`}>
                  Outstanding thank-yous
                </Link>
                {can('reports.view') && (
                  <Link className="btn btn-secondary btn-sm" to={`/app/reports?event_id=${e.id}`}>
                    Report
                  </Link>
                )}
                <a className="btn btn-secondary btn-sm" href={`/gallery?event=${e.code}`} target="_blank" rel="noreferrer">
                  Public gallery ↗
                </a>
                {manage && (
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditing(e)}>
                    Edit
                  </button>
                )}
                {manage && e.status === 'active' && (
                  <button className="btn btn-secondary btn-sm" onClick={() => setClosing(e)}>
                    Close event
                  </button>
                )}
              </div>
              {e.accepting_submissions && (
                <p className="small muted" style={{ marginTop: '0.75rem' }}>
                  Donation form link for this event: <code>{`${origin}/submit?event=${e.code}`}</code>
                </p>
              )}
            </section>
          ))}
        </div>
      )}
      {editing && <EventDialog event={editing} onClose={() => setEditing(null)} onSaved={reload} />}
      <ConfirmDialog
        open={Boolean(closing)}
        title={`Close ${closing?.name}?`}
        confirmLabel="Close event"
        onCancel={() => setClosing(null)}
        onConfirm={async () => {
          await api.patch(`/api/events/${closing!.id}`, { status: 'closed', accepting_submissions: false });
          toast('Event closed');
          setClosing(null);
          reload();
        }}
        message="The event will stop accepting submissions. All donations, tasks and reports are kept and remain accessible."
      />
    </div>
  );
}

function EventDialog({ event, onClose, onSaved }: { event: Partial<EventRow>; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    code: event.code ?? '',
    name: event.name ?? '',
    event_date: event.event_date ?? '',
    location: event.location ?? '',
    description: event.description ?? '',
    status: event.status ?? 'planning',
    accepting_submissions: event.accepting_submissions ?? false,
    gallery_enabled: event.gallery_enabled ?? true,
  });
  const [error, setError] = useState<unknown>(null);
  const errs = fieldErrors(error);
  const save = async () => {
    try {
      const body = { ...f, event_date: f.event_date || null };
      if (event.id) await api.patch(`/api/events/${event.id}`, body);
      else await api.post('/api/events', body);
      toast(event.id ? 'Event updated' : 'Event created');
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
    }
  };
  const closed = ['closed', 'archived'].includes(f.status);
  return (
    <Modal open title={event.id ? 'Edit event' : 'New event'} onClose={onClose} wide>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <Field id="ev-name" label="Event name" required error={errs.name}>
            <input
              id="ev-name"
              type="text"
              value={f.name}
              onChange={(e) =>
                setF({
                  ...f,
                  name: e.target.value,
                  code: event.id ? f.code : e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60),
                })
              }
            />
          </Field>
          <Field id="ev-code" label="Event code (used in links)" required error={errs.code} hint="e.g. empty-bowls-2026">
            <input id="ev-code" type="text" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
          </Field>
          <Field id="ev-date" label="Event date" error={errs.event_date}>
            <input id="ev-date" type="date" value={f.event_date} onChange={(e) => setF({ ...f, event_date: e.target.value })} />
          </Field>
          <Field id="ev-loc" label="Location" error={errs.location}>
            <input id="ev-loc" type="text" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
          </Field>
          <div className="span-2">
            <Field id="ev-desc" label="Description" error={errs.description}>
              <textarea id="ev-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            </Field>
          </div>
          <Field id="ev-status" label="Status">
            <select id="ev-status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, accepting_submissions: ['closed', 'archived'].includes(e.target.value) ? false : f.accepting_submissions })}>
              {Object.entries(EVENT_STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <div className="stack-sm">
            <label className="checkbox">
              <input type="checkbox" disabled={closed} checked={f.accepting_submissions} onChange={(e) => setF({ ...f, accepting_submissions: e.target.checked })} />
              <span>Accepting public donation submissions</span>
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={f.gallery_enabled} onChange={(e) => setF({ ...f, gallery_enabled: e.target.checked })} />
              <span>Show published donations in the public gallery</span>
            </label>
          </div>
        </div>
        <p className="muted small">The public gallery only shows events that are Active or Closed.</p>
        <div className="button-row">
          <button className="btn btn-primary" onClick={save}>
            Save event
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
