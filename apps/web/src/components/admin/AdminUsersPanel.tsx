import React, { useCallback, useEffect, useState } from 'react';
import {
  Brain,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  User,
} from 'lucide-react';
import { adminApi, type AdminUser } from '../../services/api';
import {
  AdminPagination,
  AdminShell,
  CountTag,
  formatBytes,
  formatDateTime,
} from './adminShared';
import AdminMemoryPanel from './AdminMemoryPanel';

const GIB = 1024 * 1024 * 1024;

function gbToBytes(gb: string): number | null {
  const n = Number(gb);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n * GIB);
}

function bytesToGbInput(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0';
  const gb = bytes / GIB;
  // Keep a few decimals for non-integer GiB quotas
  return String(Number(gb.toFixed(3)));
}

export default function AdminUsersPanel() {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState({ keyword: '', status: '' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createUsername, setCreateUsername] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createRole, setCreateRole] = useState<'user' | 'admin'>('user');
  /** Default 5 GiB — matches server DEFAULT_STORAGE_QUOTA_BYTES */
  const [createQuotaGb, setCreateQuotaGb] = useState('5');

  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordUser, setPasswordUser] = useState<AdminUser | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [editOpen, setEditOpen] = useState(false);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [editDisabled, setEditDisabled] = useState(false);
  const [editRole, setEditRole] = useState<'user' | 'admin'>('user');
  const [editQuotaGb, setEditQuotaGb] = useState('5');

  const [memoryUser, setMemoryUser] = useState<AdminUser | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminApi.listUsers({
        page,
        pageSize,
        keyword: applied.keyword || undefined,
        status: applied.status || undefined,
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
    setApplied({ keyword, status });
  };

  if (memoryUser) {
    return (
      <AdminMemoryPanel
        userId={memoryUser.id}
        username={memoryUser.username}
        onBack={() => setMemoryUser(null)}
      />
    );
  }

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

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createUser = async () => {
    if (!createUsername.trim() || createPassword.length < 6) {
      setError('Username and password (min 6 chars) are required');
      return;
    }
    const quotaBytes = gbToBytes(createQuotaGb);
    if (quotaBytes === null) {
      setError('Storage quota must be a non-negative number (GB)');
      return;
    }
    await run(async () => {
      await adminApi.createUser({
        username: createUsername.trim(),
        password: createPassword,
        role: createRole,
        storageQuotaBytes: quotaBytes,
      });
      setCreateOpen(false);
      setCreateUsername('');
      setCreatePassword('');
      setCreateRole('user');
      setCreateQuotaGb('5');
    });
  };

  const savePassword = async () => {
    if (!passwordUser) return;
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    await run(async () => {
      await adminApi.setUserPassword(passwordUser.id, newPassword);
      setPasswordOpen(false);
      setPasswordUser(null);
      setNewPassword('');
      setConfirmPassword('');
    });
  };

  const openEdit = (row: AdminUser) => {
    setEditUser(row);
    setEditDisabled(row.disabled);
    setEditRole(row.role === 'admin' ? 'admin' : 'user');
    setEditQuotaGb(bytesToGbInput(row.storageQuotaBytes ?? 5 * GIB));
    setEditOpen(true);
    setError('');
  };

  const saveEdit = async () => {
    if (!editUser) return;
    const statusChanged = editDisabled !== editUser.disabled;
    const roleChanged =
      editRole !== (editUser.role === 'admin' ? 'admin' : 'user');
    const quotaBytes = gbToBytes(editQuotaGb);
    if (quotaBytes === null) {
      setError('Storage quota must be a non-negative number (GB)');
      return;
    }
    const quotaChanged = quotaBytes !== (editUser.storageQuotaBytes ?? 0);
    if (quotaChanged && quotaBytes < (editUser.storageUsedBytes ?? 0)) {
      const ok = window.confirm(
        `New quota (${formatBytes(quotaBytes)}) is below current usage (${formatBytes(editUser.storageUsedBytes)}). ` +
          'Existing files will be kept, but the user cannot upload until usage drops or the quota is raised. Continue?',
      );
      if (!ok) return;
    }
    if (!statusChanged && !roleChanged && !quotaChanged) {
      setEditOpen(false);
      setEditUser(null);
      return;
    }
    await run(async () => {
      if (statusChanged) {
        await adminApi.setUserStatus(editUser.id, editDisabled);
      }
      if (roleChanged) {
        await adminApi.setUserRole(editUser.id, editRole);
      }
      if (quotaChanged) {
        await adminApi.setUserStorageQuota(editUser.id, quotaBytes);
      }
      setEditOpen(false);
      setEditUser(null);
    });
  };

  return (
    <AdminShell
      title="Administration User Management"
      error={error}
      toolbar={
        <>
          <div className="admin-toolbar-left">
            <label className="admin-field">
              <Search size={14} />
              <input
                placeholder="Search by username"
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
              <option value="">Select status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            <button type="button" className="admin-btn" onClick={onSearch}>
              <Search size={15} /> Search
            </button>
          </div>
          <div className="admin-toolbar-right">
            <button
              type="button"
              className="admin-btn primary"
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={15} /> Create User
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
                    `Delete ${selected.size} user(s)? Owned knowledge bases will be removed.`,
                  )
                ) {
                  return;
                }
                void run(async () => {
                  await adminApi.batchDeleteUsers([...selected]);
                  setSelected(new Set());
                });
              }}
            >
              <Trash2 size={15} /> Delete Selected ({selected.size})
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
              <th>Username</th>
              <th>Knowledge Bases</th>
              <th>Documents</th>
              <th>Conversations</th>
              <th>Storage</th>
              <th>Status</th>
              <th>Admin</th>
              <th>Created</th>
              <th className="admin-col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={10} className="admin-empty">
                  Loading…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={10} className="admin-empty">
                  No users found
                </td>
              </tr>
            ) : (
              items.map((row) => {
                const used = row.storageUsedBytes ?? 0;
                const quota = row.storageQuotaBytes ?? 0;
                const over = quota > 0 && used > quota;
                const high = quota > 0 && used / quota >= 0.9;
                return (
                <tr key={row.id}>
                  <td className="admin-col-check">
                    <input
                      type="checkbox"
                      checked={selected.has(row.id)}
                      onChange={(e) => toggleOne(row.id, e.target.checked)}
                      aria-label={`Select ${row.username}`}
                    />
                  </td>
                  <td>
                    <span className="admin-user-cell">
                      <span className="admin-user-avatar" aria-hidden>
                        <User size={14} />
                      </span>
                      {row.username}
                    </span>
                  </td>
                  <td>
                    <CountTag value={row.datasetCount} tone="blue" />
                  </td>
                  <td>
                    <CountTag value={row.documentCount} tone="purple" />
                  </td>
                  <td>
                    <CountTag value={row.conversationCount} tone="cyan" />
                  </td>
                  <td>
                    <span
                      className={`admin-storage-cell${over ? ' over' : high ? ' high' : ''}`}
                      title="Total size of documents owned by this user vs their quota"
                    >
                      {formatBytes(used)} / {formatBytes(quota || 0)}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`admin-status-toggle ${row.disabled ? 'inactive' : 'active'}`}
                    >
                      <span className="admin-status-dot" />
                      {row.disabled ? 'Inactive' : 'Active'}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`admin-badge ${row.role === 'admin' ? 'gold' : 'muted'}`}
                    >
                      {row.role === 'admin' ? 'Yes' : 'No'}
                    </span>
                  </td>
                  <td className="admin-cell-mono">
                    {formatDateTime(row.createdAt)}
                  </td>
                  <td className="admin-col-actions">
                    <button
                      type="button"
                      className="admin-link-btn"
                      disabled={busy}
                      title="View profile & memories"
                      onClick={() => setMemoryUser(row)}
                    >
                      <Brain size={14} /> Memory
                    </button>
                    <button
                      type="button"
                      className="admin-link-btn"
                      disabled={busy}
                      title="Edit status and admin"
                      onClick={() => openEdit(row)}
                    >
                      <Pencil size={14} /> Edit
                    </button>
                    <button
                      type="button"
                      className="admin-link-btn"
                      disabled={busy}
                      title="Reset password"
                      onClick={() => {
                        setPasswordUser(row);
                        setNewPassword('');
                        setConfirmPassword('');
                        setPasswordOpen(true);
                      }}
                    >
                      <KeyRound size={14} />
                    </button>
                    <button
                      type="button"
                      className="admin-link-btn danger"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Delete user "${row.username}"?`)) {
                          return;
                        }
                        void run(() => adminApi.batchDeleteUsers([row.id]));
                      }}
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  </td>
                </tr>
              );
              })
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

      {createOpen && (
        <div className="admin-modal-backdrop" role="presentation">
          <div className="admin-modal" role="dialog" aria-label="Create user">
            <h2>Create User</h2>
            <label className="admin-form-field">
              <span>Username</span>
              <input
                value={createUsername}
                onChange={(e) => setCreateUsername(e.target.value)}
                autoFocus
              />
            </label>
            <label className="admin-form-field">
              <span>Password</span>
              <input
                type="password"
                value={createPassword}
                onChange={(e) => setCreatePassword(e.target.value)}
              />
            </label>
            <label className="admin-form-field">
              <span>Role</span>
              <select
                value={createRole}
                onChange={(e) =>
                  setCreateRole(e.target.value as 'user' | 'admin')
                }
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <label className="admin-form-field">
              <span>Storage quota (GB)</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={createQuotaGb}
                onChange={(e) => setCreateQuotaGb(e.target.value)}
              />
              <span className="admin-field-hint">
                Total size of all files this user uploads. Default 5 GB.
              </span>
            </label>
            <div className="admin-modal-actions">
              <button
                type="button"
                className="admin-btn"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="admin-btn primary"
                disabled={busy}
                onClick={() => void createUser()}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {passwordOpen && passwordUser && (
        <div className="admin-modal-backdrop" role="presentation">
          <div
            className="admin-modal"
            role="dialog"
            aria-label="Reset password"
          >
            <h2>Reset Password</h2>
            <label className="admin-form-field">
              <span>Username</span>
              <input value={passwordUser.username} disabled />
            </label>
            <label className="admin-form-field">
              <span>New password</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoFocus
              />
            </label>
            <label className="admin-form-field">
              <span>Confirm password</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
            <div className="admin-modal-actions">
              <button
                type="button"
                className="admin-btn"
                onClick={() => {
                  setPasswordOpen(false);
                  setPasswordUser(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="admin-btn primary"
                disabled={busy}
                onClick={() => void savePassword()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {editOpen && editUser && (
        <div className="admin-modal-backdrop" role="presentation">
          <div
            className="admin-modal"
            role="dialog"
            aria-label="Edit user"
          >
            <h2>Edit User</h2>
            <label className="admin-form-field">
              <span>Username</span>
              <input value={editUser.username} disabled />
            </label>
            <label className="admin-form-field">
              <span>Status</span>
              <select
                value={editDisabled ? 'inactive' : 'active'}
                onChange={(e) => setEditDisabled(e.target.value === 'inactive')}
                autoFocus
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
            <label className="admin-form-field">
              <span>Admin</span>
              <select
                value={editRole}
                onChange={(e) =>
                  setEditRole(e.target.value as 'user' | 'admin')
                }
              >
                <option value="user">No</option>
                <option value="admin">Yes</option>
              </select>
            </label>
            <label className="admin-form-field">
              <span>Storage quota (GB)</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={editQuotaGb}
                onChange={(e) => setEditQuotaGb(e.target.value)}
              />
              <span className="admin-field-hint">
                Used {formatBytes(editUser.storageUsedBytes ?? 0)} of current{' '}
                {formatBytes(editUser.storageQuotaBytes ?? 0)}. Lowering below
                used keeps files but blocks new uploads.
              </span>
            </label>
            <div className="admin-modal-actions">
              <button
                type="button"
                className="admin-btn"
                onClick={() => {
                  setEditOpen(false);
                  setEditUser(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="admin-btn primary"
                disabled={busy}
                onClick={() => void saveEdit()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
