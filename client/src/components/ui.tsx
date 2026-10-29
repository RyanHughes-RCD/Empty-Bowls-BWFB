import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { PUBLICATION_LABELS, SUBMISSION_STATUS_LABELS } from '../lib/format';

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Alert({ kind = 'info', children, title }: { kind?: 'info' | 'success' | 'error' | 'warning'; children: ReactNode; title?: string }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {title && <strong className="alert-title">{title}</strong>}
      <div>{children}</div>
    </div>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <Alert kind="error">
      {e.message || 'Something went wrong.'}
      {e.details?.problems && (
        <ul>
          {e.details.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'green' | 'blue' | 'amber' | 'red' | 'purple' | 'gray'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const STATUS_TONES: Record<string, 'neutral' | 'green' | 'blue' | 'amber' | 'red' | 'purple' | 'gray'> = {
  new_submission: 'blue',
  pending_review: 'blue',
  awaiting_donor_info: 'amber',
  approved: 'green',
  declined: 'red',
  follow_up_required: 'amber',
  confirmed: 'green',
  pickup_scheduled: 'purple',
  item_received: 'green',
  thank_you_pending: 'amber',
  complete: 'gray',
};

export function StatusBadge({ code, label }: { code: string; label?: string }) {
  return <Badge tone={STATUS_TONES[code] ?? 'neutral'}>{label ?? code}</Badge>;
}

export function PublicationBadge({ status }: { status: string }) {
  const tone = status === 'published' ? 'green' : status === 'pending_publication_approval' ? 'amber' : status === 'withdrawn' ? 'red' : 'gray';
  return <Badge tone={tone}>{PUBLICATION_LABELS[status] ?? status}</Badge>;
}

export function SubmissionBadge({ status }: { status: string }) {
  const tone = status === 'approved' ? 'green' : status === 'declined' ? 'red' : status === 'awaiting_donor_info' ? 'amber' : 'blue';
  return <Badge tone={tone}>{SUBMISSION_STATUS_LABELS[status] ?? status}</Badge>;
}

export function YesNo({ value }: { value: boolean }) {
  return value ? <Badge tone="green">Yes</Badge> : <Badge tone="gray">No</Badge>;
}

export function EmptyState({ title, children, icon = '🥣' }: { title: string; children?: ReactNode; icon?: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      <h3>{title}</h3>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · Donations`;
  }, [title]);
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return <p className="muted small">{total} record{total === 1 ? '' : 's'}</p>;
  return (
    <nav className="pagination" aria-label="Pagination">
      <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Previous
      </button>
      <span>
        Page {page} of {pages} · {total} records
      </span>
      <button className="btn btn-secondary btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next →
      </button>
    </nav>
  );
}

/** Accessible modal dialog (focus trapped by native <dialog>). */
export function Modal({ open, title, onClose, children, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} aria-labelledby={titleId} onClose={onClose} onCancel={onClose}>
      {open && (
        <>
          <div className="modal-header">
            <h2 id={titleId}>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Close dialog">
              ✕
            </button>
          </div>
          <div className="modal-body">{children}</div>
        </>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  onCancel,
  busy,
  children,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <div className="stack">
        <div>{message}</div>
        {children}
        <div className="button-row">
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
          <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Labelled form field with error and hint text wired up for screen readers. */
export function Field({
  label,
  error,
  hint,
  required,
  children,
  id,
}: {
  label: ReactNode;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  id: string;
  children: ReactNode;
}) {
  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <label htmlFor={id}>
        {label}
        {required && (
          <span className="required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {hint && (
        <div className="hint" id={`${id}-hint`}>
          {hint}
        </div>
      )}
      {children}
      {error && (
        <div className="field-error" id={`${id}-error`} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function describedBy(id: string, error?: string, hint?: boolean) {
  return [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
}
const ToastContext = createContext<(text: string, kind?: Toast['kind']) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);

export function fieldErrors(e: unknown): Record<string, string> {
  return ((e as ApiError)?.details?.fields as Record<string, string>) ?? {};
}
