import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Folder, Upload, X } from 'lucide-react'
import {
  authApi,
  docApi,
  kbApi,
  type DocumentItem,
  type KnowledgeBase,
  type KnowledgeBaseMember,
  type KnowledgeBaseMemberRole,
  type StorageUsage,
} from '../services/api'
import DocumentPreviewPage from './DocumentPreviewPage'

const AVATAR_COLORS = ['#ea580c', '#2563eb', '#db2777', '#059669', '#7c3aed', '#d97706', '#0891b2', '#4f46e5']

function formatBytes(n: number) {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
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
  const [newVisibility, setNewVisibility] = useState<'private' | 'public'>('private')
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
  const [members, setMembers] = useState<KnowledgeBaseMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [shareCandidates, setShareCandidates] = useState<Array<{ id: string; username: string }>>([])
  const [shareUserId, setShareUserId] = useState('')
  const [shareRole, setShareRole] = useState<KnowledgeBaseMemberRole>('viewer')
  const [shareError, setShareError] = useState('')
  const [storage, setStorage] = useState<StorageUsage | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)

  const loadStorage = useCallback(async () => {
    try {
      const s = await authApi.storage()
      setStorage(s)
    } catch {
      // Non-fatal: upload still works; bar just hidden if this fails.
    }
  }, [])

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

  const loadSharePanel = useCallback(async (kbId: string) => {
    setMembersLoading(true)
    setShareError('')
    try {
      const [membersRes, candidatesRes] = await Promise.all([
        kbApi.listMembers(kbId),
        kbApi.listShareCandidates(kbId),
      ])
      setMembers(membersRes.items)
      setShareCandidates(candidatesRes.items)
      setShareUserId(prev =>
        candidatesRes.items.some(u => u.id === prev) ? prev : candidatesRes.items[0]?.id || '',
      )
    } catch (e) {
      setMembers([])
      setShareCandidates([])
      setShareUserId('')
      setShareError(e instanceof Error ? e.message : String(e))
    } finally {
      setMembersLoading(false)
    }
  }, [])

  const selectedKb = useMemo(() => kbs.find(k => k.id === selectedId) ?? null, [kbs, selectedId])

  const canEditContent = useMemo(() => {
    if (!selectedKb) return false
    if (selectedKb.isOwner || selectedKb.myRole === 'owner') return true
    return selectedKb.myRole === 'editor'
  }, [selectedKb])

  const canAdminKb = useMemo(() => {
    if (!selectedKb) return false
    return selectedKb.isOwner || selectedKb.myRole === 'owner'
  }, [selectedKb])

  useEffect(() => {
    loadKbs().catch(e => setError(e instanceof Error ? e.message : String(e)))
    void loadStorage()
  }, [loadKbs, loadStorage])

  useEffect(() => {
    if (!selectedId) {
      setDocs([])
      setSelectedDocIds(new Set())
      setDocsLoading(false)
      setMembers([])
      setShareCandidates([])
      setShareUserId('')
      setShareRole('viewer')
      setShareError('')
      return
    }
    setDocs([])
    loadDocs(selectedId).catch(e => setError(e instanceof Error ? e.message : String(e)))
  }, [selectedId, loadDocs])

  useEffect(() => {
    if (!selectedId || !canAdminKb) {
      setMembers([])
      setShareCandidates([])
      setShareUserId('')
      return
    }
    void loadSharePanel(selectedId)
  }, [selectedId, canAdminKb, loadSharePanel])

  useEffect(() => {
    if (!selectedId) return
    const hasRunning = docs.some(d => d.status === 'running')
    if (!hasRunning) return
    const t = setInterval(() => {
      loadDocs(selectedId, { quiet: true }).catch(() => undefined)
    }, 2000)
    return () => clearInterval(t)
  }, [selectedId, docs, loadDocs])

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
    setNewVisibility('private')
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
      setError('Please enter a name for your knowledge base.')
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
        visibility: newVisibility,
        parserConfig: {
          layout_recognize: pdfParser,
          chunk_token_num: Math.round(chunkTokenNum)
        }
      })
      setNewName('')
      setNewVisibility('private')
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

  const pendingTotalBytes = useMemo(
    () => pendingFiles.reduce((s, f) => s + f.size, 0),
    [pendingFiles],
  )

  const storageWarning = useMemo(() => {
    if (!storage) return null
    if (storage.usageRatio >= 1 || storage.remainingBytes <= 0) {
      return {
        level: 'full' as const,
        text: `Storage full (${formatBytes(storage.usedBytes)} / ${formatBytes(storage.quotaBytes)}). Existing files are kept, but you cannot upload more until you free space or an admin raises your quota.`,
      }
    }
    if (storage.usageRatio >= 0.95) {
      return {
        level: 'critical' as const,
        text: `Almost full (${Math.round(storage.usageRatio * 100)}% used). Only ${formatBytes(storage.remainingBytes)} remaining.`,
      }
    }
    if (storage.usageRatio >= 0.8) {
      return {
        level: 'warn' as const,
        text: `Running low on storage (${Math.round(storage.usageRatio * 100)}% used). Total limit is for all your uploaded files combined.`,
      }
    }
    return null
  }, [storage])

  const pendingExceedsQuota = useMemo(() => {
    if (!storage || !pendingFiles.length) return false
    return pendingTotalBytes > storage.remainingBytes
  }, [storage, pendingFiles.length, pendingTotalBytes])

  const removePendingFile = (index: number) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== index))
  }

  const saveUpload = async () => {
    if (!selectedId || !pendingFiles.length) return
    if (storage && pendingTotalBytes > storage.remainingBytes) {
      setError(
        `Selected files (${formatBytes(pendingTotalBytes)}) exceed remaining storage (${formatBytes(storage.remainingBytes)} of ${formatBytes(storage.quotaBytes)} total).`,
      )
      return
    }
    setBusy(true)
    setError('')
    try {
      let remaining = storage?.remainingBytes
      for (const file of pendingFiles) {
        if (remaining !== undefined && file.size > remaining) {
          throw new Error(
            `File "${file.name}" (${formatBytes(file.size)}) exceeds remaining storage (${formatBytes(remaining)}).`,
          )
        }
        const doc = await docApi.upload(selectedId, file)
        if (remaining !== undefined) remaining -= file.size
        if (parseOnCreation && doc?.id) {
          await docApi.parse(selectedId, doc.id)
        }
      }
      setUploadOpen(false)
      setPendingFiles([])
      setUploadDragOver(false)
      await loadDocs(selectedId, { quiet: true })
      await loadKbs({ quiet: true })
      await loadStorage()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      await loadStorage()
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
    await loadStorage()
  }

  const onDeleteKb = async (id: string) => {
    if (!confirm('Delete this knowledge base and its documents from My Knowledge Base?')) return
    await kbApi.remove(id)
    if (selectedId === id) setSelectedId(null)
    await loadKbs({ quiet: true })
    setDocs([])
    await loadStorage()
  }

  const onToggleVisibility = async () => {
    if (!selectedKb || !canAdminKb) return
    const next = selectedKb.visibility === 'public' ? 'private' : 'public'
    setBusy(true)
    setError('')
    try {
      const updated = await kbApi.update(selectedKb.id, { visibility: next })
      setKbs(prev => prev.map(k => (k.id === updated.id ? { ...k, ...updated } : k)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onAddMember = async () => {
    if (!selectedKb || !canAdminKb) return
    const candidate = shareCandidates.find(u => u.id === shareUserId)
    if (!candidate) {
      setShareError('Select a user to share with.')
      return
    }
    setBusy(true)
    setShareError('')
    try {
      await kbApi.addMember(selectedKb.id, { username: candidate.username, role: shareRole })
      setShareRole('viewer')
      await loadSharePanel(selectedKb.id)
    } catch (e) {
      setShareError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onChangeMemberRole = async (userId: string, role: KnowledgeBaseMemberRole) => {
    if (!selectedKb || !canAdminKb) return
    setBusy(true)
    setShareError('')
    try {
      const updated = await kbApi.updateMember(selectedKb.id, userId, { role })
      setMembers(prev => prev.map(m => (m.userId === userId ? updated : m)))
    } catch (e) {
      setShareError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onRemoveMember = async (userId: string, username: string) => {
    if (!selectedKb || !canAdminKb) return
    if (!confirm(`Remove access for ${username}?`)) return
    setBusy(true)
    setShareError('')
    try {
      await kbApi.removeMember(selectedKb.id, userId)
      await loadSharePanel(selectedKb.id)
    } catch (e) {
      setShareError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
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

  /** Account-level total storage bar (shared by list + detail views). */
  const renderStorageBar = (className = '') => {
    if (!storage) return null
    const tone =
      storageWarning?.level === 'full' || storageWarning?.level === 'critical'
        ? ' kb-storage-bar-critical'
        : storageWarning?.level === 'warn'
          ? ' kb-storage-bar-warn'
          : ''
    return (
      <div
        className={`kb-storage-bar${tone}${className ? ` ${className}` : ''}`}
        title="Total size of all files you have uploaded (not per file)."
      >
        <div className="kb-storage-bar-head">
          <span className="kb-storage-bar-label">Storage</span>
          <span className="kb-storage-bar-values">
            {formatBytes(storage.usedBytes)} / {formatBytes(storage.quotaBytes)}
            <span className="kb-storage-bar-remaining">
              · {formatBytes(storage.remainingBytes)} free
            </span>
          </span>
        </div>
        <div className="kb-storage-track" aria-hidden>
          <div
            className="kb-storage-fill"
            style={{ width: `${Math.min(100, Math.round(storage.usageRatio * 100))}%` }}
          />
        </div>
        <p className="kb-storage-hint">
          {storageWarning
            ? storageWarning.text
            : 'Quota is the total for all your uploaded files combined, not a single-file limit.'}
        </p>
      </div>
    )
  }

  /* ── My Knowledge Base list (full page) ── */
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
                My Knowledge Base
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
              My Knowledge Base
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
                + Create knowledge base
              </button>
            </div>
          </div>

          {renderStorageBar('kb-storage-bar-list')}

          {error && <p className="error-text">{error}</p>}

          {kbsLoading ? (
            <div className="kb-dataset-grid" aria-busy="true" aria-label="Loading My Knowledge Base">
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
                {kbs.length === 0
                  ? 'No knowledge bases in My Knowledge Base yet. Create one to upload documents.'
                  : 'No knowledge bases match your search.'}
              </p>
              {kbs.length === 0 && (
                <button className="btn" type="button" onClick={openCreateModal}>
                  + Create knowledge base
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
                      <div className="kb-dataset-card-name-row">
                        <div className="kb-dataset-card-name" title={kb.name}>
                          {kb.name}
                        </div>
                        <span
                          className={`kb-visibility-badge ${kb.visibility === 'public' ? 'public' : 'private'}`}
                          title={
                            kb.visibility === 'public'
                              ? 'Public — any logged-in user can use'
                              : 'Private — owner and people shared with'
                          }
                        >
                          {kb.visibility === 'public' ? 'Public' : 'Private'}
                        </span>
                        {!kb.isOwner && kb.myRole && kb.myRole !== 'owner' ? (
                          <span className="kb-visibility-badge shared" title={`Shared with you as ${kb.myRole}`}>
                            Shared
                          </span>
                        ) : null}
                      </div>
                      <div className="kb-dataset-card-meta">
                        {kb.documentCount ?? 0} {(kb.documentCount ?? 0) === 1 ? 'file' : 'files'}
                        {!kb.isOwner && kb.ownerUsername ? ` · by ${kb.ownerUsername}` : ''}
                        {!kb.isOwner && kb.myRole === 'editor' ? ' · editor' : ''}
                        {!kb.isOwner && kb.myRole === 'viewer' && kb.visibility !== 'public' ? ' · viewer' : ''}
                      </div>
                      <div className="kb-dataset-card-meta">{formatDateTime(kb.createdAt)}</div>
                    </div>
                  </div>
                  {kb.isOwner ? (
                    <span
                      className="kb-dataset-card-delete"
                      role="button"
                      tabIndex={0}
                      title="Delete knowledge base"
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
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </div>

        {createOpen && (
          <div className="kb-modal-backdrop" role="presentation" onClick={closeCreateModal}>
            <div className="kb-modal" role="dialog" aria-labelledby="create-dataset-title" onClick={e => e.stopPropagation()}>
              <h2 id="create-dataset-title">Create knowledge base</h2>
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
                <span className="kb-visibility-label" id="kb-visibility-label">
                  Visibility
                </span>
                <div className="kb-visibility-toggle" role="radiogroup" aria-labelledby="kb-visibility-label">
                  <label className={`kb-visibility-option${newVisibility === 'private' ? ' active' : ''}`}>
                    <input
                      type="radio"
                      name="kb-visibility"
                      value="private"
                      checked={newVisibility === 'private'}
                      disabled={busy}
                      onChange={() => setNewVisibility('private')}
                    />
                    <span className="kb-visibility-option-title">Private</span>
                    <span className="kb-visibility-option-hint">Only you (and people you share with)</span>
                  </label>
                  <label className={`kb-visibility-option${newVisibility === 'public' ? ' active' : ''}`}>
                    <input
                      type="radio"
                      name="kb-visibility"
                      value="public"
                      checked={newVisibility === 'public'}
                      disabled={busy}
                      onChange={() => setNewVisibility('public')}
                    />
                    <span className="kb-visibility-option-title">Public</span>
                    <span className="kb-visibility-option-hint">Any logged-in user can use</span>
                  </label>
                </div>
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

  /* ── My Knowledge Base detail: files table (full page) ── */
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
              My Knowledge Base
            </button>
          </nav>
        </div>
      </header>

      <div className="kb-detail-layout">
        <aside className="kb-detail-rail">
          <button type="button" className="kb-detail-kb-card" onClick={() => setSelectedId(null)} title="Back to My Knowledge Base">
            <div className="kb-dataset-avatar kb-dataset-avatar-lg" style={{ background: avatarColor(selectedKb?.name || '') }}>
              {initial(selectedKb?.name || '')}
            </div>
            <div className="kb-detail-kb-info">
              <div className="kb-detail-kb-name" title={selectedKb?.name}>
                {selectedKb?.name || 'My Knowledge Base'}
              </div>
              <div className="kb-detail-kb-meta">
                {selectedKb?.documentCount ?? docs.length} {(selectedKb?.documentCount ?? docs.length) === 1 ? 'file' : 'files'}
                {selectedKb && !selectedKb.isOwner && selectedKb.ownerUsername
                  ? ` · by ${selectedKb.ownerUsername}`
                  : ''}
              </div>
              <div className="kb-detail-kb-meta">Created {selectedKb ? formatDateShort(selectedKb.createdAt) : '—'}</div>
              {selectedKb ? (
                <div className="kb-detail-kb-meta">
                  <span
                    className={`kb-visibility-badge ${selectedKb.visibility === 'public' ? 'public' : 'private'}`}
                  >
                    {selectedKb.visibility === 'public' ? 'Public' : 'Private'}
                  </span>
                </div>
              ) : null}
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

          {canAdminKb && selectedKb ? (
            <div className="kb-detail-visibility-panel">
              <div className="kb-detail-visibility-label">Visibility</div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => void onToggleVisibility()}
                title="Toggle private / public"
              >
                Make {selectedKb.visibility === 'public' ? 'private' : 'public'}
              </button>
              <p className="field-hint">
                {selectedKb.visibility === 'public'
                  ? 'Any logged-in user can use this knowledge base in chat and view files.'
                  : 'Only you and people you share with can access this knowledge base.'}
              </p>

              <div className="kb-detail-visibility-label" style={{ marginTop: 8 }}>
                Share with users
              </div>
              <div className="kb-share-form">
                <select
                  className="kb-share-user-select"
                  value={shareUserId}
                  disabled={busy || membersLoading || shareCandidates.length === 0}
                  onChange={e => setShareUserId(e.target.value)}
                  aria-label="User to share with"
                >
                  {shareCandidates.length === 0 ? (
                    <option value="">No users available</option>
                  ) : (
                    shareCandidates.map(u => (
                      <option key={u.id} value={u.id}>
                        {u.username}
                      </option>
                    ))
                  )}
                </select>
                <select
                  className="kb-share-role-select"
                  value={shareRole}
                  disabled={busy || shareCandidates.length === 0}
                  onChange={e => setShareRole(e.target.value as KnowledgeBaseMemberRole)}
                  aria-label="Share role"
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || !shareUserId || shareCandidates.length === 0}
                  onClick={() => void onAddMember()}
                >
                  Add
                </button>
              </div>
              <p className="field-hint">
                {shareCandidates.length === 0 && !membersLoading
                  ? 'All other users already have access, or no other accounts exist.'
                  : 'Viewer: use in chat & preview. Editor: also upload/parse/delete files.'}
              </p>
              {shareError ? <p className="error-text">{shareError}</p> : null}
              {membersLoading ? (
                <p className="field-hint">Loading members…</p>
              ) : members.length === 0 ? (
                <p className="field-hint">Not shared with anyone yet.</p>
              ) : (
                <ul className="kb-share-member-list">
                  {members.map(m => (
                    <li key={m.userId} className="kb-share-member-row">
                      <span className="kb-share-member-name" title={m.username}>
                        {m.username}
                      </span>
                      <select
                        className="kb-share-role-select"
                        value={m.role}
                        disabled={busy}
                        onChange={e =>
                          void onChangeMemberRole(m.userId, e.target.value as KnowledgeBaseMemberRole)
                        }
                        aria-label={`Role for ${m.username}`}
                      >
                        <option value="viewer">Viewer</option>
                        <option value="editor">Editor</option>
                      </select>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={busy}
                        onClick={() => void onRemoveMember(m.userId, m.username)}
                        title={`Remove ${m.username}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          <div className="kb-detail-rail-footer">
            <button type="button" className="btn btn-ghost" onClick={() => setSelectedId(null)}>
              ← My Knowledge Bases
            </button>
          </div>
        </aside>

        <section className="kb-files-panel">
          <div className="kb-files-header">
            <div>
              <h2 className="kb-files-title">Files</h2>
              <p className="kb-files-subtitle">
                {canEditContent
                  ? 'Please wait for your files to finish parsing before starting an AI-powered chat.'
                  : 'Read-only access. You can browse and preview files; only the owner can manage content.'}
              </p>
            </div>
            <div className="kb-files-header-actions">
              <input
                className="kb-search-input"
                type="search"
                placeholder="Search"
                value={docSearch}
                onChange={e => setDocSearch(e.target.value)}
              />
              {canEditContent ? (
                <button
                  className="btn"
                  type="button"
                  disabled={busy || (!!storage && storage.remainingBytes <= 0)}
                  onClick={openUploadModal}
                  title={
                    storage && storage.remainingBytes <= 0
                      ? 'Storage full — delete files or ask an admin to raise your quota'
                      : 'Upload files'
                  }
                >
                  + Add file
                </button>
              ) : null}
            </div>
          </div>

          {canEditContent ? renderStorageBar() : null}

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
                          {canEditContent ? (
                            doc.status === 'running' ? (
                              <button
                                className="btn btn-secondary btn-sm"
                                type="button"
                                disabled={busy}
                                onClick={() => void onStopParse(doc.id)}
                              >
                                Stop
                              </button>
                            ) : (
                              <button
                                className="btn btn-secondary btn-sm"
                                type="button"
                                disabled={busy}
                                onClick={() => void onParse(doc.id)}
                              >
                                {doc.status === 'done' ? 'Re-parse' : 'Parse'}
                              </button>
                            )
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <div className="kb-action-cell">
                          <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => setPreviewDoc(doc)}>
                            Preview
                          </button>
                          {canEditContent ? (
                            <button
                              className="btn btn-danger btn-sm"
                              type="button"
                              disabled={busy}
                              onClick={() => void onDeleteDoc(doc.id)}
                            >
                              Delete
                            </button>
                          ) : null}
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

            {storage ? (
              <div
                className={`kb-storage-bar kb-storage-bar-modal${
                  storageWarning?.level === 'full' || storageWarning?.level === 'critical'
                    ? ' kb-storage-bar-critical'
                    : storageWarning?.level === 'warn'
                      ? ' kb-storage-bar-warn'
                      : ''
                }`}
              >
                <div className="kb-storage-bar-head">
                  <span className="kb-storage-bar-label">Your storage</span>
                  <span className="kb-storage-bar-values">
                    {formatBytes(storage.usedBytes)} / {formatBytes(storage.quotaBytes)}
                  </span>
                </div>
                <div className="kb-storage-track" aria-hidden>
                  <div
                    className="kb-storage-fill"
                    style={{ width: `${Math.min(100, Math.round(storage.usageRatio * 100))}%` }}
                  />
                </div>
                <p className="kb-storage-hint">
                  Total for all files you upload. Remaining: {formatBytes(storage.remainingBytes)}.
                  {storageWarning ? ` ${storageWarning.text}` : ''}
                </p>
              </div>
            ) : null}

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
                {storage
                  ? ` Storage remaining: ${formatBytes(storage.remainingBytes)} of ${formatBytes(storage.quotaBytes)} total.`
                  : ''}
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
              <>
                <ul className="kb-upload-file-list">
                  {pendingFiles.map((file, index) => {
                    const over = !!storage && file.size > storage.remainingBytes
                    return (
                      <li
                        key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                        className={`kb-upload-file-item${over ? ' kb-upload-file-item-over' : ''}`}
                      >
                        <FileText size={14} aria-hidden />
                        <span className="kb-upload-file-name" title={file.webkitRelativePath || file.name}>
                          {file.webkitRelativePath || file.name}
                        </span>
                        <span className="kb-upload-file-size">{formatBytes(file.size)}</span>
                        {over ? (
                          <span className="kb-upload-file-over-tag" title="Exceeds remaining storage">
                            Over quota
                          </span>
                        ) : null}
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
                    )
                  })}
                </ul>
                {storage ? (
                  <p className={`kb-upload-selected-summary${pendingExceedsQuota ? ' is-over' : ''}`}>
                    Selected {formatBytes(pendingTotalBytes)}
                    {pendingExceedsQuota
                      ? ` · exceeds remaining ${formatBytes(storage.remainingBytes)}`
                      : ` · remaining ${formatBytes(storage.remainingBytes)}`}
                  </p>
                ) : null}
              </>
            )}

            {error && uploadOpen ? <p className="error-text">{error}</p> : null}

            <div className="kb-modal-actions">
              <button className="btn btn-secondary" type="button" disabled={busy} onClick={closeUploadModal}>
                Cancel
              </button>
              <button
                className="btn kb-upload-save"
                type="button"
                disabled={busy || pendingFiles.length === 0 || pendingExceedsQuota}
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
