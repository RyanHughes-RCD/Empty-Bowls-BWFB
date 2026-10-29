import { useEffect, useState } from 'react';
import { Alert, Badge, ConfirmDialog, ErrorAlert, Field, PageHeader, Spinner, fieldErrors, useToast } from '../components/ui';
import { api } from '../lib/api';
import { type StatusRow, useStatuses } from '../lib/data';
import { dateTime } from '../lib/format';
import { useApi } from '../lib/useApi';

type Settings = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export default function SettingsPage() {
  const { data, error, loading, setData } = useApi<{ settings: Settings; system: { emailConfigured: boolean } }>('/api/settings');
  const [form, setForm] = useState<Settings | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [retention, setRetention] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (data && !form) setForm({ ...data.settings, notify_extra_emails: data.settings.notify_extra_emails.join(', ') });
  }, [data, form]);
  if (loading || !form) return error ? <ErrorAlert error={error} /> : <Spinner />;
  const errs = fieldErrors(saveError);

  const save = async () => {
    setSaveError(null);
    try {
      const r = await api.put<typeof data>('/api/settings', {
        ...form,
        declined_retention_days: Number(form.declined_retention_days),
        notify_extra_emails: String(form.notify_extra_emails)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setData(r);
      toast('Settings saved');
    } catch (e) {
      setSaveError(e);
    }
  };
  const text = (k: string, label: string, opts: { area?: boolean; hint?: string; rows?: number } = {}) => (
    <Field id={`s-${k}`} label={label} hint={opts.hint} error={errs[k]}>
      {opts.area ? (
        <textarea id={`s-${k}`} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} style={{ minHeight: (opts.rows ?? 4) * 24 }} />
      ) : (
        <input id={`s-${k}`} type="text" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
      )}
    </Field>
  );
  const check = (k: string, label: string) => (
    <label className="checkbox">
      <input type="checkbox" checked={Boolean(form[k])} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} />
      <span>{label}</span>
    </label>
  );

  return (
    <div className="stack">
      <PageHeader title="Settings" actions={<button className="btn btn-primary" onClick={save}>Save settings</button>} />
      <ErrorAlert error={saveError} />
      <section className="card stack">
        <h2>Charity</h2>
        {text('charity_name', 'Charity / auction name')}
        {text('charity_contact_email', 'Public contact email', { hint: 'Shown on public pages and used as the reply-to address' })}
      </section>
      <section className="card stack">
        <h2>Donation form</h2>
        {check('submissions_enabled', 'Accept public donation submissions')}
        {check('image_uploads_enabled', 'Allow donors to upload a photo')}
        {text('privacy_notice', 'Privacy notice', { area: true, rows: 7, hint: 'Shown on the donation form. Review it with your privacy advisor; this application does not by itself make you compliant with PIPEDA or provincial privacy law.' })}
        {text('recognition_notice', 'Public recognition explanation', { area: true })}
        {text('submission_confirmation_message', 'Confirmation message after submitting', { area: true, rows: 3 })}
      </section>
      <section className="card stack">
        <h2>Email & notifications</h2>
        {data!.system.emailConfigured ? (
          <Alert kind="success">Email sending is configured.</Alert>
        ) : (
          <Alert kind="warning">Email sending is not configured (set the SMTP_* environment variables). Notifications appear in the app only, and thank-yous must be sent manually and then confirmed.</Alert>
        )}
        {check('send_donor_confirmation_email', 'Email donors a confirmation with their reference number')}
        {text('notify_extra_emails', 'Also notify these addresses about new submissions', { hint: 'Comma separated. Users who can review submissions are always notified.' })}
        {text('thank_you_subject_template', 'Thank-you subject template')}
        {text('thank_you_body_template', 'Thank-you message template', { area: true, rows: 8, hint: 'Placeholders: {{contact_name}} {{donor_name}} {{donation_description}} {{event_name}} {{charity_name}} {{sender_name}}' })}
      </section>
      <section className="card stack">
        <h2>Public gallery</h2>
        {text('gallery_title', 'Gallery title')}
        {text('gallery_intro', 'Introduction', { area: true, rows: 3 })}
        {check('gallery_show_totals', 'Show number of donations and total disclosed value')}
      </section>
      <section className="card stack">
        <h2>Data retention</h2>
        <Field id="s-ret" label="Remove personal information from declined or withdrawn submissions after (days)" error={errs.declined_retention_days}>
          <input id="s-ret" type="number" min={30} max={3650} value={form.declined_retention_days} onChange={(e) => setForm({ ...form, declined_retention_days: e.target.value })} />
        </Field>
        <div>
          <button className="btn btn-secondary" onClick={() => setRetention(true)}>
            Run retention cleanup now
          </button>
        </div>
        <p className="muted small">Use “Erase personal info” on a donor record to handle individual deletion requests. Use your hosting provider's automated database backups for recovery.</p>
      </section>
      <StatusesCard />
      <EmailLog />
      <div>
        <button className="btn btn-primary" onClick={save}>
          Save settings
        </button>
      </div>
      <ConfirmDialog
        open={retention}
        title="Run data retention cleanup?"
        confirmLabel="Run cleanup"
        danger
        onCancel={() => setRetention(false)}
        onConfirm={async () => {
          const r = await api.post<{ redactedSubmissions: number; deletedImages: number }>('/api/settings/retention/run', { confirm: true });
          toast(`Removed personal data from ${r.redactedSubmissions} submission(s) and ${r.deletedImages} image(s)`);
          setRetention(false);
        }}
        message={`Personal information in declined/withdrawn submissions older than ${form.declined_retention_days} days will be permanently removed. Approved donations are not affected.`}
      />
    </div>
  );
}

