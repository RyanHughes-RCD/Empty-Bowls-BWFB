import { useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorAlert, PageHeader, Pagination, Spinner } from '../components/ui';
import { qs } from '../lib/api';
import { dateTime } from '../lib/format';
import { useApi } from '../lib/useApi';

interface AuditRow {
  id: number;
  action: string;
  record_type: string;
  record_id: string | null;
  summary: string | null;
  created_at: string;
  user_name: string | null;
}

const LINKS: Record<string, string> = { donation: '/app/donations/', donor: '/app/donors/', submission: '/app/approvals/' };

export default function AuditLog() {
  const [params, setParams] = useSearchParams();
  const f = Object.fromEntries(['record_type', 'record_id', 'action', 'from', 'to', 'page'].map((k) => [k, params.get(k) ?? '']));
  const { data, error, loading } = useApi<{ rows: AuditRow[]; total: number; pageSize: number }>(`/api/audit${qs(f)}`);
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== 'page') n.delete('page');
    setParams(n, { replace: true });
  };
  return (
    <div className="stack">
      <PageHeader title="Audit Log" subtitle="A permanent record of sign-ins, changes, approvals, publications and exports." />
      <div className="filters">
        <div className="field">
          <label htmlFor="a-type">Record type</label>
          <select id="a-type" value={f.record_type} onChange={(e) => set('record_type', e.target.value)}>
            <option value="">All</option>
            {['donation', 'donor', 'submission', 'event', 'task', 'user', 'export', 'settings', 'status'].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="a-id">Record ID</label>
          <input id="a-id" type="text" value={f.record_id} onChange={(e) => set('record_id', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="a-action">Action starts with</label>
          <input id="a-action" type="text" value={f.action} onChange={(e) => set('action', e.target.value)} placeholder="e.g. auth. or donation.publish" />
        </div>
        <div className="field">
          <label htmlFor="a-from">From</label>
          <input id="a-from" type="date" value={f.from} onChange={(e) => set('from', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="a-to">To</label>
          <input id="a-to" type="date" value={f.to} onChange={(e) => set('to', e.target.value)} />
        </div>
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? (
        <Spinner />
      ) : !data?.rows.length ? (
        <EmptyState title="No activity found" icon="📜" />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Record</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((a) => (
                  <tr key={a.id}>
                    <td className="nowrap">{dateTime(a.created_at)}</td>
                    <td>{a.user_name ?? <span className="muted">Public / system</span>}</td>
                    <td>
                      <code>{a.action}</code>
                    </td>
                    <td>
                      {a.record_id && LINKS[a.record_type] ? (
                        <a href={`${LINKS[a.record_type]}${a.record_id}`}>
                          {a.record_type} #{a.record_id}
                        </a>
                      ) : (
                        `${a.record_type}${a.record_id ? ` #${a.record_id}` : ''}`
                      )}
                    </td>
                    <td>{a.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={Number(f.page) || 1} pageSize={data.pageSize} total={data.total} onPage={(p) => set('page', String(p))} />
        </>
      )}
    </div>
  );
}
