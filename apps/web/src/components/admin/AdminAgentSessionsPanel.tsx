import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Cpu,
  RefreshCw,
  Search,
  Trash2,
  Zap,
} from 'lucide-react';
import {
  adminApi,
  type AdminAgentSession,
  type AdminAgentSessionStats,
} from '../../services/api';
import { AdminPagination, formatDateTime } from './adminShared';

function formatTtl(ms: number) {
  if (!ms || ms < 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  return `${hr}h`;
}

function formatIdle(lastUsedAt: string) {
  const age = Date.now() - new Date(lastUsedAt).getTime();
  if (!Number.isFinite(age) || age < 0) return '—';
  if (age < 5_000) return 'just now';
  return `${formatTtl(age)} ago`;
}

export default function AdminAgentSessionsPanel() {
  const [items, setItems] = useState<AdminAgentSession[]>([]);
  const [stats, setStats] = useState<AdminAgentSessionStats | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState({ keyword: '', status: '' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminApi.listAgentSessions({
        page,
        pageSize,
        keyword: applied.keyword || undefined,
        status: applied.status || undefined,
      });
      setItems(res.items);
      setTotal(res.total);
      setStats(res.stats);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, applied]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    const hasLive = items.some((s) => s.busy || s.isStreaming);
    if (hasLive || (stats && stats.busy > 0)) {
      pollRef.current = setInterval(() => void load(), 3000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [items, stats, load]);

  const onSearch = () => {
    setPage(1);
    setApplied({ keyword, status });
  };

  const toggleAll = (checked: boolean) => {
    setSelected(
      checked ? new Set(items.map((i) => i.conversationId)) : new Set(),
    );
  };

  const toggleOne = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

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

  const disposeIds = async (ids: string[]) => {
    if (!ids.length) return;
    const ok = window.confirm(
      `Dispose ${ids.length} agent session${ids.length === 1 ? '' : 's'}? ` +
        'In-flight prompts will be aborted; the next message rebuilds from DB history.',
    );
    if (!ok) return;
    await run(() => adminApi.disposeAgentSessions(ids));
  };

  return (
    <div className="admin-page">
      <header className="admin-page-header">
        <h1 className="admin-page-title">Administration Agent Sessions</h1>
        <p className="admin-page-hint">System administration — not the end-user workspace.</p>
      </header>
      {error ? <p className="error-text admin-error">{error}</p> : null}

      {stats && (
        <div className="admin-stats-row admin-stats-row-4">
          <div className="admin-stat-card">
            <span className="admin-stat-label">Active</span>
            <span className="admin-stat-value info">
              <Activity size={16} /> {stats.size}
            </span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Busy</span>
            <span className="admin-stat-value warning">
              <Zap size={16} className={stats.busy ? 'spin' : ''} />{' '}
              {stats.busy}
            </span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Idle</span>
            <span className="admin-stat-value muted">{stats.idle}</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Capacity</span>
            <span className="admin-stat-value">
              <Cpu size={16} /> {stats.size}/{stats.maxSessions}
            </span>
          </div>
        </div>
      )}

      <div className="admin-card">
        <div className="admin-toolbar">
          <div className="admin-toolbar-left">
            <label className="admin-field">
              <Search size={14} />
              <input
                placeholder="Search title, owner, id, model"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onSearch()}
              />
            </label>
            <select
              className="admin-select"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
                setApplied({ keyword, status: e.target.value });
              }}
            >
              <option value="">All statuses</option>
              <option value="busy">Busy</option>
              <option value="idle">Idle</option>
            </select>
            <button type="button" className="admin-btn" onClick={onSearch}>
              <Search size={15} /> Search
            </button>
          </div>
          <div className="admin-toolbar-right">
            <button
              type="button"
              className="admin-btn danger"
              disabled={!selected.size || busy}
              onClick={() => void disposeIds([...selected])}
            >
              <Trash2 size={15} /> Dispose ({selected.size})
            </button>
            <button
              type="button"
              className="admin-btn"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh
            </button>
          </div>
        </div>

        {stats ? (
          <p className="admin-cell-muted" style={{ margin: '0 0 12px', fontSize: 12 }}>
            In-memory pool · idle TTL {formatTtl(stats.ttlMs)} · process-local
            (empty after API restart)
          </p>
        ) : null}

        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th className="admin-col-check">
                  <input
                    type="checkbox"
                    checked={
                      items.length > 0 && selected.size === items.length
                    }
                    onChange={(e) => toggleAll(e.target.checked)}
                    aria-label="Select all"
                  />
                </th>
                <th>Conversation</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Model</th>
                <th>Agent msgs</th>
                <th>DB msgs</th>
                <th>Last used</th>
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
                    No active agent sessions in the pool
                  </td>
                </tr>
              ) : (
                items.map((row) => (
                  <tr key={row.conversationId}>
                    <td className="admin-col-check">
                      <input
                        type="checkbox"
                        checked={selected.has(row.conversationId)}
                        onChange={(e) =>
                          toggleOne(row.conversationId, e.target.checked)
                        }
                        aria-label={`Select ${row.conversationTitle}`}
                      />
                    </td>
                    <td>
                      <div
                        className="admin-cell-name"
                        title={row.conversationTitle}
                      >
                        {row.conversationTitle}
                      </div>
                      <div
                        className="admin-cell-mono admin-cell-muted"
                        title={row.conversationId}
                        style={{ fontSize: 11 }}
                      >
                        {row.conversationId.slice(0, 8)}…
                      </div>
                    </td>
                    <td>{row.ownerUsername}</td>
                    <td>
                      {row.busy || row.isStreaming ? (
                        <span className="admin-badge info">
                          {row.isStreaming ? 'Streaming' : 'Busy'}
                        </span>
                      ) : (
                        <span className="admin-badge muted">Idle</span>
                      )}
                    </td>
                    <td
                      className="admin-cell-mono"
                      title={
                        [row.modelProvider, row.modelId]
                          .filter(Boolean)
                          .join(' / ') || undefined
                      }
                    >
                      {row.modelId || '—'}
                    </td>
                    <td>{row.messageCount}</td>
                    <td>
                      {row.dbMessageCount == null ? '—' : row.dbMessageCount}
                    </td>
                    <td
                      className="admin-cell-mono"
                      title={formatDateTime(row.lastUsedAt)}
                    >
                      {formatIdle(row.lastUsedAt)}
                    </td>
                    <td className="admin-col-actions">
                      <button
                        type="button"
                        className="admin-link-btn danger"
                        disabled={busy}
                        onClick={() => void disposeIds([row.conversationId])}
                      >
                        Dispose
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
      </div>
    </div>
  );
}
