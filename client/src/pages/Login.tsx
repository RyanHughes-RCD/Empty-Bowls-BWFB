import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ErrorAlert, Field } from '../components/ui';
import { useAuth } from '../lib/auth';

export default function Login() {
  const { user, login } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get('next');
  const safeNext = next && next.startsWith('/app') ? next : '/app';

  if (user) return <Navigate to={user.mustChangePassword ? '/change-password' : safeNext} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await login(email, password);
      navigate(u.mustChangePassword ? '/change-password' : safeNext, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-wrap" id="main">
      <form className="card stack" onSubmit={submit}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2.5rem' }} aria-hidden="true">
            🥣
          </div>
          <h1>Staff sign in</h1>
          <p className="muted">For charity staff and volunteers.</p>
        </div>
        <ErrorAlert error={error} />
        <Field id="email" label="Email">
          <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field id="password" label="Password">
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted small" style={{ textAlign: 'center' }}>
          Forgot your password? Ask an administrator to reset it. <br />
          Donors: <a href="/submit">submit a donation here</a>.
        </p>
      </form>
    </main>
  );
}
