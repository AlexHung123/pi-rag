import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Brain, RefreshCw, Trash2 } from 'lucide-react';
import {
  adminApi,
  type MemoryItem,
  type UserProfile,
} from '../../services/api';
import { AdminShell, formatDateTime } from './adminShared';

type Props = {
  userId: string;
  username: string;
  onBack: () => void;
};

export default function AdminMemoryPanel({ userId, username, onBack }: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [counts, setCounts] = useState({ total: 0, active: 0, pinned: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const [displayName, setDisplayName] = useState('');
  const [language, setLanguage] = useState('');
  const [responseStyle, setResponseStyle] = useState('');
  const [bio, setBio] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminApi.getUserMemory(userId);
      setProfile(res.profile);
      setItems(res.items || []);
      setCounts(res.counts || { total: 0, active: 0, pinned: 0 });
      setDisplayName(res.profile?.displayName || '');
      setLanguage(res.profile?.language || '');
      setResponseStyle(res.profile?.responseStyle || '');
      setBio(res.profile?.bio || '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveProfile = async () => {
    setSaving(true);
    setError('');
    try {
      const p = await adminApi.updateUserMemoryProfile(userId, {
        displayName: displayName.trim() || null,
        language: language.trim() || null,
        responseStyle: responseStyle.trim() || null,
        bio,
      });
      setProfile(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const deleteItem = async (item: MemoryItem) => {
    if (
      !window.confirm(
        `Delete memory for ${username}?\n\n${item.content.slice(0, 120)}`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await adminApi.deleteUserMemoryItem(userId, item.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminShell
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Brain size={20} />
          Memory — {username}
        </span>
      }
      error={error || undefined}
      toolbar={
        <div className="admin-toolbar-right" style={{ width: '100%', justifyContent: 'flex-start', gap: 8 }}>
          <button type="button" className="admin-btn" onClick={onBack}>
            <ArrowLeft size={16} /> Back to users
          </button>
          <button
            type="button"
            className="admin-btn"
            disabled={loading || busy}
            onClick={() => void load()}
          >
            <RefreshCw size={16} /> Refresh
          </button>
        </div>
      }
    >
      <p className="field-hint" style={{ marginBottom: 16 }}>
        Inspect and moderate L1 profile + L2 memory items for this user. Chat
        &quot;記住&quot; items appear here with source=manual.
      </p>

      <div className="admin-stats-row" style={{ marginBottom: 16 }}>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Total items</div>
          <div className="admin-stat-value">{counts.total}</div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Active</div>
          <div className="admin-stat-value">{counts.active}</div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Pinned</div>
          <div className="admin-stat-value">{counts.pinned}</div>
        </div>
      </div>

      <section className="memory-section" style={{ marginBottom: 20 }}>
        <h2 className="memory-section-title">Profile (L1)</h2>
        {loading && !profile ? (
          <p className="field-hint">Loading…</p>
        ) : (
          <>
            <div className="field">
              <label>Display name</label>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={80}
              />
            </div>
            <div className="field">
              <label>Language</label>
              <input
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                maxLength={32}
              />
            </div>
            <div className="field">
              <label>Response style</label>
              <input
                value={responseStyle}
                onChange={(e) => setResponseStyle(e.target.value)}
                maxLength={200}
              />
            </div>
            <div className="field">
              <label>Bio</label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                maxLength={2000}
                rows={3}
              />
            </div>
            <button
              type="button"
              className="btn"
              disabled={saving}
              onClick={() => void saveProfile()}
            >
              {saving ? 'Saving…' : 'Save profile'}
            </button>
          </>
        )}
      </section>

      <section className="memory-section">
        <h2 className="memory-section-title">
          Memory items (L2) — {items.length}
        </h2>
        {loading ? (
          <p className="field-hint">Loading…</p>
        ) : items.length === 0 ? (
          <p className="field-hint">No memory items for this user.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Content</th>
                  <th>Status</th>
                  <th>Pin</th>
                  <th>★</th>
                  <th>Source</th>
                  <th>Updated</th>
                  <th className="admin-col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className="admin-badge muted">{item.category}</span>
                    </td>
                    <td style={{ maxWidth: 360, whiteSpace: 'pre-wrap' }}>
                      {item.content}
                    </td>
                    <td>{item.status}</td>
                    <td>{item.pinned ? 'Yes' : '—'}</td>
                    <td>{item.importance}</td>
                    <td>{item.source}</td>
                    <td className="admin-cell-mono">
                      {formatDateTime(item.updatedAt)}
                    </td>
                    <td className="admin-col-actions">
                      <button
                        type="button"
                        className="admin-link-btn danger"
                        disabled={busy}
                        onClick={() => void deleteItem(item)}
                      >
                        <Trash2 size={14} /> Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AdminShell>
  );
}
