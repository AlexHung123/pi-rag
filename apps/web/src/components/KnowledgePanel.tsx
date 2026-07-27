import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Folder, Upload, X } from 'lucide-react'
import { docApi, kbApi, type DocumentItem, type KnowledgeBase } from '../services/api'
import DocumentPreviewPage from './DocumentPreviewPage'

const AVATAR_COLORS = ['#ea580c', '#2563eb', '#db2777', '#059669', '#7c3aed', '#d97706', '#0891b2', '#4f46e5']

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatDateTime(iso: string) {
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  } catch {
    return iso
  }
}

function formatDateShort(iso: string) {
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
  } catch {
    return iso
  }
}

function avatarColor(name: string) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

function initial(name: string) {
  return (name.trim().charAt(0) || 'D').toUpperCase()
}

/** Maps to RAGFlow parser_config.layout_recognize */
const PDF_PARSER_OPTIONS = [
  // {
  //   value: 'DeepDOC',
  //   label: 'DeepDOC',
  //   hint: 'Built-in RAGFlow PDF layout parser (default).',
  // },
  {
    value: 'mineru-from-env@MinerU',
    label: 'MinerU (from env)',
    hint: 'Uses MinerU configured on the RAGFlow host (MINERU_APISERVER, etc.).'
  }
  // {
  //   value: 'Plain Text',
  //   label: 'Plain Text',
  //   hint: 'Text extraction only — no layout analysis.',
  // },
  // {
  //   value: 'Docling',
  //   label: 'Docling',
  //   hint: 'Docling PDF parser (must be available on the RAGFlow host).',
  // },
] as const

type PdfParserValue = (typeof PDF_PARSER_OPTIONS)[number]['value']

const DEFAULT_PDF_PARSER: PdfParserValue = 'mineru-from-env@MinerU'

/** RAGFlow parser_config.chunk_token_num range for naive chunking */
const CHUNK_TOKEN_MIN = 1
const CHUNK_TOKEN_MAX = 2048
const DEFAULT_CHUNK_TOKEN_NUM = 512

