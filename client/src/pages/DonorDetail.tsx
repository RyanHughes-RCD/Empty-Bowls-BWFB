import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Badge, ConfirmDialog, ErrorAlert, PageHeader, PublicationBadge, Spinner, StatusBadge, YesNo, useToast } from '../components/ui';
import { api } from '../lib/api';
import { categoryText, dateTime, money } from '../lib/format';
import { useApi } from '../lib/useApi';
import { DonorDialog } from './Donors';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export default function DonorDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<{
    donor: Row;
    donations: Row[];
    history: Row[] | null;
    duplicates: Row[];
    permissions: { edit: boolean; merge: boolean; delete: boolean };
  }>(`/api/donors/${id}`);
  const [editing, setEditing] = useState(false);
  const [merge, setMerge] = useState<Row | null>(null);
  const [confirm, setConfirm] = useState<null | 'archive' | 'restore' | 'anonymize'>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <ErrorAlert error={error} />;
  const d = data.donor;
  const doAction = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      setConfirm(null);
      setMerge(null);
      reload();
    } catch (e) {
      setActionError(e);
      setConfirm(null);
      setMerge(null);
    }
  };

  return (
    <div className="stack">
      <PageHeader
        title={d.name}
        subtitle={`DonorID #${d.id} · ${d.donor_type}`}
        actions={
          <>
            {data.permissions.edit && !d.merged_into_id && (
              <button className="btn btn-secondary" onClick={() => setEditing(true)}>
                Edit donor
              </button>
            )}
            {data.permissions.delete && !d.merged_into_id && (
              <button className="btn btn-secondary" onClick={() => setConfirm(d.is_archived ? 'restore' : 'archive')}>
                {d.is_archived ? 'Restore' : 'Archive'}
              </button>
            )}
            {data.permissions.delete && (
              <button className="btn btn-danger" onClick={() => setConfirm('anonymize')}>
                Erase personal info…
              </button>
            )}
          </>
        }
      />
      {d.merged_into_id && (
        <Alert kind="info">
          This donor was merged into <Link to={`/app/donors/${d.merged_into_id}`}>{d.merged_into_name}</Link>.
        </Alert>
      )}
      {d.is_archived && !d.merged_into_id && <Alert kind="warning">This donor is archived.</Alert>}
      <ErrorAlert error={actionError} />
      <div className="detail-grid">
        <div className="stack">
          <section className="card">
            <h2>Donations</h2>
            {data.donations.length === 0 ? (
              <p className="muted">No donations you can access.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Event</th>
                      <th>Category</th>
                      <th>Description</th>
                      <th>Value</th>
                      <th>Status</th>
                      <th>Publication</th>
                      <th>Rec'd</th>
                      <th>Thanked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.donations.map((x) => (
                      <tr key={x.id}>
                        <td>
                          <Link to={`/app/donations/${x.id}`}>#{x.id}</Link>
                        </td>
                        <td>{x.event_name}</td>
                        <td>{categoryText(x.category, x.subcategory)}</td>
                        <td className="cell-desc">
                          <span className="clamp">{x.description}</span>
                        </td>
                        <td>{money(x.estimated_value_cad)}</td>
                        <td>
                          <StatusBadge code={x.status} label={x.status_label} />
                        </td>
                        <td>
                          <PublicationBadge status={x.publication_status} />
                        </td>
                        <td>
                          <YesNo value={x.item_received} />
                        </td>
                        <td>
                          <YesNo value={x.thank_you_sent} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          {data.history && (
            <section className="card">
              <h2>Change history</h2>
              {data.history.length === 0 ? (
                <p className="muted small">No changes recorded.</p>
              ) : (
                <ul className="timeline">
                  {data.history.map((h) => (
                    <li key={h.id}>
                      {h.reason} <span className="muted small">· {dateTime(h.changed_at)} · {h.changed_by_name}</span>
                      {h.snapshot && (
                        <details>
                          <summary className="small">Previous values</summary>
                          <div className="small">
                            {h.snapshot.name} · {h.snapshot.contact_name} · {h.snapshot.contact_email} · {h.snapshot.contact_phone} · {h.snapshot.website}
                          </div>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
        <div className="stack">
          <section className="card">
            <h2>Contact</h2>
            <dl className="details">
              {d.contact_hidden ? (
                <>
                  <dt>Contact</dt>
                  <dd className="muted">Restricted</dd>
                </>
              ) : (
                <>
                  <dt>Contact name</dt>
                  <dd>{d.contact_name || '—'}</dd>
                  <dt>Email</dt>
                  <dd>{d.contact_email ? <a href={`mailto:${d.contact_email}`}>{d.contact_email}</a> : '—'}</dd>
                  <dt>Phone</dt>
                  <dd>{d.contact_phone ? <a href={`tel:${d.contact_phone}`}>{d.contact_phone}</a> : '—'}</dd>
                  <dt>Social media</dt>
                  <dd>{(d.social_media ?? []).map((s: Row) => s.handle).join(', ') || '—'}</dd>
                </>
              )}
              <dt>Website</dt>
              <dd>
                {d.website ? (
                  <a href={d.website} target="_blank" rel="noopener noreferrer">
                    {d.website}
                  </a>
                ) : (
                  '—'
                )}
              </dd>
              <dt>Public name</dt>
              <dd>{d.public_display_name || d.name}</dd>
              <dt>Record owner</dt>
              <dd>{d.owner_name ?? '—'}</dd>
              <dt>Created</dt>
              <dd>{dateTime(d.created_at)}</dd>
            </dl>
          </section>
          {data.permissions.merge && data.duplicates.length > 0 && !d.merged_into_id && (
            <section className="card">
              <h2>Possible duplicates</h2>
              <ul className="dup-list">
                {data.duplicates.map((x) => (
                  <li key={x.id}>
                    <Link to={`/app/donors/${x.id}`}>{x.name}</Link> <Badge tone={x.score >= 60 ? 'red' : 'amber'}>{x.reasons.join(', ')}</Badge>
                    <div>
                      <button className="btn btn-secondary btn-sm" style={{ marginTop: '0.4rem' }} onClick={() => setMerge(x)}>
                        Merge into this record…
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      {editing && <DonorDialog donor={d} onClose={() => setEditing(false)} onSaved={reload} />}
      <ConfirmDialog
        open={Boolean(merge)}
        title="Merge donors?"
        confirmLabel="Merge"
        danger
        onCancel={() => setMerge(null)}
        onConfirm={() => doAction(() => api.post('/api/donors/merge', { keep_id: d.id, merge_id: merge!.id, confirm: true }), 'Donors merged')}
        message={
          <>
            All donations from <strong>{merge?.name}</strong> (#{merge?.id}) will move to <strong>{d.name}</strong> (#{d.id}). Blank contact fields on this record are filled from the other one. The other record is archived (not deleted)
            and its previous values are kept in history.
          </>
        }
      />
      <ConfirmDialog
        open={confirm === 'archive' || confirm === 'restore'}
        title={confirm === 'archive' ? 'Archive donor?' : 'Restore donor?'}
        confirmLabel={confirm === 'archive' ? 'Archive' : 'Restore'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => doAction(() => api.post(`/api/donors/${d.id}/${confirm}`), confirm === 'archive' ? 'Donor archived' : 'Donor restored')}
        message={confirm === 'archive' ? 'Archived donors are hidden from the directory. Their donations are kept.' : 'The donor will appear in the directory again.'}
      />
      <ConfirmDialog
        open={confirm === 'anonymize'}
        title="Erase this donor's personal information?"
        confirmLabel="Erase personal information"
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={() => doAction(() => api.post(`/api/donors/${d.id}/anonymize`, { confirm: true }), 'Personal information erased').then(() => navigate('/app/donors'))}
        message="Use this for privacy deletion requests. Name, contact details, pickup addresses, history snapshots and submission contact data are permanently removed. Donation amounts are kept anonymously for financial records. This cannot be undone."
      />
    </div>
  );
}
