import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EventSelect } from '../components/EventSelect';
import { ErrorAlert, PageHeader, Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';
import { getStoredEvent, useEvents } from '../lib/data';
import { dateTime, money } from '../lib/format';
import { useApi } from '../lib/useApi';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export default function Reports() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const { data: events } = useEvents();
  const [eventId, setEventId] = useState<number | ''>(Number(params.get('event_id')) || getStoredEvent() || '');
  useEffect(() => {
    if (!eventId && events?.length) setEventId(events[0].id);
  }, [events, eventId]);
  const { data: r, error, loading } = useApi<Row>(eventId ? `/api/reports/events/${eventId}` : null);
  const maxCat = Math.max(1, ...((r?.byCategory ?? []) as Row[]).map((c) => Number(c.value)));

  const s = r?.summary;
  const metrics: [string, string | number, string?][] = r
    ? [
        ['Donations submitted', r.submissions.submitted + s.added_directly, `${r.submissions.submitted} via submissions, ${s.added_directly} added by staff`],
        ['Awaiting review', r.submissions.awaiting_review],
        ['Approved donations', s.approved],
        ['Published donations', s.published],
        ['Total estimated value (approved)', money(s.approved_value)],
        ['Awaiting pickup', s.awaiting_pickup],
        ['Received', s.received],
        ['Thank-yous outstanding', s.thank_you_outstanding],
        ['Thank-yous sent', s.thank_you_sent],
        ['Overdue follow-ups', s.overdue_follow_ups],
      ]
    : [];

  return (
    <div className="stack">
      <PageHeader
        title="Event Reports"
        subtitle="All figures are for the selected event only."
        actions={
          <>
            <button className="btn btn-secondary" onClick={() => window.print()}>
              Print
            </button>
            {can('exports.run') && eventId && (
              <>
                <a className="btn btn-secondary" href={`/api/reports/events/${eventId}/export.csv?section=summary`}>
                  ⬇ Summary CSV
                </a>
                <a className="btn btn-secondary" href={`/api/reports/events/${eventId}/export.csv?section=categories`}>
                  ⬇ Categories CSV
                </a>
                <a className="btn btn-secondary" href={`/api/reports/events/${eventId}/export.csv?section=donors`}>
                  ⬇ Donors CSV
                </a>
              </>
            )}
          </>
        }
      />
      {events && (
        <div style={{ maxWidth: 360 }}>
          <EventSelect
            events={events}
            value={eventId}
            onChange={(v) => {
              setEventId(v);
              setParams(v ? { event_id: String(v) } : {}, { replace: true });
            }}
          />
        </div>
      )}
      <ErrorAlert error={error} />
      {loading && !r ? (
        <Spinner />
      ) : r ? (
        <>
          <p className="muted small">
            {r.event.name} · generated {dateTime(r.generatedAt)}
          </p>
          <section className="stats">
            {metrics.map(([label, value, hint]) => (
              <div key={label} className="stat" title={hint}>
                <div className="stat-value">{value}</div>
                <div className="stat-label">{label}</div>
              </div>
            ))}
          </section>
          <div className="grid-2">
            <section className="card">
              <h2>Approved donations by category</h2>
              <table>
                <thead>
                  <tr>
                    <th>Category</th>
                    <th className="right">Donations</th>
                    <th className="right">Units</th>
                    <th className="right">Value</th>
                    <th>
                      <span className="visually-hidden">Share of value</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {r.byCategory.map((c: Row) => (
                    <tr key={c.category}>
                      <td>
                        <Link to={`/app/donations?event_id=${eventId}&category=${c.category}&view=approved`}>{c.label}</Link>
                      </td>
                      <td className="right">{c.count}</td>
                      <td className="right">{c.units}</td>
                      <td className="right">{money(c.value)}</td>
                      <td style={{ width: '25%' }}>
                        <div className="bar" aria-hidden="true">
                          <span style={{ width: `${(Number(c.value) / maxCat) * 100}%` }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="card">
              <h2>Food by type</h2>
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th className="right">Donations</th>
                    <th className="right">Units</th>
                    <th className="right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {r.byFoodSubcategory.map((c: Row) => (
                    <tr key={c.subcategory}>
                      <td>{c.label}</td>
                      <td className="right">{c.count}</td>
                      <td className="right">{c.units}</td>
                      <td className="right">{money(c.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
          <section className="card">
            <h2>Donations by donor / organization</h2>
            {r.byDonor.length === 0 ? (
              <p className="muted">No approved donations yet.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Donor</th>
                      <th className="right">Donations</th>
                      <th className="right">Estimated value</th>
                      <th className="right">Received</th>
                      <th className="right">Thanked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.byDonor.map((d: Row) => (
                      <tr key={d.donor_id}>
                        <td>
                          <Link to={`/app/donors/${d.donor_id}`}>{d.donor_name}</Link>
                        </td>
                        <td className="right">{d.count}</td>
                        <td className="right">{money(d.value)}</td>
                        <td className="right">{d.received}</td>
                        <td className="right">{d.thanked}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <p className="muted small">Estimated values are donors' or staff estimates of fair market value — not amounts raised at auction.</p>
        </>
      ) : null}
    </div>
  );
}
