import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useUserOptions } from '../lib/data';
import { PRIORITY_LABELS, TASK_STATUS_LABELS, date, dateTime } from '../lib/format';
import { Badge, EmptyState, ErrorAlert, Field, Modal, useToast } from './ui';
import { useApi } from '../lib/useApi';

export interface Task {
  id: number;
  donation_id: number | null;
  event_id: number | null;
  event_name: string | null;
  donor_id: number | null;
  donor_name: string | null;
  donation_description: string | null;
  assigned_to: number | null;
  assigned_to_name: string | null;
  description: string;
  due_date: string | null;
  priority: string;
  status: string;
  task_type: string;
  is_next_follow_up: boolean;
  completed_at: string | null;
  completed_by_name: string | null;
  outcome: string | null;
  overdue: boolean;
  due_today: boolean;
}

const PRIORITY_TONE: Record<string, 'gray' | 'blue' | 'amber' | 'red'> = { low: 'gray', normal: 'blue', high: 'amber', urgent: 'red' };

export function TaskTable({ tasks, onChanged, compact, empty, showAssignee }: { tasks: Task[]; onChanged: () => void; compact?: boolean; empty?: string; showAssignee?: boolean }) {
  const [active, setActive] = useState<Task | null>(null);
  if (!tasks.length) return <EmptyState title={empty ?? 'No tasks'} icon="✅" />;
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Donor / donation</th>
              {!compact && <th>Event</th>}
              {showAssignee && <th>Assigned to</th>}
              <th>Due</th>
              <th>Priority</th>
              <th>Status</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className={t.overdue ? 'overdue' : ''}>
                <td>
                  {t.description}
                  {t.is_next_follow_up && (
                    <div>
                      <Badge tone="purple">Next follow-up</Badge>
                    </div>
                  )}
                </td>
                <td>
                  {t.donor_id ? <Link to={`/app/donors/${t.donor_id}`}>{t.donor_name}</Link> : '—'}
                  {t.donation_id && (
                    <div className="small">
                      <Link to={`/app/donations/${t.donation_id}`}>Donation #{t.donation_id}</Link>
                    </div>
                  )}
                </td>
                {!compact && <td>{t.event_name ?? '—'}</td>}
                {showAssignee && <td>{t.assigned_to_name ?? '—'}</td>}
                <td className="nowrap">
                  {date(t.due_date)}
                  {t.overdue && (
                    <div>
                      <Badge tone="red">Overdue</Badge>
                    </div>
                  )}
                  {t.due_today && (
                    <div>
                      <Badge tone="amber">Today</Badge>
                    </div>
                  )}
                </td>
                <td>
                  <Badge tone={PRIORITY_TONE[t.priority]}>{PRIORITY_LABELS[t.priority]}</Badge>
                </td>
                <td>
                  {TASK_STATUS_LABELS[t.status]}
                  {t.completed_at && <div className="muted small">{date(t.completed_at)}</div>}
                </td>
                <td>
                  <button className="btn btn-secondary btn-sm" onClick={() => setActive(t)}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {active && (
        <TaskDialog
          task={active}
          onClose={() => setActive(null)}
          onChanged={() => {
            onChanged();
          }}
        />
      )}
    </>
  );
}

function TaskDialog({ task, onClose, onChanged }: { task: Task; onClose: () => void; onChanged: () => void }) {
  const { canAny } = useAuth();
  const toast = useToast();
  const detail = useApi<{ task: Task; events: { id: number; action: string; detail: string | null; created_at: string; actor_name: string | null }[] }>(`/api/tasks/${task.id}`);
  const { data: users } = useUserOptions();
  const [outcome, setOutcome] = useState('');
  const [due, setDue] = useState(task.due_date ?? '');
  const [assignee, setAssignee] = useState<number | ''>(task.assigned_to ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const t = detail.data?.task ?? task;
  const open = t.status === 'open' || t.status === 'in_progress';

  const act = async (body: Record<string, unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/tasks/${task.id}/actions`, body);
      toast(message);
      await detail.reload();
      onChanged();
      if (body.action === 'complete' || body.action === 'cancel') onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title="Task" onClose={onClose} wide>
      <div className="stack">
        <div>
          <h3>{t.description}</h3>
          <p className="muted">
            {t.donor_name && <>Donor: {t.donor_name} · </>}
            {t.donation_id && (
              <>
                <Link to={`/app/donations/${t.donation_id}`} onClick={onClose}>
                  Open donation #{t.donation_id}
                </Link>{' '}
                ·{' '}
              </>
            )}
            Due {date(t.due_date)} · {PRIORITY_LABELS[t.priority]} priority · {TASK_STATUS_LABELS[t.status]}
          </p>
        </div>
        <ErrorAlert error={error} />
        {open && (
          <div className="grid-2">
            <div className="card stack-sm">
              <Field id="task-outcome" label="Outcome (optional)">
                <textarea id="task-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} style={{ minHeight: 60 }} />
              </Field>
              <div className="button-row">
                <button className="btn btn-success" disabled={busy} onClick={() => act({ action: 'complete', outcome }, 'Task completed')}>
                  ✓ Mark complete
                </button>
                <button className="btn btn-secondary" disabled={busy} onClick={() => act({ action: 'cancel', reason: outcome || 'No longer required' }, 'Task marked no longer required')}>
                  No longer required
                </button>
              </div>
            </div>
            <div className="card stack-sm">
              <Field id="task-due" label="Reschedule to">
                <input id="task-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
              </Field>
              <button className="btn btn-secondary" disabled={busy || !due || due === t.due_date} onClick={() => act({ action: 'reschedule', due_date: due }, 'Task rescheduled')}>
                Reschedule
              </button>
              {canAny('tasks.manage', 'donations.assign') && (
                <>
                  <Field id="task-assignee" label="Reassign to">
                    <select id="task-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value ? Number(e.target.value) : '')}>
                      {(users ?? []).map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <button className="btn btn-secondary" disabled={busy || !assignee || assignee === t.assigned_to} onClick={() => act({ action: 'reassign', assigned_to: assignee }, 'Task reassigned')}>
                    Reassign
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        {!open && (
          <div className="button-row">
            <button className="btn btn-secondary" disabled={busy} onClick={() => act({ action: 'reopen' }, 'Task reopened')}>
              Reopen task
            </button>
          </div>
        )}
        <div className="card stack-sm">
          <Field id="task-note" label="Add a note">
            <textarea id="task-note" value={note} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 60 }} />
          </Field>
          <button
            className="btn btn-secondary"
            disabled={busy || !note.trim()}
            onClick={() => act({ action: 'note', text: note }, 'Note added').then(() => setNote(''))}
          >
            Add note
          </button>
        </div>
        <div>
          <h3>History</h3>
          <ul className="timeline">
            {(detail.data?.events ?? []).map((e) => (
              <li key={e.id}>
                <strong>{e.action.replace(/_/g, ' ')}</strong> {e.detail && <>— {e.detail}</>}
                <div className="muted small">
                  {dateTime(e.created_at)} {e.actor_name && `· ${e.actor_name}`}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
