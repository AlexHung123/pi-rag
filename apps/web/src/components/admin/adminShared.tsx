import React from 'react';

export function formatBytes(n: number) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n === 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDateTime(iso: string) {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return iso;
  }
}

export const CHUNK_METHODS = [
  { value: 'naive', label: 'General' },
  { value: 'manual', label: 'Manual' },
  { value: 'qa', label: 'Q&A' },
  { value: 'table', label: 'Table' },
  { value: 'paper', label: 'Paper' },
  { value: 'book', label: 'Book' },
  { value: 'laws', label: 'Laws' },
  { value: 'presentation', label: 'Presentation' },
  { value: 'picture', label: 'Picture' },
  { value: 'one', label: 'One' },
  { value: 'email', label: 'Email' },
] as const;

export function chunkMethodLabel(value: string) {
  return CHUNK_METHODS.find((m) => m.value === value)?.label || value || '—';
}

export type DocStatus = 'unstart' | 'running' | 'done' | 'fail';

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { className: string; label: string }> = {
    unstart: { className: 'admin-badge muted', label: 'Unstart' },
    running: { className: 'admin-badge info', label: 'Running' },
    done: { className: 'admin-badge success', label: 'Done' },
    fail: { className: 'admin-badge danger', label: 'Fail' },
  };
  const info = map[status] || { className: 'admin-badge muted', label: status };
  return <span className={info.className}>{info.label}</span>;
}

export function ProgressBar({
  progress,
  status,
}: {
  progress: number;
  status: string;
}) {
  const pct = Math.round((progress || 0) * 100);
  const tone =
    status === 'fail' ? 'fail' : status === 'done' ? 'done' : 'active';
  return (
    <div className={`admin-progress admin-progress-${tone}`} title={`${pct}%`}>
      <div className="admin-progress-track">
        <div className="admin-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="admin-progress-label">{pct}%</span>
    </div>
  );
}

export function AdminPagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number, pageSize: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="admin-pagination">
      <span className="admin-pagination-total">Total {total} items</span>
      <div className="admin-pagination-controls">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onChange(page - 1, pageSize)}
        >
          ‹
        </button>
        <span>
          {page} / {totalPages}
        </span>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1, pageSize)}
        >
          ›
        </button>
        <select
          value={pageSize}
          onChange={(e) => onChange(1, Number(e.target.value))}
          aria-label="Page size"
        >
          {[10, 20, 50].map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function AdminShell({
  title,
  children,
  toolbar,
  error,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  toolbar?: React.ReactNode;
  error?: string;
}) {
  return (
    <div className="admin-page">
      <header className="admin-page-header">
        <h1 className="admin-page-title">{title}</h1>
        <p className="admin-page-hint">System administration — not the end-user workspace.</p>
      </header>
      {error ? <p className="error-text admin-error">{error}</p> : null}
      <div className="admin-card">
        {toolbar ? <div className="admin-toolbar">{toolbar}</div> : null}
        {children}
      </div>
    </div>
  );
}

export function CountTag({
  value,
  tone = 'blue',
}: {
  value: number;
  tone?: 'blue' | 'green' | 'purple' | 'cyan';
}) {
  return <span className={`admin-count-tag admin-count-${tone}`}>{value}</span>;
}
