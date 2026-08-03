import React, { useCallback, useEffect, useState } from 'react';
import { Brain, Pin, Plus, Trash2 } from 'lucide-react';
import {
  memoryApi,
  type MemoryItem,
  type UserProfile,
} from '../services/api';

const CATEGORIES = [
  { value: 'preference', label: 'Preference' },
  { value: 'fact', label: 'Fact' },
  { value: 'project', label: 'Project' },
  { value: 'other', label: 'Other' },
] as const;

export default function MemoryPanel({
  onBackToChat,
}: {
  onBackToChat?: () => void;
}) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [error, setError] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [adding, setAdding] = useState(false);

  const [displayName, setDisplayName] = useState('');
  const [language, setLanguage] = useState('');
  const [responseStyle, setResponseStyle] = useState('');
  const [bio, setBio] = useState('');

  const [newContent, setNewContent] = useState('');
  const [newCategory, setNewCategory] =
    useState<(typeof CATEGORIES)[number]['value']>('preference');
  const [newPinned, setNewPinned] = useState(false);
  const [newImportance, setNewImportance] = useState(3);

  const refresh = useCallback(async () => {
    const [p, list] = await Promise.all([
      memoryApi.getProfile(),
      memoryApi.list({ status: 'active' }),
    ]);
    setProfile(p);
    setDisplayName(p.displayName || '');
    setLanguage(p.language || '');
    setResponseStyle(p.responseStyle || '');
    setBio(p.bio || '');
    setItems(Array.isArray(list.items) ? list.items : []);
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(String(e?.message || e)));
  }, [refresh]);

  const saveProfile = async () => {
    setError('');
    setSavingProfile(true);
    try {
      const p = await memoryApi.updateProfile({
        displayName: displayName.trim() || null,
        language: language.trim() || null,
        responseStyle: responseStyle.trim() || null,
        bio,
      });
      setProfile(p);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setSavingProfile(false);
    }
  };

  const addItem = async () => {
    const content = newContent.trim();
    if (!content) {
      setError('Memory content is required');
      return;
    }
    setError('');
    setAdding(true);
    try {
      await memoryApi.create({
        content,
        category: newCategory,
        pinned: newPinned,
        importance: newImportance,
      });
      setNewContent('');
      setNewPinned(false);
      setNewImportance(3);
      setNewCategory('preference');
      await refresh();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setAdding(false);
    }
  };

  const togglePin = async (item: MemoryItem) => {
    setError('');
    try {
      await memoryApi.update(item.id, { pinned: !item.pinned });
      await refresh();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  };

  const removeItem = async (id: string) => {
    setError('');
    try {
      await memoryApi.remove(id);
      await refresh();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  };

  return (
    <div className="kb-page memory-page">
      <header className="kb-topbar">
        <div className="kb-topbar-left">
          <div className="kb-brand-mark">
            <Brain size={18} />
            <span>My Memory</span>
          </div>
        </div>
        {onBackToChat && (
          <button type="button" className="btn btn-secondary" onClick={onBackToChat}>
            Back to chat
          </button>
        )}
      </header>

      <div className="memory-panel-body">
        <p className="field-hint memory-intro">
          已保存的記憶不會全部進入每一輪對話；置頂與較重要的優先，每輪最多約 15
          條。文件內容請放知識庫；這裡只記「關於你」的偏好與事實。
        </p>

        {error ? <div className="error-banner">{error}</div> : null}

        <section className="memory-section">
          <h2 className="memory-section-title">Profile</h2>
          <div className="field">
            <label htmlFor="mem-display-name">Display name</label>
            <input
              id="mem-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={80}
              placeholder="How the assistant should address you"
            />
          </div>
          <div className="field">
            <label htmlFor="mem-language">Language</label>
            <input
              id="mem-language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              maxLength={32}
              placeholder="e.g. zh-Hant, en"
            />
          </div>
          <div className="field">
            <label htmlFor="mem-style">Response style</label>
            <input
              id="mem-style"
              value={responseStyle}
              onChange={(e) => setResponseStyle(e.target.value)}
              maxLength={200}
              placeholder="e.g. short, detailed, bullet-first"
            />
          </div>
          <div className="field">
            <label htmlFor="mem-bio">Bio / background</label>
            <textarea
              id="mem-bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="Role, team, main work context"
            />
          </div>
          <button
            type="button"
            className="btn"
            disabled={savingProfile}
            onClick={() => void saveProfile()}
          >
            {savingProfile ? 'Saving…' : 'Save profile'}
          </button>
          {profile ? (
            <p className="field-hint">
              Updated {new Date(profile.updatedAt).toLocaleString()}
            </p>
          ) : null}
        </section>

        <section className="memory-section">
          <h2 className="memory-section-title">Add memory</h2>
          <div className="field">
            <label htmlFor="mem-content">Content (one sentence works best)</label>
            <textarea
              id="mem-content"
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="e.g. Prefer markdown tables for comparisons"
            />
          </div>
          <div className="memory-add-row">
            <div className="field">
              <label htmlFor="mem-category">Category</label>
              <select
                id="mem-category"
                value={newCategory}
                onChange={(e) =>
                  setNewCategory(
                    e.target.value as (typeof CATEGORIES)[number]['value'],
                  )
                }
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="mem-importance">Importance (1–5)</label>
              <input
                id="mem-importance"
                type="number"
                min={1}
                max={5}
                value={newImportance}
                onChange={(e) =>
                  setNewImportance(
                    Math.min(5, Math.max(1, Number(e.target.value) || 3)),
                  )
                }
              />
            </div>
            <label className="memory-check">
              <input
                type="checkbox"
                checked={newPinned}
                onChange={(e) => setNewPinned(e.target.checked)}
              />
              Pin
            </label>
          </div>
          <button
            type="button"
            className="btn"
            disabled={adding}
            onClick={() => void addItem()}
          >
            <Plus size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            {adding ? 'Adding…' : 'Add memory'}
          </button>
        </section>

        <section className="memory-section">
          <h2 className="memory-section-title">
            Active memories ({items.length})
          </h2>
          {items.length === 0 ? (
            <p className="field-hint">No memories yet. Add one above.</p>
          ) : (
            <ul className="memory-list">
              {items.map((item) => (
                <li key={item.id} className="memory-list-item">
                  <div className="memory-list-main">
                    <div className="memory-list-meta">
                      <span className="memory-badge">{item.category}</span>
                      {item.pinned ? (
                        <span className="memory-badge pinned">pinned</span>
                      ) : null}
                      <span className="memory-importance">
                        ★{item.importance}
                      </span>
                    </div>
                    <p className="memory-list-content">{item.content}</p>
                  </div>
                  <div className="memory-list-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-icon"
                      title={item.pinned ? 'Unpin' : 'Pin'}
                      onClick={() => void togglePin(item)}
                    >
                      <Pin size={16} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-icon"
                      title="Delete"
                      onClick={() => void removeItem(item.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
