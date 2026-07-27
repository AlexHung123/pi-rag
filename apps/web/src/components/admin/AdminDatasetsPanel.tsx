import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Search, Trash2 } from 'lucide-react';
import { adminApi, type AdminDataset } from '../../services/api';
import {
  AdminPagination,
  AdminShell,
  CHUNK_METHODS,
  CountTag,
  chunkMethodLabel,
  formatDateTime,
} from './adminShared';

type Props = {
  onOpenDocuments: (dataset: { id: string; name: string }) => void;
};

export default function AdminDatasetsPanel({ onOpenDocuments }: Props) {
  const [items, setItems] = useState<AdminDataset[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  const [chunkMethod, setChunkMethod] = useState('');
  const [applied, setApplied] = useState({ name: '', owner: '', chunkMethod: '' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminApi.listDatasets({
        page,
        pageSize,
        name: applied.name || undefined,
        owner: applied.owner || undefined,
        chunkMethod: applied.chunkMethod || undefined,
      });
      setItems(res.items);
      setTotal(res.total);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, applied]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSearch = () => {
    setPage(1);
    setApplied({ name, owner, chunkMethod });
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

  const deleteIds = async (ids: string[]) => {
    if (!ids.length) return;
    if (!window.confirm(`Delete ${ids.length} dataset(s)? This cannot be undone.`)) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await adminApi.batchDeleteDatasets(ids);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminShell
      title="Datasets"
      error={error}
      toolbar={
        <>
          <div className="admin-toolbar-left">
            <label className="admin-field">
              <Search size={14} />
              <input
                placeholder="Search by name"
                value={name}
                onChange={(e) => setName(e.target.value)}
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
              value={chunkMethod}
              onChange={(e) => setChunkMethod(e.target.value)}
            >
              <option value="">Chunk method</option>
              {CHUNK_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <button type="button" className="admin-btn" onClick={onSearch}>
              <Search size={15} /> Search
            </button>
          </div>
          <div className="admin-toolbar-right">
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
              onClick={() => void deleteIds([...selected])}
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
              <th>Docs</th>
              <th>Chunks</th>
              <th>Visibility</th>
              <th>Chunk Method</th>
              <th>Owner</th>
              <th>Created</th>
              <th className="admin-col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} className="admin-empty">
                  Loading…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={9} className="admin-empty">
                  No datasets found
                </td>
              </tr>
            ) : (
              items.map((row) => (
                <tr
                  key={row.id}
                  className="admin-row-clickable"
                  onClick={(e) => {
                    const t = e.target as HTMLElement;
                    if (t.closest('input,button,a')) return;
                    onOpenDocuments({ id: row.id, name: row.name });
                  }}
                >
                  <td className="admin-col-check">
                    <input
                      type="checkbox"
                      checked={selected.has(row.id)}
                      onChange={(e) => toggleOne(row.id, e.target.checked)}
                      aria-label={`Select ${row.name}`}
                    />
                  </td>
                  <td className="admin-cell-name">{row.name}</td>
                  <td>
                    <CountTag value={row.documentCount} tone="blue" />
                  </td>
                  <td>
                    <CountTag value={row.chunkCount} tone="green" />
                  </td>
                  <td>
                    <span
                      className={`kb-visibility-badge ${row.visibility === 'public' ? 'public' : 'private'}`}
                    >
                      {row.visibility === 'public' ? 'Public' : 'Private'}
                    </span>
                  </td>
                  <td>
                    <span className="admin-badge purple">
                      {chunkMethodLabel(row.chunkMethod)}
                    </span>
                  </td>
                  <td>{row.ownerUsername}</td>
                  <td className="admin-cell-mono">{formatDateTime(row.createdAt)}</td>
                  <td className="admin-col-actions">
                    <button
                      type="button"
                      className="admin-link-btn danger"
                      disabled={busy}
                      onClick={() => void deleteIds([row.id])}
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
