import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { EventSelect } from '../components/EventSelect';
import { TaskTable, type Task } from '../components/TaskTable';
import { Alert, EmptyState, ErrorAlert, PageHeader, Spinner } from '../components/ui';
import { qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { getStoredEvent, storeEvent, useEvents } from '../lib/data';
import { money } from '../lib/format';
import { useApi } from '../lib/useApi';

interface DashboardData {
  eventId: number | null;
  today: string;
  canReview: boolean;
  cards: Record<string, number> | null;
  myTasks: { open: number; overdue: number; today: number };
}

export default function Dashboard() {
  const { user } = useAuth();
  const { data: events } = useEvents();
  const [eventId, setEventId] = useState<number | ''>(getStoredEvent() ?? '');
  const { data, error, loading } = useApi<DashboardData>(`/api/dashboard${qs({ event_id: eventId })}`);
  const tasks = useApi<{ rows: Task[]; total: number }>('/api/tasks?status=open&page_size=10');

  useEffect(() => {
    if (data?.eventId && eventId === '') setEventId(data.eventId);
  }, [data, eventId]);
  useEffect(() => {
    if (events && eventId && !events.some((e) => e.id === eventId)) setEventId('');
  }, [events, eventId]);

  const ev = (extra: Record<string, string | number>) => `/app/donations${qs({ event_id: data?.eventId ?? '', ...extra })}`;
  const c = data?.cards;
  const cards = c
    ? [
        { label: 'Total donations submitted', value: c.total_submitted, to: data!.canReview ? `/app/approvals?status=all&event_id=${data!.eventId}` : ev({}) },
        ...(data!.canReview ? [{ label: 'Awaiting review', value: c.awaiting_review, to: `/app/approvals?event_id=${data!.eventId}`, alert: c.awaiting_review > 0 }] : []),
        { label: 'Approved donations', value: c.approved, to: ev({ view: 'approved' }) },
        { label: 'Published donations', value: c.published, to: ev({ publication_status: 'published' }) },
        { label: 'Total estimated value', value: money(c.total_value), to: ev({ view: 'approved', sort: 'value' }) },
        { label: 'Awaiting pickup', value: c.awaiting_pickup, to: ev({ view: 'awaiting_pickup' }) },
        { label: 'Items received', value: c.items_received, to: ev({ item_received: 'yes' }) },
        { label: 'Thank-yous outstanding', value: c.thank_you_outstanding, to: ev({ thank_you: 'outstanding' }) },
        { label: 'Follow-ups due today', value: c.follow_ups_today, to: ev({ follow_up: 'today' }) },
        { label: 'Overdue follow-ups', value: c.follow_ups_overdue, to: ev({ follow_up: 'overdue' }), alert: c.follow_ups_overdue > 0 },
      ]
    : [];

  return (
    <div className="stack">
      <PageHeader
        title={`Welcome, ${user?.name.split(' ')[0]}`}
        subtitle="Here is an overview of the selected auction event."
        actions={
          events && events.length > 0 ? (
            <div style={{ minWidth: 260 }}>
              <EventSelect
                events={events}
                value={eventId || data?.eventId || ''}
                onChange={(v) => {
                  setEventId(v);
                  storeEvent(v || null);
                }}
              />
            </div>
          ) : null
        }
      />
      <ErrorAlert error={error} />
      {loading && !data ? (
        <Spinner />
      ) : !data?.eventId ? (
        <EmptyState title="No events yet" icon="📅">
          <p>Create your first auction event to start collecting donations.</p>
          <Link className="btn btn-primary" to="/app/events">
            Go to Event Management
          </Link>
        </EmptyState>
      ) : (
        <section aria-label="Summary" className="stats">
          {cards.map((card) => (
            <Link key={card.label} to={card.to} className={`stat ${card.alert ? 'stat-alert' : ''}`}>
              <div className="stat-value">{card.value}</div>
              <div className="stat-label">{card.label}</div>
            </Link>
          ))}
        </section>
      )}

      <section className="card">
        <div className="card-header">
          <h2>My To Do List</h2>
          <Link to="/app/tasks">View all my tasks →</Link>
        </div>
        {data && data.myTasks.overdue > 0 && (
          <Alert kind="warning">
            You have {data.myTasks.overdue} overdue task{data.myTasks.overdue === 1 ? '' : 's'}.
          </Alert>
        )}
        {tasks.loading && !tasks.data ? (
          <Spinner />
        ) : (
          <TaskTable tasks={tasks.data?.rows ?? []} onChanged={tasks.reload} compact empty="You're all caught up — no open tasks." />
        )}
      </section>
    </div>
  );
}
