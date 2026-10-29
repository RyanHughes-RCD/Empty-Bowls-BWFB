import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { PublicLayout, usePublicSettings } from '../../components/PublicLayout';
import { Alert, ErrorAlert, Field, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { useApi } from '../../lib/useApi';

export default function MoreInfo() {
  const { token } = useParams();
  const { data: settings } = usePublicSettings();
  const { data, error, loading } = useApi<{ reference: string; message: string; event_name: string }>(`/api/public/info-request/${encodeURIComponent(token ?? '')}`);
  const [response, setResponse] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!response.trim()) return setSubmitError(new Error('Please enter your response.'));
    setBusy(true);
    setSubmitError(null);
    try {
      const fd = new FormData();
      fd.set('response', response);
      if (image) fd.set('image', image);
      await api.post(`/api/public/info-request/${encodeURIComponent(token ?? '')}`, fd);
      setDone(true);
    } catch (err) {
      setSubmitError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicLayout title="Additional information" narrow settings={settings}>
      {loading ? (
        <Spinner />
      ) : done ? (
        <Alert kind="success" title="Thank you!">
          Your information has been sent to our team. We'll be in touch if we have any other questions.
        </Alert>
      ) : error || !data ? (
        <Alert kind="warning" title="This link is no longer valid">
          It may have expired or already been used. Please contact us directly if you still need to send us information.
        </Alert>
      ) : (
        <form className="card stack" onSubmit={submit}>
          <h1>Additional information requested</h1>
          <p className="muted">
            Submission {data.reference} · {data.event_name}
          </p>
          <div className="note">{data.message}</div>
          <Field id="response" label="Your response" required>
            <textarea id="response" value={response} onChange={(e) => setResponse(e.target.value)} maxLength={5000} required />
          </Field>
          <Field id="image" label="Photo (optional)" hint="JPEG, PNG, WebP or GIF, up to 5 MB">
            <input id="image" type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
          </Field>
          <ErrorAlert error={submitError} />
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Sending…' : 'Send information'}
          </button>
        </form>
      )}
    </PublicLayout>
  );
}
