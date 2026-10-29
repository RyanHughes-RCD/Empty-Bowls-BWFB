import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EventSelect } from '../components/EventSelect';
import { EmptyState, ErrorAlert, PageHeader, Pagination, Spinner, SubmissionBadge } from '../components/ui';
import { qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEvents } from '../lib/data';
import { categoryText, dateTime, money } from '../lib/format';
import { useApi } from '../lib/useApi';

interface SubmissionRow {
  id: number;
  reference: string;
  source: string;
  status: string;
  submitted_at: string;
  event_name: string;
  submitted_by_name: string | null;
  donation_id: number | null;
  public_consent: boolean;
  submission_data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  reviewed_data: Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  contact_hidden?: boolean;
}

const TABS = [
  ['open', 'Needs review'],
  ['pending_review', 'Pending review'],
  ['awaiting_donor_info', 'Awaiting donor info'],
  ['approved', 'Approved'],
  ['declined', 'Declined'],
  ['all', 'All'],
];

export default function Approvals() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const mine = params.get('mine') === 'true' || !can('submissions.review');
  const status = params.get('status') ?? (mine ? 'all' : 'open');
  const eventId = params.get('event_id') ?? '';
  const page = Number(params.get('page') ?? 1);
  const [q, setQ] = useState(params.get('q') ?? '');
  const { data: events } = useEvents();
  const { data, error, loading } = useApi<{ rows: SubmissionRow[]; total: number; page: number; pageSize: number }>(
    `/api/submissions${qs({ status: status === 'all' ? '' : status, event_id: eventId, q: params.get('q'), mine: mine ? 'true' : '', page })}`,
  );
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== 'page') n.delete('page');
    setParams(n, { replace: true });
  };
  useEffect(() => {
    const t = setTimeout(() => (params.get('q') ?? '') !== q && set('q', q), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="stack">
      <PageHeader
        title={mine ? 'My Submissions' : 'Donation Approvals'}
        subtitle={mine ? 'Donations you submitted for approval.' : 'Review new donation submissions. Nothing here is public until it is approved and separately published.'}
        actions={
          can('submissions.create') ? (
            <Link className="btn btn-primary" to="/app/donations/new">
              + Submit a donation
            </Link>
          ) : null
        }
      />
      <div className="tabs" role="tablist" aria-label="Submission status">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" className="tab" aria-selected={status === k} onClick={() => set('status', k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="filters" role="search">
        <div className="field" style={{ flex: '2 1 220px' }}>
          <label htmlFor="s-q">Search</label>
          <input id="s-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Reference, donor or description" />
        </div>
        {events && <EventSelect id="s-event" events={events} value={eventId ? Number(eventId) : ''} onChange={(v) => set('event_id', String(v))} allowAll />}
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? (
        <Spinner />
      ) : !data?.rows.length ? (
        <EmptyState title={status === 'open' ? 'No submissions waiting for review' : 'No submissions found'} icon="📥" />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Donor / Org</th>
                  <th>Contact</th>
                  <th>Category</th>
                  <th>Description</th>
                  <th>Qty</th>
                  <th>Est. value</th>
                  <th>Event</th>
                  <th>Submitted</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((s) => {
                  const d = s.reviewed_data ?? s.submission_data;
                  return (
                    <tr key={s.id}>
                      <td className="nowrap">
                        <Link to={`/app/approvals/${s.id}`}>{s.reference}</Link>
                        {s.source === 'internal' && <div className="muted small">by {s.submitted_by_name}</div>}
                      </td>
                      <td>{d.donor_name}</td>
                      <td>
                        {s.contact_hidden ? (
                          <span className="muted small">Restricted</span>
                        ) : (
                          <>
                            {d.contact_name}
                            <div className="small">{d.contact_email}</div>
                            <div className="small">{d.contact_phone}</div>
                          </>
                        )}
                      </td>
                      <td>{d.category ? categoryText(d.category, d.subcategory) : '—'}</td>
                      <td className="cell-desc">
                        <span className="clamp">{d.description}</span>
                      </td>
                      <td>{d.quantity}</td>
                      <td>{money(d.estimated_value_cad)}</td>
                      <td>{s.event_name}</td>
                      <td className="nowrap">{dateTime(s.submitted_at)}</td>
                      <td>
                        <SubmissionBadge status={s.status} />
                        {s.donation_id && (
                          <div className="small">
                            <Link to={`/app/donations/${s.donation_id}`}>Donation #{s.donation_id}</Link>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={(p) => set('page', String(p))} />
        </>
      )}
    </div>
  );
}