export default function KnowledgePanel({ onBackToChat }: { onBackToChat: () => void }) {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [docs, setDocs] = useState<DocumentItem[]>([])
  const [newName, setNewName] = useState('')
  const [pdfParser, setPdfParser] = useState<PdfParserValue>(DEFAULT_PDF_PARSER)
  const [chunkTokenNum, setChunkTokenNum] = useState(DEFAULT_CHUNK_TOKEN_NUM)
  const [createOpen, setCreateOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadMode, setUploadMode] = useState<'files' | 'folder'>('files')
  const [parseOnCreation, setParseOnCreation] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [uploadDragOver, setUploadDragOver] = useState(false)
  const [search, setSearch] = useState('')
  const [docSearch, setDocSearch] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [kbsLoading, setKbsLoading] = useState(true)
  const [docsLoading, setDocsLoading] = useState(false)
  const [previewDoc, setPreviewDoc] = useState<DocumentItem | null>(null)
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set())
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)

  const loadKbs = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setKbsLoading(true)
    try {
      const res = await kbApi.list()
      setKbs(res.items)
      return res.items
    } finally {
      if (!opts?.quiet) setKbsLoading(false)
    }
  }, [])

  const loadDocs = useCallback(async (kbId: string, opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setDocsLoading(true)
    try {
      const res = await docApi.list(kbId)
      setDocs(res.items)
    } finally {
      if (!opts?.quiet) setDocsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadKbs().catch(e => setError(e instanceof Error ? e.message : String(e)))
  }, [loadKbs])

  useEffect(() => {
    if (!selectedId) {
      setDocs([])
      setSelectedDocIds(new Set())
      setDocsLoading(false)
      return
    }
    setDocs([])
    loadDocs(selectedId).catch(e => setError(e instanceof Error ? e.message : String(e)))
  }, [selectedId, loadDocs])

  useEffect(() => {
    if (!selectedId) return
    const hasRunning = docs.some(d => d.status === 'running')
    if (!hasRunning) return
    const t = setInterval(() => {
      loadDocs(selectedId, { quiet: true }).catch(() => undefined)
    }, 2000)
    return () => clearInterval(t)
  }, [selectedId, docs, loadDocs])

  const selectedKb = useMemo(() => kbs.find(k => k.id === selectedId) ?? null, [kbs, selectedId])

  const filteredKbs = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return kbs
    return kbs.filter(k => k.name.toLowerCase().includes(q))
  }, [kbs, search])

  const filteredDocs = useMemo(() => {
    const q = docSearch.trim().toLowerCase()
    if (!q) return docs
    return docs.filter(d => d.name.toLowerCase().includes(q))
  }, [docs, docSearch])

  const openCreateModal = () => {
    setError('')
    setNewName('')
    setPdfParser(DEFAULT_PDF_PARSER)
    setChunkTokenNum(DEFAULT_CHUNK_TOKEN_NUM)
    setCreateOpen(true)
  }

  const closeCreateModal = () => {
    if (busy) return
    setCreateOpen(false)
    setError('')
  }

  const createKb = async () => {
    const name = newName.trim()
    if (!name) {
      setError('Please enter a knowledge base name.')
      return
    }
    if (!Number.isFinite(chunkTokenNum) || chunkTokenNum < CHUNK_TOKEN_MIN || chunkTokenNum > CHUNK_TOKEN_MAX) {
      setError(`Chunk size must be between ${CHUNK_TOKEN_MIN} and ${CHUNK_TOKEN_MAX} tokens.`)
      return
    }
    setBusy(true)
    setError('')
    try {
      const kb = await kbApi.create({
        name,
        parserConfig: {
          layout_recognize: pdfParser,
          chunk_token_num: Math.round(chunkTokenNum)
        }
      })
      setNewName('')
      setPdfParser(DEFAULT_PDF_PARSER)
      setChunkTokenNum(DEFAULT_CHUNK_TOKEN_NUM)
      setCreateOpen(false)
      await loadKbs({ quiet: true })
      setSelectedId(kb.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const selectedPdfParser = useMemo(() => PDF_PARSER_OPTIONS.find(o => o.value === pdfParser) ?? PDF_PARSER_OPTIONS[0], [pdfParser])

  const openUploadModal = () => {
    setError('')
    setPendingFiles([])
    setParseOnCreation(false)
    setUploadMode('files')
    setUploadDragOver(false)
    setUploadOpen(true)
  }

  const closeUploadModal = () => {
    if (busy) return
    setUploadOpen(false)
    setPendingFiles([])
    setUploadDragOver(false)
    setError('')
    if (fileRef.current) fileRef.current.value = ''
    if (folderRef.current) folderRef.current.value = ''
  }

  const mergePendingFiles = (incoming: FileList | File[]) => {
    const next = Array.from(incoming).filter(f => f && f.size > 0)
    if (!next.length) return
    setPendingFiles(prev => {
      const seen = new Set(prev.map(f => `${f.name}:${f.size}:${f.lastModified}`))
      const merged = [...prev]
      for (const f of next) {
        const key = `${f.name}:${f.size}:${f.lastModified}`
        if (!seen.has(key)) {
          seen.add(key)
          merged.push(f)
        }
      }
      return merged
    })
  }

  const removePendingFile = (index: number) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== index))
  }

  const saveUpload = async () => {
    if (!selectedId || !pendingFiles.length) return
    setBusy(true)
    setError('')
    try {
      for (const file of pendingFiles) {
        const doc = await docApi.upload(selectedId, file)
        if (parseOnCreation && doc?.id) {
          await docApi.parse(selectedId, doc.id)
        }
      }
      setUploadOpen(false)
      setPendingFiles([])
      setUploadDragOver(false)
      await loadDocs(selectedId, { quiet: true })
      await loadKbs({ quiet: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
      if (folderRef.current) folderRef.current.value = ''
    }
  }

  const onParse = async (docId: string) => {
    if (!selectedId) return
    setBusy(true)
    setError('')
    try {
      await docApi.parse(selectedId, docId)
      await loadDocs(selectedId, { quiet: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onStopParse = async (docId: string) => {
    if (!selectedId) return
    setBusy(true)
    setError('')
    try {
      await docApi.stopParse(selectedId, docId)
      await loadDocs(selectedId, { quiet: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onDeleteDoc = async (docId: string) => {
    if (!selectedId) return
    if (!confirm('Delete this document?')) return
    await docApi.remove(selectedId, docId)
    setSelectedDocIds(prev => {
      const next = new Set(prev)
      next.delete(docId)
      return next
    })
    await loadDocs(selectedId, { quiet: true })
    await loadKbs({ quiet: true })
  }

  const onDeleteKb = async (id: string) => {
    if (!confirm('Delete this knowledge base and its documents?')) return
    await kbApi.remove(id)
    if (selectedId === id) setSelectedId(null)
    await loadKbs({ quiet: true })
    setDocs([])
  }

  const toggleDoc = (id: string) => {
    setSelectedDocIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAllDocs = () => {
    if (selectedDocIds.size === filteredDocs.length) {
      setSelectedDocIds(new Set())
    } else {
      setSelectedDocIds(new Set(filteredDocs.map(d => d.id)))
    }
  }

  /* ── Dataset list (full page) ── */
  if (!selectedId) {
    return (
      <div className="kb-page">
        <header className="kb-topbar">
          <div className="kb-topbar-left">
            <div className="kb-brand-mark" aria-hidden>
              <span />
            </div>
            <nav className="kb-top-nav" aria-label="Main">
              <button type="button" className="kb-top-nav-item" onClick={onBackToChat}>
                Chat
              </button>
              <button type="button" className="kb-top-nav-item active">
                Dataset
              </button>
            </nav>
          </div>
        </header>

        <div className="kb-page-body">
          <div className="kb-page-toolbar">
            <h1 className="kb-page-title">
              <span className="kb-page-title-icon" aria-hidden>
                ⬡
              </span>
              Dataset
            </h1>
            <div className="kb-page-toolbar-actions">
              <input
                className="kb-search-input"
                type="search"
                placeholder="Search"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <button className="btn" type="button" onClick={openCreateModal}>
                + Create dataset
              </button>
            </div>
          </div>

          {error && <p className="error-text">{error}</p>}

          {kbsLoading ? (
            <div className="kb-dataset-grid" aria-busy="true" aria-label="Loading datasets">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="kb-dataset-card kb-dataset-card-skeleton" aria-hidden>
                  <div className="kb-dataset-card-main">
                    <div className="kb-skeleton-avatar" />
                    <div className="kb-dataset-card-info">
                      <div className="kb-skeleton-line kb-skeleton-line-title" />
                      <div className="kb-skeleton-line kb-skeleton-line-meta" />
                      <div className="kb-skeleton-line kb-skeleton-line-meta" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : filteredKbs.length === 0 ? (
            <div className="kb-empty-state">
              <p className="empty-hint">
                {kbs.length === 0 ? 'No datasets yet. Create one to upload documents.' : 'No datasets match your search.'}
              </p>
              {kbs.length === 0 && (
                <button className="btn" type="button" onClick={openCreateModal}>
                  + Create dataset
                </button>
              )}
            </div>
          ) : (
            <div className="kb-dataset-grid">
              {filteredKbs.map(kb => (
                <button key={kb.id} type="button" className="kb-dataset-card" onClick={() => setSelectedId(kb.id)}>
                  <div className="kb-dataset-card-main">
                    <div className="kb-dataset-avatar" style={{ background: avatarColor(kb.name) }}>
                      {initial(kb.name)}
                    </div>
                    <div className="kb-dataset-card-info">
                      <div className="kb-dataset-card-name" title={kb.name}>
                        {kb.name}
                      </div>
                      <div className="kb-dataset-card-meta">
                        {kb.documentCount ?? 0} {(kb.documentCount ?? 0) === 1 ? 'file' : 'files'}
                      </div>
                      <div className="kb-dataset-card-meta">{formatDateTime(kb.createdAt)}</div>
                    </div>
                  </div>
                  <span
                    className="kb-dataset-card-delete"
                    role="button"
                    tabIndex={0}
                    title="Delete dataset"
                    onClick={e => {
                      e.stopPropagation()
                      void onDeleteKb(kb.id)
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        e.stopPropagation()
                        void onDeleteKb(kb.id)
                      }
                    }}
                  >
                    ×
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {createOpen && (
          <div className="kb-modal-backdrop" role="presentation" onClick={closeCreateModal}>
            <div className="kb-modal" role="dialog" aria-labelledby="create-dataset-title" onClick={e => e.stopPropagation()}>
              <h2 id="create-dataset-title">Create dataset</h2>
              {error && <p className="error-text">{error}</p>}
              <div className="field">
                <label htmlFor="kb-new-name">Name</label>
                <input
                  id="kb-new-name"
                  autoFocus
                  placeholder="e.g. Training Guide"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void createKb()
                    }
                  }}
                  disabled={busy}
                />
              </div>
              <div className="field">
                <label htmlFor="kb-pdf-parser">PDF parser</label>
                <select id="kb-pdf-parser" value={pdfParser} onChange={e => setPdfParser(e.target.value as PdfParserValue)} disabled={busy}>
                  {PDF_PARSER_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="field-hint">{selectedPdfParser.hint}</p>
              </div>
              <div className="field">
                <label htmlFor="kb-chunk-size">Chunk size (tokens)</label>
                <input
                  id="kb-chunk-size"
                  type="number"
                  min={CHUNK_TOKEN_MIN}
                  max={CHUNK_TOKEN_MAX}
                  step={1}
                  value={chunkTokenNum}
                  onChange={e => {
                    const n = Number(e.target.value)
                    setChunkTokenNum(Number.isFinite(n) ? n : DEFAULT_CHUNK_TOKEN_NUM)
                  }}
                  disabled={busy}
                />
                <p className="field-hint">
                  Target tokens per chunk when documents are parsed. Default {DEFAULT_CHUNK_TOKEN_NUM}; range {CHUNK_TOKEN_MIN}–
                  {CHUNK_TOKEN_MAX}.
                </p>
              </div>
              <div className="kb-modal-actions">
                <button className="btn btn-secondary" type="button" disabled={busy} onClick={closeCreateModal}>
                  Cancel
                </button>
                <button className="btn" type="button" disabled={busy} onClick={() => void createKb()}>
                  {busy ? 'Creating…' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  /* ── Document preview (full page) ── */
  if (previewDoc && selectedId) {
    return <DocumentPreviewPage kbId={selectedId} document={previewDoc} onBack={() => setPreviewDoc(null)} />
  }

  /* ── Dataset detail: files table (full page) ── */
  return (
    <div className="kb-page">
      <header className="kb-topbar">
        <div className="kb-topbar-left">
          <div className="kb-brand-mark" aria-hidden>
            <span />
          </div>
          <nav className="kb-top-nav" aria-label="Main">
            <button type="button" className="kb-top-nav-item" onClick={onBackToChat}>
              Chat
            </button>
            <button type="button" className="kb-top-nav-item active" onClick={() => setSelectedId(null)}>
              Dataset
            </button>
          </nav>
        </div>
      </header>

      <div className="kb-detail-layout">
        <aside className="kb-detail-rail">
          <button type="button" className="kb-detail-kb-card" onClick={() => setSelectedId(null)} title="Back to datasets">
            <div className="kb-dataset-avatar kb-dataset-avatar-lg" style={{ background: avatarColor(selectedKb?.name || '') }}>
              {initial(selectedKb?.name || '')}
            </div>
            <div className="kb-detail-kb-info">
              <div className="kb-detail-kb-name" title={selectedKb?.name}>
                {selectedKb?.name || 'Dataset'}
              </div>
              <div className="kb-detail-kb-meta">
                {selectedKb?.documentCount ?? docs.length} {(selectedKb?.documentCount ?? docs.length) === 1 ? 'file' : 'files'}
              </div>
              <div className="kb-detail-kb-meta">Created {selectedKb ? formatDateShort(selectedKb.createdAt) : '—'}</div>
            </div>
          </button>

          <nav className="kb-detail-nav">
            <button type="button" className="kb-detail-nav-item active">
              <span className="kb-detail-nav-icon" aria-hidden>
                📁
              </span>
              Files
            </button>
          </nav>

          <div className="kb-detail-rail-footer">
            <button type="button" className="btn btn-ghost" onClick={() => setSelectedId(null)}>
              ← All datasets
            </button>
          </div>
        </aside>

        <section className="kb-files-panel">
          <div className="kb-files-header">
            <div>
              <h2 className="kb-files-title">Files</h2>
              <p className="kb-files-subtitle">Please wait for your files to finish parsing before starting an AI-powered chat.</p>
            </div>
            <div className="kb-files-header-actions">
              <input
                className="kb-search-input"
                type="search"
                placeholder="Search"
                value={docSearch}
                onChange={e => setDocSearch(e.target.value)}
              />
              <button className="btn" type="button" disabled={busy} onClick={openUploadModal}>
                + Add file
              </button>
            </div>
          </div>

          {error && !uploadOpen && <p className="error-text">{error}</p>}

          <div className="kb-files-table-wrap">
            <table className="kb-files-table">
              <thead>
                <tr>
                  <th className="kb-col-check">
                    <input
                      type="checkbox"
                      checked={filteredDocs.length > 0 && selectedDocIds.size === filteredDocs.length}
                      onChange={toggleAllDocs}
                      aria-label="Select all"
                    />
                  </th>
                  <th>Name</th>
                  <th>Upload date</th>
                  <th>Enable</th>
                  <th>Chunks</th>
                  <th>Metadata</th>
                  <th>Parse</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {docsLoading ? (
                  <tr>
                    <td colSpan={8} className="kb-files-empty" aria-busy="true">
                      Loading files…
                    </td>
                  </tr>
                ) : filteredDocs.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="kb-files-empty">
                      No files yet. Add a file to get started.
                    </td>
                  </tr>
                ) : (
                  filteredDocs.map(doc => (
                    <tr key={doc.id}>
                      <td className="kb-col-check">
                        <input
                          type="checkbox"
                          checked={selectedDocIds.has(doc.id)}
                          onChange={() => toggleDoc(doc.id)}
                          aria-label={`Select ${doc.name}`}
                        />
                      </td>
                      <td>
                        <div className="kb-file-name" title={doc.name}>
                          {doc.name}
                        </div>
                        <div className="kb-file-sub">{formatBytes(doc.sizeBytes)}</div>
                      </td>
                      <td className="kb-cell-muted">{formatDateTime(doc.createdAt)}</td>
                      <td>
                        <label className="kb-switch" title="Available for retrieval when parsed">
                          <input type="checkbox" checked={doc.status === 'done'} readOnly disabled />
                          <span className="kb-switch-slider" />
                        </label>
                      </td>
                      <td className="kb-cell-muted">{doc.chunkCount}</td>
                      <td className="kb-cell-muted">—</td>
                      <td>
                        <div className="kb-parse-cell">
                          <span className={`badge ${doc.status}`}>
                            {doc.status === 'running' ? `${Math.round((doc.progress || 0) * 100)}%` : doc.status}
                          </span>
                          {doc.status === 'running' ? (
                            <button
                              className="btn btn-secondary btn-sm"
                              type="button"
                              disabled={busy}
                              onClick={() => void onStopParse(doc.id)}
                            >
                              Stop
                            </button>
                          ) : (
                            <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => void onParse(doc.id)}>
                              {doc.status === 'done' ? 'Re-parse' : 'Parse'}
                            </button>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="kb-action-cell">
                          <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => setPreviewDoc(doc)}>
                            Preview
                          </button>
                          <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={() => void onDeleteDoc(doc.id)}>
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {uploadOpen && (
        <div className="kb-modal-backdrop" role="presentation" onClick={closeUploadModal}>
          <div
            className="kb-modal kb-upload-modal"
            role="dialog"
            aria-labelledby="upload-file-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="kb-upload-modal-header">
              <h2 id="upload-file-title">Upload file</h2>
              <button
                type="button"
                className="kb-upload-modal-close"
                aria-label="Close"
                disabled={busy}
                onClick={closeUploadModal}
              >
                <X size={18} />
              </button>
            </div>

            {error && <p className="error-text">{error}</p>}

            <div className="kb-upload-parse-row">
              <span className="kb-upload-parse-label">Parse on creation</span>
              <label className="kb-switch" title="Start parsing immediately after upload">
                <input
                  type="checkbox"
                  checked={parseOnCreation}
                  disabled={busy}
                  onChange={e => setParseOnCreation(e.target.checked)}
                />
                <span className="kb-switch-slider" />
              </label>
            </div>

            <div className="kb-upload-mode-tabs" role="tablist" aria-label="Upload source">
              <button
                type="button"
                role="tab"
                aria-selected={uploadMode === 'files'}
                className={`kb-upload-mode-tab${uploadMode === 'files' ? ' active' : ''}`}
                disabled={busy}
                onClick={() => {
                  setUploadMode('files')
                  setPendingFiles([])
                  if (folderRef.current) folderRef.current.value = ''
                }}
              >
                <FileText size={15} aria-hidden />
                Files
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={uploadMode === 'folder'}
                className={`kb-upload-mode-tab${uploadMode === 'folder' ? ' active' : ''}`}
                disabled={busy}
                onClick={() => {
                  setUploadMode('folder')
                  setPendingFiles([])
                  if (fileRef.current) fileRef.current.value = ''
                }}
              >
                <Folder size={15} aria-hidden />
                Folder
              </button>
            </div>

            <div
              className={`kb-upload-dropzone${uploadDragOver ? ' drag-over' : ''}`}
              onDragOver={e => {
                e.preventDefault()
                setUploadDragOver(true)
              }}
              onDragLeave={e => {
                e.preventDefault()
                setUploadDragOver(false)
              }}
              onDrop={e => {
                e.preventDefault()
                setUploadDragOver(false)
                if (busy) return
                mergePendingFiles(e.dataTransfer.files)
              }}
              onClick={() => {
                if (busy) return
                if (uploadMode === 'folder') folderRef.current?.click()
                else fileRef.current?.click()
              }}
              role="button"
              tabIndex={0}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  if (busy) return
                  if (uploadMode === 'folder') folderRef.current?.click()
                  else fileRef.current?.click()
                }
              }}
            >
              <div className="kb-upload-dropzone-icon" aria-hidden>
                <Upload size={28} strokeWidth={1.5} />
              </div>
              <p className="kb-upload-dropzone-title">
                {uploadMode === 'folder'
                  ? 'Drag and drop a folder here to upload'
                  : 'Drag and drop your file here to upload'}
              </p>
              <p className="kb-upload-dropzone-hint">
                Supports single or batch file upload. PDF, TXT, MD, and other common document types.
                Click to browse{uploadMode === 'folder' ? ' a folder' : ''}.
              </p>
            </div>

            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={e => {
                if (e.target.files) mergePendingFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <input
              ref={folderRef}
              type="file"
              multiple
              hidden
              // Folder selection (Chromium / WebKit)
              {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
              onChange={e => {
                if (e.target.files) mergePendingFiles(e.target.files)
                e.target.value = ''
              }}
            />

            {pendingFiles.length > 0 && (
              <ul className="kb-upload-file-list">
                {pendingFiles.map((file, index) => (
                  <li key={`${file.name}-${file.size}-${file.lastModified}-${index}`} className="kb-upload-file-item">
                    <FileText size={14} aria-hidden />
                    <span className="kb-upload-file-name" title={file.webkitRelativePath || file.name}>
                      {file.webkitRelativePath || file.name}
                    </span>
                    <span className="kb-upload-file-size">{formatBytes(file.size)}</span>
                    <button
                      type="button"
                      className="kb-upload-file-remove"
                      aria-label={`Remove ${file.name}`}
                      disabled={busy}
                      onClick={() => removePendingFile(index)}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="kb-modal-actions">
              <button className="btn btn-secondary" type="button" disabled={busy} onClick={closeUploadModal}>
                Cancel
              </button>
              <button
                className="btn kb-upload-save"
                type="button"
                disabled={busy || pendingFiles.length === 0}
                onClick={() => void saveUpload()}
              >
                {busy ? 'Uploading…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
