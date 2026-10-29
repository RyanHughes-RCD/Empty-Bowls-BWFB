import { useState } from 'react';
import { EventSelect } from '../components/EventSelect';
import { Alert, PageHeader } from '../components/ui';
import { qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEvents } from '../lib/data';
import { CATEGORIES, CATEGORY_LABELS } from '../lib/format';

export default function Exports() {
  const { can } = useAuth();
  const { data: events } = useEvents();
  const [eventId, setEventId] = useState<number | ''>('');
  const [category, setCategory] = useState('');
  const [view, setView] = useState('');
  const contacts = can('donors.view_all') || can('contacts.view_assigned');
  return (
    <div className="stack">
      <PageHeader title="Donation Exports" subtitle="Download records as CSV files that open in Excel or Google Sheets." />
      <Alert kind="info">
        Exports include only records you are allowed to see. {contacts ? 'Your exports include donor contact details — store and share them carefully.' : 'Contact details are not included in your exports.'} Internal notes are never exported. Every export is recorded in the audit log.
      </Alert>
      <section className="card stack">
        <h2>Donations</h2>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          {events && (
            <div style={{ minWidth: 240 }}>
              <EventSelect id="x-event" events={events} value={eventId} onChange={setEventId} allowAll />
            </div>
          )}
          <div className="field">
            <label htmlFor="x-cat">Category</label>
            <select id="x-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="x-view">Which donations</label>
            <select id="x-view" value={view} onChange={(e) => setView(e.target.value)}>
              <option value="">All</option>
              <option value="approved">Approved only</option>
              <option value="awaiting_pickup">Awaiting pickup</option>
            </select>
          </div>
          <a className="btn btn-primary" href={`/api/donations/export.csv${qs({ event_id: eventId, category, view })}`}>
            ⬇ Download donations CSV
          </a>
        </div>
      </section>
      <section className="card stack">
        <h2>Donors</h2>
        <div>
          <a className="btn btn-primary" href="/api/donors/export.csv">
            ⬇ Download donor directory CSV
          </a>
        </div>
      </section>
      <section className="card">
        <h2>Event reports</h2>
        <p>Summary, category and donor reports for an event can be downloaded from the Event Reports page.</p>
      </section>
    </div>
  );
}
