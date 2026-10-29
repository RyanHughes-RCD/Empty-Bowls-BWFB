import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Alert, ErrorAlert, Field, Spinner, fieldErrors, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

export default function ChangePassword() {
  const { user, loading, refresh } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError(new Error('The new passwords do not match.'));
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/change-password', { current_password: current, new_password: next });
      await refresh();
      toast('Password changed.');
      navigate('/app');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const errs = fieldErrors(error);
  return (
    <main className="login-wrap" id="main">
      <form className="card stack" onSubmit={submit}>
        <h1>Change password</h1>
        {user.mustChangePassword && <Alert kind="info">You signed in with a temporary password. Please choose your own password to continue.</Alert>}
        <ErrorAlert error={error} />
        <Field id="current" label="Current password">
          <input id="current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <Field id="new" label="New password" hint="At least 12 characters. A short sentence is easy to remember." error={errs.new_password}>
          <input id="new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
        </Field>
        <Field id="confirm" label="Confirm new password">
          <input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </Field>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
        {!user.mustChangePassword && (
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/app')}>
            Cancel
          </button>
        )}
      </form>
    </main>
  );
}
