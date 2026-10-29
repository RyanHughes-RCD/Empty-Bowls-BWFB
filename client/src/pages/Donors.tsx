import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorAlert, Field, Modal, PageHeader, Pagination, Spinner, fieldErrors, useToast } from '../components/ui';
import { ApiError, api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { useApi } from '../lib/useApi';

interface DonorRow {
  id: number;
  name: string;
  donor_type: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  website: string | null;
  owner_name: string | null;
  donation_count: number;
  total_value: number;
  contact_hidden?: boolean;
}

export default function Donors() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [adding, setAdding] = useState(false);
  const page = Number(params.get('page') ?? 1);
  const sort = params.get('sort') ?? 'name';
  const archived = params.get('archived') ?? 'false';
  const { data, error, loading } = useApi<{ rows: DonorRow[]; total: number; pageSize: number }>(
    `/api/donors${qs({ q: params.get('q'), page, sort, dir: sort === 'name' ? 'asc' : 'desc', archived })}`,
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
        title="Donor Directory"
        subtitle="One record per business, individual or organization."
        actions={
          <>
            {can('exports.run') && (
              <a className="btn btn-secondary" href="/api/donors/export.csv">
                ⬇ Export CSV
              </a>
            )}
            {can('donors.merge') && (
              <Link className="btn btn-secondary" to="/app/donors/duplicates">
                Find duplicates
              </Link>
            )}
            {can('donors.create') && (
              <button className="btn btn-primary" onClick={() => setAdding(true)}>
                + New donor
              </button>
            )}
          </>
        }
      />
      <div className="filters" role="search">
        <div className="field" style={{ flex: '2 1 240px' }}>
          <label htmlFor="dn-q">Search</label>
          <input id="dn-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, contact, email or phone" />
        </div>
        <div className="field">
          <label htmlFor="dn-sort">Sort by</label>
          <select id="dn-sort" value={sort} onChange={(e) => set('sort', e.target.value)}>
            <option value="name">Name</option>
            <option value="donations">Number of donations</option>
            <option value="value">Total value</option>
            <option value="created_at">Newest</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="dn-arch">Show</label>
          <select id="dn-arch" value={archived} onChange={(e) => set('archived', e.target.value)}>
            <option value="false">Active donors</option>
            <option value="true">Archived / merged</option>
          </select>
        </div>
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? (
        <Spinner />
      ) : !data?.rows.length ? (
        <EmptyState title="No donors found" icon="👥" />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>DonorID</th>
                  <th>Business / Donor / Org</th>
                  <th>Contact</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Record owner</th>
                  <th>Donations</th>
                  <th>Total value</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((d) => (
                  <tr key={d.id}>
                    <td>#{d.id}</td>
                    <td>
                      <Link to={`/app/donors/${d.id}`}>{d.name}</Link>
                    </td>
                    {d.contact_hidden ? (
                      <td colSpan={3} className="muted small">
                        Contact details restricted
                      </td>
                    ) : (
                      <>
                        <td>{d.contact_name ?? '—'}</td>
                        <td>{d.contact_email ?? '—'}</td>
                        <td className="nowrap">{d.contact_phone ?? '—'}</td>
                      </>
                    )}
                    <td>{d.owner_name ?? '—'}</td>
                    <td>{d.donation_count}</td>
                    <td>{money(d.total_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={(p) => set('page', String(p))} />
        </>
      )}
      {adding && <DonorDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

export function DonorDialog({ onClose, donor, onSaved }: { onClose: () => void; donor?: Record<string, any>; onSaved?: () => void }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const toast = useToast();
  const navigate = useNavigate();
  const { data: users } = useApi<{ id: number; name: string }[]>('/api/users/options');
  const [f, setF] = useState({
    name: donor?.name ?? '',
    donor_type: donor?.donor_type ?? 'business',
    contact_name: donor?.contact_name ?? '',
    contact_email: donor?.contact_email ?? '',
    contact_phone: donor?.contact_phone ?? '',
    website: donor?.website ?? '',
    social: (donor?.social_media ?? []).map((s: { handle: string }) => s.handle).join(', '),
    public_display_name: donor?.public_display_name ?? '',
    owner_id: donor?.owner_id ?? '',
  });
  const [error, setError] = useState<unknown>(null);
  const [dups, setDups] = useState<{ id: number; name: string; reasons: string[] }[] | null>(null);
  const save = async (confirm = false) => {
    const body = {
      name: f.name,
      donor_type: f.donor_type,
      contact_name: f.contact_name,
      contact_email: f.contact_email,
      contact_phone: f.contact_phone,
      website: f.website,
      public_display_name: f.public_display_name,
      owner_id: f.owner_id || null,
      social_media: f.social
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean)
        .map((handle: string) => ({ platform: 'Handle', handle })),
    };
    try {
      if (donor) {
        await api.patch(`/api/donors/${donor.id}`, body);
        toast('Donor updated');
        onSaved?.();
        onClose();
      } else {
        const r = await api.post<{ id: number }>('/api/donors', { ...body, confirm_not_duplicate: confirm });
        toast('Donor created');
        navigate(`/app/donors/${r.id}`);
      }
    } catch (e) {
      if ((e as ApiError).status === 409 && (e as ApiError).details?.duplicates) setDups((e as ApiError).details!.duplicates as never);
      else setError(e);
    }
  };
  const errs = fieldErrors(error);
  return (
    <Modal open title={donor ? 'Edit donor' : 'New donor'} onClose={onClose} wide>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <Field id="dd-name" label="Business, donor or organization name" required error={errs.name}>
            <input id="dd-name" type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field id="dd-type" label="Type">
            <select id="dd-type" value={f.donor_type} onChange={(e) => setF({ ...f, donor_type: e.target.value })}>
              <option value="business">Business</option>
              <option value="individual">Individual</option>
              <option value="organization">Organization</option>
            </select>
          </Field>
          <Field id="dd-cn" label="Contact name" error={errs.contact_name}>
            <input id="dd-cn" type="text" value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} />
          </Field>
          <Field id="dd-ce" label="Contact email" error={errs.contact_email}>
            <input id="dd-ce" type="email" value={f.contact_email} onChange={(e) => setF({ ...f, contact_email: e.target.value })} />
          </Field>
          <Field id="dd-cp" label="Contact phone" error={errs.contact_phone}>
            <input id="dd-cp" type="tel" value={f.contact_phone} onChange={(e) => setF({ ...f, contact_phone: e.target.value })} />
          </Field>
          <Field id="dd-web" label="Business website" error={errs.website}>
            <input id="dd-web" type="text" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} />
          </Field>
          <Field id="dd-soc" label="Social media (comma separated)" error={errs.social_media}>
            <input id="dd-soc" type="text" value={f.social} onChange={(e) => setF({ ...f, social: e.target.value })} />
          </Field>
          <Field id="dd-pub" label="Public display name" hint="Optional name to use on the public gallery">
            <input id="dd-pub" type="text" value={f.public_display_name} onChange={(e) => setF({ ...f, public_display_name: e.target.value })} />
          </Field>
          <Field id="dd-owner" label="Record owner" hint="User responsible for this donor relationship">
            <select id="dd-owner" value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: e.target.value ? Number(e.target.value) : '' })}>
              <option value="">None</option>
              {(users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {dups && (
          <div className="alert alert-warning">
            <strong>Possible duplicates:</strong>
            <ul>
              {dups.map((d) => (
                <li key={d.id}>
                  <Link to={`/app/donors/${d.id}`} onClick={onClose}>
                    {d.name}
                  </Link>{' '}
                  — {d.reasons.join(', ')}
                </li>
              ))}
            </ul>
            <button className="btn btn-secondary btn-sm" onClick={() => save(true)}>
              Create anyway — this is a different donor
            </button>
          </div>
        )}
        <div className="button-row">
          <button className="btn btn-primary" onClick={() => save()}>
            Save
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
