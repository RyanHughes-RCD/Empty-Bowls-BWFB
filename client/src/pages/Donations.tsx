import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EventSelect } from '../components/EventSelect';
import { EmptyState, ErrorAlert, PageHeader, Pagination, PublicationBadge, Spinner, StatusBadge, YesNo } from '../components/ui';
import { qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEvents, useStatuses, useUserOptions } from '../lib/data';
import { CATEGORIES, CATEGORY_LABELS, PUBLICATION_LABELS, SUBCATEGORIES, SUBCATEGORY_LABELS, THANK_YOU_STAGE_LABELS, date, money } from '../lib/format';
import { useApi } from '../lib/useApi';

export interface DonationRow {
  id: number;
  event_id: number;
  event_name: string;
  donor_id: number;
  donor_name: string;
  contact_name: string | null;
  category: string;
  subcategory: string | null;
  description: string;
  quantity: number;
  estimated_value_cad: number | null;
  status: string;
  status_label: string;
  publication_status: string;
  assigned_to_name: string | null;
  next_follow_up_date: string | null;
  follow_up_overdue: boolean;
  item_received: boolean;
  thank_you_sent: boolean;
  thank_you_stage: string;
  delivery_method: string;
  pickup_scheduled_for: string | null;
  contact_hidden?: boolean;
}

const FILTER_KEYS = ['event_id', 'q', 'category', 'subcategory', 'status', 'publication_status', 'assigned_to', 'follow_up', 'follow_up_from', 'follow_up_to', 'item_received', 'thank_you', 'view', 'archived', 'sort', 'dir'];

const PRESETS: Record<string, { title: string; subtitle: string; filters: Record<string, string> }> = {
  published: { title: 'Published Donations', subtitle: 'Donations currently visible on the public gallery.', filters: { publication_status: 'published' } },
  pickup: { title: 'Pickup Tracking', subtitle: 'Approved donations that still need to be picked up or received.', filters: { view: 'awaiting_pickup', sort: 'follow_up', dir: 'asc' } },
  thankyou: { title: 'Thank-You Tracking', subtitle: 'Donations that still need a thank-you. Items already received are ready to thank.', filters: { thank_you: 'outstanding' } },
};

