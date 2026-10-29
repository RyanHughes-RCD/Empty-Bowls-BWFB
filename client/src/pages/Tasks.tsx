import { useState } from 'react';
import { EventSelect } from '../components/EventSelect';
import { TaskTable, type Task } from '../components/TaskTable';
import { ErrorAlert, Field, Modal, PageHeader, Pagination, Spinner, fieldErrors, useToast } from '../components/ui';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEvents, useUserOptions } from '../lib/data';
import { PRIORITY_LABELS } from '../lib/format';
import { useApi } from '../lib/useApi';

export default function Tasks({ scope }: { scope: 'mine' | 'all' }) {
  const { data: events } = useEvents();
  const { data: users } = useUserOptions();
  const [f, setF] = useState({ status: 'open', event_id: '' as number | '', assigned_to: '', priority: '', from: '', to: '', due: '' });
  const [page, setPage] = useState(1);
  const url = `/api/tasks${qs({ scope, ...f, page, page_size: 25 })}`;
  const { data, error, loading, reload } = useApi<{ rows: Task[]; total: number; page: number; pageSize: number }>(url);
  const [adding, setAdding] = useState(false);
  const set = (k: keyof typeof f, v: string | number) => {
    setF({ ...f, [k]: v });
    setPage(1);
  };

  return (
    <div className="stack">
      <PageHeader
        title={scope === 'mine' ? 'My To Do List' : 'Follow-Ups'}
        subtitle={scope === 'mine' ? 'Tasks assigned to you. Overdue tasks are highlighted.' : 'All follow-up tasks across the team.'}
        actions={
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            + New task
          </button>
        }
      />
      <div className="filters" role="search">
        <div className="field">
          <label htmlFor="t-status">Status</label>
          <select id="t-status" value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="open">Open</option>
            <option value="completed">Completed</option>
            <option value="cancelled">No longer required</option>
            <option value="all">All</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="t-due">Due</label>
          <select id="t-due" value={f.due} onChange={(e) => set('due', e.target.value)}>
            <option value="">Any time</option>
            <option value="overdue">Overdue</option>
            <option value="today">Today</option>
            <option value="upcoming">Upcoming</option>
          </select>
        </div>
        {events && <EventSelect id="t-event" events={events} value={f.event_id} onChange={(v) => set('event_id', v)} allowAll />}
        {scope === 'all' && (
          <div className="field">
            <label htmlFor="t-user">Assigned to</label>
            <select id="t-user" value={f.assigned_to} onChange={(e) => set('assigned_to', e.target.value)}>
              <option value="">Anyone</option>
              {(users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="t-priority">Priority</label>
          <select id="t-priority" value={f.priority} onChange={(e) => set('priority', e.target.value)}>
            <option value="">Any</option>
            {Object.entries(PRIORITY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="t-from">Due from</label>
          <input id="t-from" type="date" value={f.from} onChange={(e) => set('from', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="t-to">Due to</label>
          <input id="t-to" type="date" value={f.to} onChange={(e) => set('to', e.target.value)} />
        </div>
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? <Spinner /> : <TaskTable tasks={data?.rows ?? []} onChanged={reload} showAssignee={scope === 'all'} empty="No tasks match these filters." />}
      {data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      {adding && <NewTaskDialog onClose={() => setAdding(false)} onCreated={reload} />}
    </div>
  );
}

export function NewTaskDialog({ onClose, onCreated, donationId }: { onClose: () => void; onCreated: () => void; donationId?: number }) {
  const { user, canAny } = useAuth();
  const { data: users } = useUserOptions();
  const toast = useToast();
  const [form, setForm] = useState({ description: '', due_date: '', priority: 'normal', task_type: 'general', assigned_to: user?.id ?? '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const errs = fieldErrors(error);
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/api/tasks', { ...form, donation_id: donationId ?? null, due_date: form.due_date || null });
      toast('Task created');
      onCreated();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title="New task" onClose={onClose}>
      <div className="stack">
        <ErrorAlert error={error} />
        <Field id="nt-desc" label="Task description" required error={errs.description}>
          <textarea id="nt-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ minHeight: 70 }} />
        </Field>
        <div className="grid-2">
          <Field id="nt-due" label="Due date" error={errs.due_date}>
            <input id="nt-due" type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
          </Field>
          <Field id="nt-priority" label="Priority">
            <select id="nt-priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              {Object.entries(PRIORITY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field id="nt-type" label="Type">
            <select id="nt-type" value={form.task_type} onChange={(e) => setForm({ ...form, task_type: e.target.value })}>
              <option value="general">General</option>
              <option value="follow_up">Follow-up</option>
              <option value="pickup">Pickup</option>
              <option value="receipt">Confirm receipt</option>
              <option value="thank_you">Thank-you</option>
              <option value="info_request">Request information</option>
            </select>
          </Field>
          {canAny('tasks.manage', 'donations.assign') && (
            <Field id="nt-user" label="Assign to">
              <select id="nt-user" value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: Number(e.target.value) })}>
                {(users ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <div className="button-row">
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Create task'}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
