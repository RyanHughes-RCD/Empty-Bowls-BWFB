import { useState } from 'react';
import { Alert, Badge, ConfirmDialog, ErrorAlert, Field, Modal, PageHeader, Spinner, fieldErrors, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { useApi } from '../lib/useApi';

interface UserRow {
  id: number;
  name: string;
  email: string;
  role: string;
  roleLabel: string;
  account_status: string;
  must_change_password: boolean;
  last_login_at: string | null;
  locked_until: string | null;
  overrides: { permission: string; granted: boolean }[];
  effectivePermissions: string[];
}
interface Catalog {
  permissions: Record<string, string>;
  roleDefaults: Record<string, string[]>;
  roleLabels: Record<string, string>;
  roles: string[];
}

const ADMIN_ONLY = ['users.manage_all', 'settings.manage', 'audit.view', 'donors.delete'];

export default function Users() {
  const { user: me, can } = useAuth();
  const all = can('users.manage_all');
  const { data, error, loading, reload } = useApi<UserRow[]>('/api/users');
  const { data: catalog } = useApi<Catalog>('/api/permissions/catalog');
  const [editing, setEditing] = useState<Partial<UserRow> | null>(null);
  const [perms, setPerms] = useState<UserRow | null>(null);
  const [tempPw, setTempPw] = useState<{ email: string; password: string } | null>(null);
  const [reset, setReset] = useState<UserRow | null>(null);
  const toast = useToast();
  const manageable = (u: UserRow) => all || ['owner', 'volunteer'].includes(u.role);

  return (
    <div className="stack">
      <PageHeader
        title="Users and Permissions"
        subtitle={all ? 'Add staff and volunteers, choose their role, and fine-tune individual permissions.' : 'You can add and manage Record Owner and Volunteer accounts.'}
        actions={
          <button className="btn btn-primary" onClick={() => setEditing({ role: 'volunteer' })}>
            + Add user
          </button>
        }
      />
      {tempPw && (
        <Alert kind="success" title="Temporary password">
          Give this temporary password to <strong>{tempPw.email}</strong> in person or by phone. It is shown only once, and they must change it when they first sign in:{' '}
          <code style={{ fontSize: '1.1rem' }}>{tempPw.password}</code>{' '}
          <button className="btn-link" onClick={() => navigator.clipboard?.writeText(tempPw.password)}>
            copy
          </button>
        </Alert>
      )}
      <ErrorAlert error={error} />
      {loading && !data ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last sign-in</th>
                <th>Custom permissions</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.name} {u.id === me?.id && <Badge>You</Badge>}
                  </td>
                  <td>{u.email}</td>
                  <td>{u.roleLabel}</td>
                  <td>
                    <Badge tone={u.account_status === 'active' ? 'green' : 'red'}>{u.account_status}</Badge>
                    {u.must_change_password && <div className="muted small">Temporary password</div>}
                    {u.locked_until && new Date(u.locked_until) > new Date() && <div className="badge badge-red">Locked</div>}
                  </td>
                  <td>{dateTime(u.last_login_at)}</td>
                  <td className="small">
                    {u.overrides.length === 0
                      ? '—'
                      : u.overrides.map((o) => (
                          <div key={o.permission}>
                            {o.granted ? '+' : '−'} {catalog?.permissions[o.permission] ?? o.permission}
                          </div>
                        ))}
                  </td>
                  <td>
                    {manageable(u) && u.id !== me?.id && (
                      <div className="button-row">
                        <button className="btn btn-secondary btn-sm" onClick={() => setEditing(u)}>
                          Edit
                        </button>
                        {all && u.role !== 'super_admin' && (
                          <button className="btn btn-secondary btn-sm" onClick={() => setPerms(u)}>
                            Permissions
                          </button>
                        )}
                        <button className="btn btn-secondary btn-sm" onClick={() => setReset(u)}>
                          Reset password
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {catalog && (
        <details className="card">
          <summary>
            <strong>What can each role do?</strong>
          </summary>
          <div className="table-wrap" style={{ marginTop: '0.75rem' }}>
            <table>
              <thead>
                <tr>
                  <th>Permission</th>
                  {catalog.roles.map((r) => (
                    <th key={r}>{catalog.roleLabels[r]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(catalog.permissions).map(([k, label]) => (
                  <tr key={k}>
                    <td>{label}</td>
                    {catalog.roles.map((r) => (
                      <td key={r}>{catalog.roleDefaults[r].includes(k) ? '✓' : ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {editing && (
        <UserDialog
          user={editing}
          roles={all ? (catalog?.roles ?? []) : ['owner', 'volunteer']}
          labels={catalog?.roleLabels ?? {}}
          onClose={() => setEditing(null)}
          onSaved={(pw) => {
            reload();
            if (pw) setTempPw(pw);
          }}
        />
      )}
      {perms && catalog && <PermissionsDialog user={perms} catalog={catalog} onClose={() => setPerms(null)} onSaved={reload} />}
      <ConfirmDialog
        open={Boolean(reset)}
        title={`Reset password for ${reset?.name}?`}
        confirmLabel="Reset password"
        onCancel={() => setReset(null)}
        onConfirm={async () => {
          const r = await api.post<{ temporaryPassword: string }>(`/api/users/${reset!.id}/reset-password`);
          setTempPw({ email: reset!.email, password: r.temporaryPassword });
          setReset(null);
          toast('Password reset');
          reload();
        }}
        message="They will be signed out everywhere and must choose a new password with the temporary one."
      />
    </div>
  );
}

function UserDialog({ user, roles, labels, onClose, onSaved }: { user: Partial<UserRow>; roles: string[]; labels: Record<string, string>; onClose: () => void; onSaved: (pw?: { email: string; password: string }) => void }) {
  const [f, setF] = useState({ name: user.name ?? '', email: user.email ?? '', role: user.role ?? 'volunteer', account_status: user.account_status ?? 'active' });
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const errs = fieldErrors(error);
  const save = async () => {
    try {
      if (user.id) {
        await api.patch(`/api/users/${user.id}`, { ...f, unlock: true });
        toast('User updated');
        onSaved();
      } else {
        const r = await api.post<{ temporaryPassword: string }>('/api/users', { name: f.name, email: f.email, role: f.role });
        onSaved({ email: f.email, password: r.temporaryPassword });
      }
      onClose();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal open title={user.id ? `Edit ${user.name}` : 'Add user'} onClose={onClose}>
      <div className="stack">
        <ErrorAlert error={error} />
        <Field id="u-name" label="Name" required error={errs.name}>
          <input id="u-name" type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field id="u-email" label="Email (used to sign in)" required error={errs.email}>
          <input id="u-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field id="u-role" label="Role">
          <select id="u-role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {labels[r] ?? r}
              </option>
            ))}
          </select>
        </Field>
        {user.id && (
          <Field id="u-status" label="Account status">
            <select id="u-status" value={f.account_status} onChange={(e) => setF({ ...f, account_status: e.target.value })}>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="deactivated">Deactivated</option>
            </select>
          </Field>
        )}
        {!user.id && <p className="muted small">A temporary password will be generated. The user must change it when they first sign in.</p>}
        <div className="button-row">
          <button className="btn btn-primary" onClick={save}>
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

function PermissionsDialog({ user, catalog, onClose, onSaved }: { user: UserRow; catalog: Catalog; onClose: () => void; onSaved: () => void }) {
  const defaults = new Set(catalog.roleDefaults[user.role]);
  const [eff, setEff] = useState(new Set(user.effectivePermissions));
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const save = async () => {
    try {
      const overrides = Object.keys(catalog.permissions)
        .filter((p) => eff.has(p) !== defaults.has(p))
        .map((p) => ({ permission: p, granted: eff.has(p) }));
      await api.put(`/api/users/${user.id}/permissions`, { overrides });
      toast('Permissions saved');
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal open title={`Permissions for ${user.name} (${user.roleLabel})`} onClose={onClose} wide>
      <div className="stack">
        <p className="muted">Ticked boxes are what this user can do. Items marked “changed” differ from the {user.roleLabel} defaults.</p>
        <ErrorAlert error={error} />
        <div className="grid-2">
          {Object.entries(catalog.permissions).map(([p, label]) => {
            const blocked = ADMIN_ONLY.includes(p) || (p === 'users.manage' && user.role !== 'admin');
            return (
              <label key={p} className="checkbox">
                <input
                  type="checkbox"
                  checked={eff.has(p)}
                  disabled={blocked && !eff.has(p)}
                  onChange={(e) => {
                    const n = new Set(eff);
                    if (e.target.checked) n.add(p);
                    else n.delete(p);
                    setEff(n);
                  }}
                />
                <span>
                  {label} {eff.has(p) !== defaults.has(p) && <Badge tone="amber">changed</Badge>}
                  {blocked && !eff.has(p) && <span className="muted small"> (Super Admin only)</span>}
                </span>
              </label>
            );
          })}
        </div>
        <div className="button-row">
          <button className="btn btn-primary" onClick={save}>
            Save permissions
          </button>
          <button className="btn btn-secondary" onClick={() => setEff(new Set(defaults))}>
            Reset to role defaults
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