export default function Donations() {
  const { can, canAny } = useAuth();
  const [params, setParams] = useSearchParams();
  const preset = PRESETS[params.get('preset') ?? ''];
  const { data: events } = useEvents();
  const { data: statuses } = useStatuses();
  const { data: users } = useUserOptions();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [filtersOpen, setFiltersOpen] = useState(false);

  const filters: Record<string, string> = { ...(preset?.filters ?? {}) };
  for (const k of FILTER_KEYS) if (params.get(k)) filters[k] = params.get(k)!;
  const page = Number(params.get('page') ?? 1);
  const url = `/api/donations${qs({ ...filters, page, page_size: 25 })}`;
  const { data, error, loading } = useApi<{ rows: DonationRow[]; total: number; total_value: number; page: number; pageSize: number }>(url);

  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get('q') ?? '') !== q) update('q', q);
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function update(k: string, v: string) {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k === 'category' && v !== 'food') next.delete('subcategory');
    if (k !== 'page') next.delete('page');
    setParams(next, { replace: true });
  }
  const sortBy = (key: string) => {
    const next = new URLSearchParams(params);
    const same = (filters.sort ?? 'created_at') === key;
    next.set('sort', key);
    next.set('dir', same && (filters.dir ?? 'desc') === 'desc' ? 'asc' : 'desc');
    setParams(next, { replace: true });
  };
  const sortHeader = (key: string, label: string) => {
    const active = (filters.sort ?? 'created_at') === key;
    const dir = filters.dir ?? 'desc';
    return (
      <th aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button onClick={() => sortBy(key)}>
          {label} {active ? (dir === 'asc' ? '▲' : '▼') : ''}
        </button>
      </th>
    );
  };
  const exportUrl = `/api/donations/export.csv${qs(filters)}`;
  const anyFilter = Object.keys(filters).some((k) => !['sort', 'dir'].includes(k) && !(preset && k in preset.filters));

  return (
    <div className="stack">
      <PageHeader
        title={preset?.title ?? 'All Donations'}
        subtitle={preset?.subtitle ?? 'Search, filter and manage every donation you are allowed to see.'}
        actions={
          <>
            {can('exports.run') && (
              <a className="btn btn-secondary" href={exportUrl}>
                ⬇ Export CSV
              </a>
            )}
            {canAny('donations.create', 'submissions.create') && (
              <Link className="btn btn-primary" to="/app/donations/new">
                + Add donation
              </Link>
            )}
          </>
        }
      />
      {params.get('preset') === 'thankyou' && (
        <div className="tabs" role="tablist" aria-label="Thank-you views">
          {[
            ['outstanding', 'All outstanding'],
            ['ready', 'Received – ready to thank'],
            ['draft', 'Draft prepared'],
            ['sent', 'Sent'],
          ].map(([k, l]) => (
            <button key={k} role="tab" className="tab" aria-selected={(filters.thank_you ?? 'outstanding') === k} onClick={() => update('thank_you', k)}>
              {l}
            </button>
          ))}
        </div>
      )}
      <button className="btn btn-secondary mobile-only" aria-expanded={filtersOpen} aria-controls="donation-filters" onClick={() => setFiltersOpen((o) => !o)}>
        {filtersOpen ? 'Hide search & filters' : 'Search & filters'}
      </button>
      <div className={`filters ${filtersOpen ? '' : 'collapsed'}`} role="search" id="donation-filters">
        <div className="field" style={{ flex: '2 1 220px' }}>
          <label htmlFor="d-q">Search</label>
          <input id="d-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Donor, contact, description or ID" />
        </div>
        {events && <EventSelect id="d-event" events={events} value={filters.event_id ? Number(filters.event_id) : ''} onChange={(v) => update('event_id', String(v))} allowAll />}
        <div className="field">
          <label htmlFor="d-cat">Category</label>
          <select id="d-cat" value={filters.category ?? ''} onChange={(e) => update('category', e.target.value)}>
            <option value="">All</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        {filters.category === 'food' && (
          <div className="field">
            <label htmlFor="d-sub">Food type</label>
            <select id="d-sub" value={filters.subcategory ?? ''} onChange={(e) => update('subcategory', e.target.value)}>
              <option value="">All</option>
              {SUBCATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {SUBCATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="d-status">Status</label>
          <select id="d-status" value={filters.status ?? ''} onChange={(e) => update('status', e.target.value)}>
            <option value="">All</option>
            {(statuses ?? []).map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="d-pub">Publication</label>
          <select id="d-pub" value={filters.publication_status ?? ''} onChange={(e) => update('publication_status', e.target.value)}>
            <option value="">All</option>
            {Object.entries(PUBLICATION_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="d-assigned">Assigned to</label>
          <select id="d-assigned" value={filters.assigned_to ?? ''} onChange={(e) => update('assigned_to', e.target.value)}>
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="none">Unassigned</option>
            {(users ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="d-fu">Follow-up</label>
          <select id="d-fu" value={filters.follow_up ?? ''} onChange={(e) => update('follow_up', e.target.value)}>
            <option value="">Any</option>
            <option value="overdue">Overdue</option>
            <option value="today">Due today</option>
            <option value="scheduled">Scheduled</option>
            <option value="none">None scheduled</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="d-fu-from">Follow-up from</label>
          <input id="d-fu-from" type="date" value={filters.follow_up_from ?? ''} onChange={(e) => update('follow_up_from', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="d-fu-to">Follow-up to</label>
          <input id="d-fu-to" type="date" value={filters.follow_up_to ?? ''} onChange={(e) => update('follow_up_to', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="d-rec">Item received</label>
          <select id="d-rec" value={filters.item_received ?? ''} onChange={(e) => update('item_received', e.target.value)}>
            <option value="">Any</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>
        {params.get('preset') !== 'thankyou' && (
          <div className="field">
            <label htmlFor="d-ty">Thank-you</label>
            <select id="d-ty" value={filters.thank_you ?? ''} onChange={(e) => update('thank_you', e.target.value)}>
              <option value="">Any</option>
              <option value="outstanding">Outstanding</option>
              <option value="ready">Received, not thanked</option>
              <option value="draft">Draft prepared</option>
              <option value="sent">Sent</option>
              <option value="not_required">Not required</option>
            </select>
          </div>
        )}
        {can('donations.archive') && (
          <div className="field">
            <label htmlFor="d-arch">Archived</label>
            <select id="d-arch" value={filters.archived ?? ''} onChange={(e) => update('archived', e.target.value)}>
              <option value="">Hide archived</option>
              <option value="include">Include archived</option>
              <option value="only">Only archived</option>
            </select>
          </div>
        )}
        {anyFilter && (
          <button className="btn btn-secondary btn-sm" onClick={() => setParams(params.get('preset') ? { preset: params.get('preset')! } : {}, { replace: true })}>
            Clear filters
          </button>
        )}
      </div>

      <ErrorAlert error={error} />
      {loading && !data ? (
        <Spinner />
      ) : !data?.rows.length ? (
        <EmptyState title="No donations found">{anyFilter ? 'Try removing some filters.' : 'Donations you can access will appear here.'}</EmptyState>
      ) : (
        <>
          <p className="muted small" aria-live="polite">
            {data.total} donation{data.total === 1 ? '' : 's'} · total estimated value {money(data.total_value)}
            {loading && ' · updating…'}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {sortHeader('id', 'ID')}
                  {sortHeader('event', 'Event')}
                  {sortHeader('donor', 'Donor / Org')}
                  <th>Contact</th>
                  {sortHeader('category', 'Category')}
                  <th>Description</th>
                  <th>Qty</th>
                  {sortHeader('value', 'Est. value')}
                  {sortHeader('status', 'Status')}
                  <th>Publication</th>
                  <th>Assigned</th>
                  {sortHeader('follow_up', 'Next follow-up')}
                  <th>Item rec'd</th>
                  <th>Thank-you</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((d) => (
                  <tr key={d.id} className={d.follow_up_overdue ? 'overdue' : ''}>
                    <td>
                      <Link to={`/app/donations/${d.id}`}>#{d.id}</Link>
                    </td>
                    <td>{d.event_name}</td>
                    <td>
                      <Link to={`/app/donations/${d.id}`}>{d.donor_name}</Link>
                    </td>
                    <td>{d.contact_hidden ? <span className="muted small">Restricted</span> : (d.contact_name ?? '—')}</td>
                    <td>
                      {CATEGORY_LABELS[d.category]}
                      {d.subcategory && <div className="muted small">{SUBCATEGORY_LABELS[d.subcategory]}</div>}
                    </td>
                    <td className="cell-desc">
                      <span className="clamp">{d.description}</span>
                    </td>
                    <td>{d.quantity}</td>
                    <td className="nowrap">{money(d.estimated_value_cad)}</td>
                    <td>
                      <StatusBadge code={d.status} label={d.status_label} />
                    </td>
                    <td>
                      <PublicationBadge status={d.publication_status} />
                    </td>
                    <td>{d.assigned_to_name ?? <span className="muted">—</span>}</td>
                    <td className="nowrap">
                      {date(d.next_follow_up_date)}
                      {d.follow_up_overdue && <div className="badge badge-red">Overdue</div>}
                    </td>
                    <td>
                      <YesNo value={d.item_received} />
                    </td>
                    <td>
                      <YesNo value={d.thank_you_sent} />
                      {d.thank_you_stage === 'draft_prepared' && <div className="muted small">{THANK_YOU_STAGE_LABELS.draft_prepared}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={(p) => update('page', String(p))} />
        </>
      )}
    </div>
  );
}