function StatusesCard() {
  const { data, reload } = useStatuses();
  const [error, setError] = useState<unknown>(null);
  const [n, setN] = useState({ code: '', label: '', sort_order: '200', publishable: false, counts_as_approved: true });
  const update = async (s: StatusRow, body: Partial<StatusRow>) => {
    try {
      await api.patch(`/api/statuses/${s.code}`, body);
      reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <section className="card stack">
      <h2>Donation statuses</h2>
      <p className="muted small">Rename or reorder statuses to match how your team works. Built-in statuses cannot be removed. Publication is managed separately from status.</p>
      <ErrorAlert error={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Order</th>
              <th>Counts as approved</th>
              <th>Can be published</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((s) => (
              <tr key={s.code}>
                <td>
                  <input aria-label={`Label for ${s.code}`} type="text" defaultValue={s.label} onBlur={(e) => e.target.value !== s.label && update(s, { label: e.target.value })} />
                  <div className="muted small">
                    <code>{s.code}</code> {s.is_system && <Badge>built-in</Badge>}
                  </div>
                </td>
                <td>
                  <input aria-label={`Order for ${s.code}`} type="number" defaultValue={s.sort_order} style={{ width: 90 }} onBlur={(e) => Number(e.target.value) !== s.sort_order && update(s, { sort_order: Number(e.target.value) })} />
                </td>
                <td>{s.counts_as_approved ? 'Yes' : 'No'}</td>
                <td>{s.publishable ? 'Yes' : 'No'}</td>
                <td>
                  {s.is_system ? (
                    'Yes'
                  ) : (
                    <input type="checkbox" aria-label={`Active ${s.code}`} checked={s.is_active} onChange={(e) => update(s, { is_active: e.target.checked })} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Add a status</h3>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field id="ns-label" label="Label">
          <input id="ns-label" type="text" value={n.label} onChange={(e) => setN({ ...n, label: e.target.value, code: e.target.value.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '') })} />
        </Field>
        <Field id="ns-order" label="Order">
          <input id="ns-order" type="number" value={n.sort_order} onChange={(e) => setN({ ...n, sort_order: e.target.value })} style={{ width: 100 }} />
        </Field>
        <label className="checkbox">
          <input type="checkbox" checked={n.counts_as_approved} onChange={(e) => setN({ ...n, counts_as_approved: e.target.checked })} />
          <span>Counts as approved</span>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={n.publishable} onChange={(e) => setN({ ...n, publishable: e.target.checked })} />
          <span>Can be published</span>
        </label>
        <button
          className="btn btn-secondary"
          disabled={!n.code}
          onClick={async () => {
            try {
              await api.post('/api/statuses', { ...n, sort_order: Number(n.sort_order) });
              setN({ code: '', label: '', sort_order: '200', publishable: false, counts_as_approved: true });
              reload();
            } catch (e) {
              setError(e);
            }
          }}
        >
          Add status
        </button>
      </div>
    </section>
  );
}

function EmailLog() {
  const { data } = useApi<{ id: number; recipient: string; subject: string; purpose: string; status: string; error: string | null; created_at: string }[]>('/api/email-log');
  return (
    <details className="card">
      <summary>
        <strong>Recent outgoing email</strong>
      </summary>
      {!data?.length ? (
        <p className="muted">No emails yet.</p>
      ) : (
        <div className="table-wrap" style={{ marginTop: '0.75rem' }}>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>To</th>
                <th>Subject</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{dateTime(e.created_at)}</td>
                  <td>{e.recipient}</td>
                  <td>{e.subject}</td>
                  <td>
                    <Badge tone={e.status === 'sent' ? 'green' : e.status === 'failed' ? 'red' : 'gray'}>{e.status.replace('_', ' ')}</Badge>
                    {e.error && <div className="small muted">{e.error}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
