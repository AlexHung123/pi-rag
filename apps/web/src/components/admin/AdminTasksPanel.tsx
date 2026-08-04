import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Search,
  XCircle,
} from 'lucide-react';
import {
  adminApi,
  type AdminDocument,
  type AdminTaskStats,
  type AdminTranscriptionJob,
  type AdminTranscriptionJobStats,
} from '../../services/api';
import {
  AdminPagination,
  ProgressBar,
  StatusBadge,
  displayProcessDuration,
  formatBytes,
  formatDateTime,
} from './adminShared';

function groupByKb(ids: string[], items: AdminDocument[]) {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const t = items.find((x) => x.id === id);
    if (!t) continue;
    const list = groups.get(t.knowledgeBaseId) || [];
    list.push(t.id);
    groups.set(t.knowledgeBaseId, list);
  }
  return [...groups.entries()].map(([knowledgeBaseId, documentIds]) => ({
    knowledgeBaseId,
    documentIds,
  }));
}

export default function AdminTasksPanel() {
  const [items, setItems] = useState<AdminDocument[]>([]);
  const [stats, setStats] = useState<AdminTaskStats | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [docName, setDocName] = useState('');
  const [datasetName, setDatasetName] = useState('');
  const [owner, setOwner] = useState('');
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState({
    docName: '',
    datasetName: '',
    owner: '',
    status: '',
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Tick for live Duration while parse is running. */
  const [nowTick, setNowTick] = useState(() => Date.now());

  // STT jobs (P1 observability)
  const [sttJobs, setSttJobs] = useState<AdminTranscriptionJob[]>([]);
  const [sttStats, setSttStats] = useState<AdminTranscriptionJobStats | null>(null);
  const [sttTotal, setSttTotal] = useState(0);
  const [sttPage, setSttPage] = useState(1);
  const [sttStatus, setSttStatus] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [listRes, statsRes, sttList, sttStatsRes] = await Promise.all([
        adminApi.listTasks({
          page,
          pageSize,
          docName: applied.docName || undefined,
          datasetName: applied.datasetName || undefined,
          owner: applied.owner || undefined,
          status: applied.status || undefined,
        }),
        adminApi.taskStats(),
        adminApi.listTranscriptionJobs({
          page: sttPage,
          pageSize: 10,
          status: sttStatus || undefined,
        }),
        adminApi.transcriptionJobStats(),
      ]);
      setItems(listRes.items);
      setTotal(listRes.total);
      setStats(statsRes);
      setSttJobs(sttList.items);
      setSttTotal(sttList.total);
      setSttStats(sttStatsRes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, applied, sttPage, sttStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    const sttActive = sttJobs.some((j) => j.status === 'queued' || j.status === 'running');
    if (items.some((t) => t.status === 'running') || sttActive) {
      pollRef.current = setInterval(() => void load(), 3000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [items, sttJobs, load]);

  useEffect(() => {
    if (!items.some((t) => t.status === 'running')) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [items]);

  const onSearch = () => {
    setPage(1);
    setApplied({ docName, datasetName, owner, status });
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
    const t = items.find((x) => x.id === id);
    return t && (t.status === 'unstart' || t.status === 'fail');
  });
  const runningIds = [...selected].filter((id) => {
    const t = items.find((x) => x.id === id);
    return t && t.status === 'running';
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

  return (
    <div className="admin-page">
      <header className="admin-page-header">
        <h1 className="admin-page-title">Administration Document Parsing Tasks</h1>
        <p className="admin-page-hint">System administration — not the end-user workspace.</p>
      </header>
      {error ? <p className="error-text admin-error">{error}</p> : null}

      {stats && (
        <div className="admin-stats-row">
          <div className="admin-stat-card">
            <span className="admin-stat-label">Total</span>
            <span className="admin-stat-value info">{stats.total}</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Running</span>
            <span className="admin-stat-value info">
              <RefreshCw size={16} className={stats.running ? 'spin' : ''} />{' '}
              {stats.running}
            </span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Unstart</span>
            <span className="admin-stat-value muted">
              <Clock size={16} /> {stats.unstart}
            </span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Completed</span>
            <span className="admin-stat-value success">
              <CheckCircle2 size={16} /> {stats.done}
            </span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Failed</span>
            <span className="admin-stat-value danger">
              <XCircle size={16} /> {stats.fail}
            </span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Canceled</span>
            <span className="admin-stat-value warning">{stats.cancel}</span>
          </div>
        </div>
      )}

      <div className="admin-card">
        <div className="admin-toolbar">
          <div className="admin-toolbar-left">
            <label className="admin-field">
              <Search size={14} />
              <input
                placeholder="Search document"
                value={docName}
                onChange={(e) => setDocName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onSearch()}
              />
            </label>
            <label className="admin-field">
              <Search size={14} />
              <input
                placeholder="Search knowledge base"
                value={datasetName}
                onChange={(e) => setDatasetName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onSearch()}
              />
            </label>
            <label className="admin-field">
              <Search size={14} />
              <input
                placeholder="Search by owner"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onSearch()}
              />
            </label>
            <select
              className="admin-select"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
                setApplied({
                  docName,
                  datasetName,
                  owner,
                  status: e.target.value,
                });
              }}
            >
              <option value="">Filter status</option>
              <option value="running">Running</option>
              <option value="unstart">Unstart</option>
              <option value="done">Done</option>
              <option value="fail">Fail</option>
            </select>
            <button type="button" className="admin-btn" onClick={onSearch}>
              <Search size={15} /> Search
            </button>
          </div>
          <div className="admin-toolbar-right">
            <button
              type="button"
              className="admin-btn primary"
              disabled={!parseableIds.length || busy}
              onClick={() =>
                void run(() =>
                  adminApi.batchParseTasks(groupByKb(parseableIds, items)),
                )
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
                  adminApi.batchStopTasks(groupByKb(runningIds, items)),
                )
              }
            >
              <PauseCircle size={15} /> Stop ({runningIds.length})
            </button>
            <button
              type="button"
              className="admin-btn"
              disabled={!stats?.fail || busy}
              onClick={() => void run(() => adminApi.retryFailedTasks())}
            >
              <RotateCcw size={15} /> Retry Failed ({stats?.fail || 0})
            </button>
            <button
              type="button"
              className="admin-btn"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw size={15} /> Refresh
            </button>
          </div>
        </div>

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
                <th>Document</th>
                <th>Knowledge Base</th>
                <th>Size</th>
                <th>Progress</th>
                <th>Status</th>
                <th>Queue</th>
                <th>Duration</th>
                <th>Chunks</th>
                <th>Owner</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {loading && !items.length ? (
                <tr>
                  <td colSpan={11} className="admin-empty">
                    Loading…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={11} className="admin-empty">
                    No tasks found
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
                    <td>{row.knowledgeBaseName || '—'}</td>
                    <td>{formatBytes(row.sizeBytes)}</td>
                    <td>
                      <ProgressBar
                        progress={row.progress}
                        status={row.status}
                      />
                    </td>
                    <td>
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="admin-cell-muted">—</td>
                    <td
                      className="admin-cell-mono"
                      title={
                        row.processBeginAt
                          ? `Started ${formatDateTime(row.processBeginAt)}`
                          : undefined
                      }
                    >
                      {displayProcessDuration({
                        status: row.status,
                        processDuration: row.processDuration,
                        processBeginAt: row.processBeginAt,
                        now: nowTick,
                      })}
                    </td>
                    <td>{row.chunkCount}</td>
                    <td>{row.ownerUsername || '—'}</td>
                    <td className="admin-cell-mono">
                      {formatDateTime(row.updatedAt)}
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
      </div>

      {/* STT transcription queue (P1) */}
      <header className="admin-page-header" style={{ marginTop: 28 }}>
        <h2 className="admin-page-title" style={{ fontSize: '1.15rem' }}>
          Audio transcription jobs
        </h2>
        <p className="admin-page-hint">
          Local STT queue (queued → running → done). Parse status is tracked above after transcript ingest.
        </p>
      </header>

      {sttStats ? (
        <div className="admin-stats-row">
          <div className="admin-stat-card">
            <span className="admin-stat-label">STT total</span>
            <span className="admin-stat-value info">{sttStats.total}</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Queued</span>
            <span className="admin-stat-value muted">{sttStats.queued}</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Running</span>
            <span className="admin-stat-value info">{sttStats.running}</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Done</span>
            <span className="admin-stat-value success">{sttStats.done}</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Failed</span>
            <span className="admin-stat-value danger">{sttStats.failed}</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Cancelled</span>
            <span className="admin-stat-value warning">{sttStats.cancelled}</span>
          </div>
        </div>
      ) : null}

      <div className="admin-card">
        <div className="admin-toolbar">
          <div className="admin-toolbar-left">
            <select
              className="admin-select"
              value={sttStatus}
              onChange={(e) => {
                setSttStatus(e.target.value);
                setSttPage(1);
              }}
            >
              <option value="">All STT statuses</option>
              <option value="queued">Queued</option>
              <option value="running">Running</option>
              <option value="done">Done</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Status</th>
                <th>Stage</th>
                <th>Progress</th>
                <th>Attempts</th>
                <th>Message</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {sttJobs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="admin-empty">
                    No transcription jobs yet
                  </td>
                </tr>
              ) : (
                sttJobs.map((j) => (
                  <tr key={j.id}>
                    <td className="admin-cell-name" title={j.documentName || j.documentId}>
                      {j.documentName || j.documentId.slice(0, 8)}
                    </td>
                    <td>
                      <span className={`badge ${j.status === 'failed' ? 'fail' : j.status === 'running' ? 'running' : j.status === 'done' ? 'done' : 'unstart'}`}>
                        {j.status}
                      </span>
                    </td>
                    <td className="admin-cell-muted">{j.stage}</td>
                    <td>
                      <ProgressBar progress={j.progress} status={j.status === 'failed' ? 'fail' : j.status === 'done' ? 'done' : 'running'} />
                    </td>
                    <td className="admin-cell-mono">
                      {j.attempts}/{j.maxAttempts}
                    </td>
                    <td className="admin-cell-muted" title={j.errorMessage || j.progressMsg || ''}>
                      {j.errorMessage || j.progressMsg || '—'}
                    </td>
                    <td className="admin-cell-mono">{formatDateTime(j.updatedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <AdminPagination
          page={sttPage}
          pageSize={10}
          total={sttTotal}
          onChange={(p) => {
            setSttPage(p);
          }}
        />
      </div>
    </div>
  );
}
