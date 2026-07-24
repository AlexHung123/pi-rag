import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  docApi,
  kbApi,
  type ChunkItem,
  type DocumentItem,
  type KnowledgeBase,
} from '../services/api';

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function KnowledgePanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    doc: DocumentItem;
    chunks: ChunkItem[];
    total: number;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadKbs = useCallback(async () => {
    const res = await kbApi.list();
    setKbs(res.items);
    if (!selectedId && res.items[0]) setSelectedId(res.items[0].id);
  }, [selectedId]);

  const loadDocs = useCallback(async (kbId: string) => {
    const res = await docApi.list(kbId);
    setDocs(res.items);
  }, []);

  useEffect(() => {
    if (!open) return;
    loadKbs().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [open, loadKbs]);

  useEffect(() => {
    if (!open || !selectedId) return;
    loadDocs(selectedId).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [open, selectedId, loadDocs]);

  // Poll while any doc is running
  useEffect(() => {
    if (!open || !selectedId) return;
    const hasRunning = docs.some((d) => d.status === 'running');
    if (!hasRunning) return;
    const t = setInterval(() => {
      loadDocs(selectedId).catch(() => undefined);
    }, 2000);
    return () => clearInterval(t);
  }, [open, selectedId, docs, loadDocs]);

  if (!open) return null;

  const createKb = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setError('');
    try {
      const kb = await kbApi.create({ name: newName.trim() });
      setNewName('');
      await loadKbs();
      setSelectedId(kb.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onUpload = async (files: FileList | null) => {
    if (!selectedId || !files?.length) return;
    setBusy(true);
    setError('');
    try {
      for (const file of Array.from(files)) {
        await docApi.upload(selectedId, file);
      }
      await loadDocs(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onParse = async (docId: string) => {
    if (!selectedId) return;
    setBusy(true);
    setError('');
    try {
      await docApi.parse(selectedId, docId);
      await loadDocs(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onPreview = async (docId: string) => {
    if (!selectedId) return;
    setBusy(true);
    setError('');
    try {
      const res = await docApi.preview(selectedId, docId);
      setPreview({ doc: res.document, chunks: res.chunks, total: res.totalChunks });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDeleteDoc = async (docId: string) => {
    if (!selectedId) return;
    if (!confirm('Delete this document?')) return;
    await docApi.remove(selectedId, docId);
    await loadDocs(selectedId);
  };

  const onDeleteKb = async (id: string) => {
    if (!confirm('Delete this knowledge base and its documents?')) return;
    await kbApi.remove(id);
    setSelectedId(null);
    await loadKbs();
    setDocs([]);
  };

  return (
    <aside className="kb-panel">
      <div className="kb-panel-header">
        <h3>Knowledge</h3>
        <button className="btn btn-ghost" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="kb-panel-body">
        {error && <p className="error-text">{error}</p>}

        <div className="kb-create-row">
          <input
            placeholder="New knowledge base name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createKb()}
          />
          <button className="btn" type="button" disabled={busy} onClick={createKb}>
            Create
          </button>
        </div>

        <div className="sidebar-section-title">My knowledge bases</div>
        {kbs.length === 0 && <p className="empty-hint">No knowledge bases yet.</p>}
        {kbs.map((kb) => (
          <button
            key={kb.id}
            type="button"
            className={`kb-item ${selectedId === kb.id ? 'active' : ''}`}
            onClick={() => setSelectedId(kb.id)}
          >
            <span>
              {kb.name}
              {typeof kb.documentCount === 'number' ? ` · ${kb.documentCount}` : ''}
            </span>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ padding: '2px 6px' }}
              onClick={(e) => {
                e.stopPropagation();
                onDeleteKb(kb.id);
              }}
            >
              ×
            </button>
          </button>
        ))}

        {selectedId && (
          <>
            <div className="sidebar-section-title" style={{ marginTop: 16 }}>
              Documents
            </div>
            <div
              className="upload-zone"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                onUpload(e.dataTransfer.files);
              }}
            >
              Drop files or click to upload
              <div style={{ fontSize: '0.8rem', marginTop: 4 }}>PDF, TXT, MD, …</div>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={(e) => onUpload(e.target.files)}
              />
            </div>

            <div className="doc-list">
              {docs.length === 0 && <p className="empty-hint">No documents yet.</p>}
              {docs.map((doc) => (
                <div key={doc.id} className="doc-card">
                  <h4>{doc.name}</h4>
                  <div className="doc-meta">
                    <span className={`badge ${doc.status}`}>{doc.status}</span>
                    {' · '}
                    {formatBytes(doc.sizeBytes)}
                    {' · '}
                    {doc.chunkCount} chunks
                    {doc.status === 'running' &&
                      ` · ${Math.round((doc.progress || 0) * 100)}%`}
                  </div>
                  <div className="doc-actions">
                    <button
                      className="btn btn-secondary"
                      type="button"
                      disabled={busy || doc.status === 'running'}
                      onClick={() => onParse(doc.id)}
                    >
                      Parse / Cut chunks
                    </button>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => onPreview(doc.id)}
                    >
                      Preview
                    </button>
                    <button
                      className="btn btn-danger"
                      type="button"
                      disabled={busy}
                      onClick={() => onDeleteDoc(doc.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {preview && (
        <div className="preview-modal-backdrop" onClick={() => setPreview(null)}>
          <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>
                Preview · {preview.doc.name} ({preview.total} chunks)
              </h3>
              <button className="btn btn-ghost" type="button" onClick={() => setPreview(null)}>
                Close
              </button>
            </header>
            <div className="body">
              <p className="doc-meta">
                status={preview.doc.status} · progress=
                {Math.round((preview.doc.progress || 0) * 100)}% ·{' '}
                {preview.doc.progressMsg || ''}
              </p>
              {preview.chunks.length === 0 && (
                <p className="empty-hint">
                  No chunks yet. Click <strong>Parse / Cut chunks</strong> first.
                </p>
              )}
              {preview.chunks.map((c, i) => (
                <div key={c.id || i} className="chunk-item">
                  <div style={{ color: 'var(--text-tertiary)', marginBottom: 6, fontSize: '0.75rem' }}>
                    #{i + 1} · {c.id}
                  </div>
                  {c.content}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
