import type { EventRow } from '../lib/data';
import { EVENT_STATUS_LABELS } from '../lib/format';

export function EventSelect({
  events,
  value,
  onChange,
  allowAll,
  id = 'event-select',
  label = 'Event',
}: {
  events: EventRow[];
  value: number | '' | null;
  onChange: (v: number | '') => void;
  allowAll?: boolean;
  id?: string;
  label?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}>
        {allowAll && <option value="">All events</option>}
        {events.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name} {e.status !== 'active' ? `(${EVENT_STATUS_LABELS[e.status]})` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
