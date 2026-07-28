import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { adminApi, type AdminDocument } from '../../services/api';
import {
  AdminPagination,
  AdminShell,
  ProgressBar,
  StatusBadge,
  formatBytes,
  formatDateTime,
} from './adminShared';

type Props = {
  dataset: { id: string; name: string } | null;
  onBack: () => void;
};

export default function AdminDocumentsPanel({ dataset, onBack }: Props) {
  const [items, setItems] = useState<AdminDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [keywords, setKeywords] = useState('');
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState({ keywords: '', status: '' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!dataset) return;
    setLoading(true);
    setError('');
    try {
      const res = await adminApi.listDocuments(dataset.id, {
        page,
        pageSize,
        keywords: applied.keywords || undefined,
        status: applied.status || undefined,
      });
      setItems(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [dataset, page, pageSize, applied]);

  useEffect(() => {
    setPage(1);
    setSelected(new Set());
    setKeywords('');
    setStatus('');
    setApplied({ keywords: '', status: '' });
  }, [dataset?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    const hasRunning = items.some((d) => d.status === 'running');
    if (hasRunning && dataset) {
      pollRef.current = setInterval(() => {
        void load();
      }, 3000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [items, dataset, load]);

  if (!dataset) {
    return (
      <AdminShell title="Administration Documents">
        <div className="admin-empty-state">
          <p>
            Select a knowledge base from Administration Knowledge Bases to view
            its documents.
          </p>
          <button type="button" className="admin-btn primary" onClick={onBack}>
            Go to Administration Knowledge Bases
          </button>
        </div>
      </AdminShell>
    );
  }

  const onSearch = () => {
    setPage(1);
    setApplied({ keywords, status });
  };

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(items.map((i) => i.id)) : new Set());
  };

  const toggleOne = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const parseableIds = [...selected].filter((id) => {
    const d = items.find((x) => x.id === id);
    return d && (d.status === 'unstart' || d.status === 'fail');
  });
  const runningIds = [...selected].filter((id) => {
    const d = items.find((x) => x.id === id);
    return d && d.status === 'running';
  });

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    await run(async () => {
      for (const file of Array.from(files)) {
        await adminApi.uploadDocument(dataset.id, file);
      }
    });
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <AdminShell
      title={
        <span className="admin-title-with-back">
          <button
            type="button"
            className="admin-icon-btn"
            onClick={onBack}
            aria-label="Back to Administration Knowledge Bases"
          >
            <ArrowLeft size={18} />
          </button>
          <span>
            Administration Documents
            <span className="admin-title-sub"> · {dataset.name}</span>
          </span>
        </span>
      }
      error={error}
      toolbar={
        <>
          <div className="admin-toolbar-left">
            <label className="admin-field">
              <Search size={14} />
              <input
                placeholder="Search by filename"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onSearch()}
              />
            </label>
            <select
              className="admin-select"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
                setApplied({ keywords, status: e.target.value });
              }}
            >
              <option value="">Status</option>
              <option value="unstart">Unstart</option>
              <option value="running">Running</option>
              <option value="done">Done</option>
              <option value="fail">Fail</option>
            </select>
            <button type="button" className="admin-btn" onClick={onSearch}>
              <Search size={15} /> Search
            </button>
          </div>
          <div className="admin-toolbar-right">
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => void onUpload(e.target.files)}
            />
            <button
              type="button"
              className="admin-btn primary"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={15} /> Upload
            </button>
            <button
              type="button"
              className="admin-btn"
              disabled={!parseableIds.length || busy}
              onClick={() =>
                void run(() => adminApi.parseDocuments(dataset.id, parseableIds))
              }
            >
              <PlayCircle size={15} /> Parse ({parseableIds.length})
            </button>
            <button
              type="button"
              className="admin-btn"
              disabled={!runningIds.length || busy}
              onClick={() =>
                void run(() =>
                  adminApi.stopParseDocuments(dataset.id, runningIds),
                )
              }
            >
              <PauseCircle size={15} /> Stop
            </button>
            <button
              type="button"
              className="admin-btn"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw size={15} /> Refresh
            </button>
            <button
              type="button"
              className="admin-btn danger"
              disabled={!selected.size || busy}
              onClick={() => {
                if (
                  !window.confirm(
                    `Delete ${selected.size} document(s)? This cannot be undone.`,
                  )
                ) {
                  return;
                }
                void run(() =>
                  adminApi.batchDeleteDocuments(dataset.id, [...selected]),
                );
              }}
            >
              <Trash2 size={15} /> Batch Delete ({selected.size})
            </button>
          </div>
        </>
      }
    >
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th className="admin-col-check">
                <input
                  type="checkbox"
                  checked={items.length > 0 && selected.size === items.length}
                  onChange={(e) => toggleAll(e.target.checked)}
                  aria-label="Select all"
                />
              </th>
              <th>Name</th>
              <th>Size</th>
              <th>Chunks</th>
              <th>Tokens</th>
              <th>Progress</th>
              <th>Status</th>
              <th>Created</th>
              <th className="admin-col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && !items.length ? (
              <tr>
                <td colSpan={9} className="admin-empty">
                  Loading…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={9} className="admin-empty">
                  No documents found
                </td>
              </tr>
            ) : (
              items.map((row) => (
                <tr key={row.id}>
                  <td className="admin-col-check">
                    <input
                      type="checkbox"
                      checked={selected.has(row.id)}
                      onChange={(e) => toggleOne(row.id, e.target.checked)}
                      aria-label={`Select ${row.name}`}
                    />
                  </td>
                  <td className="admin-cell-name" title={row.name}>
                    {row.name}
                  </td>
                  <td>{formatBytes(row.sizeBytes)}</td>
                  <td>{row.chunkCount}</td>
                  <td>—</td>
                  <td>
                    <ProgressBar progress={row.progress} status={row.status} />
                  </td>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="admin-cell-mono">
                    {formatDateTime(row.createdAt)}
                  </td>
                  <td className="admin-col-actions">
                    <button
                      type="button"
                      className="admin-link-btn danger"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Delete "${row.name}"?`)) return;
                        void run(() =>
                          adminApi.batchDeleteDocuments(dataset.id, [row.id]),
                        );
                      }}
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <AdminPagination
        page={page}
        pageSize={pageSize}
        total={total}
        onChange={(p, ps) => {
          setPage(p);
          setPageSize(ps);
        }}
      />
    </AdminShell>
  );
}
