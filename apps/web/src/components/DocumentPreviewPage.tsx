import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import {
  docApi,
  type ChunkItem,
  type DocumentItem,
} from '../services/api';
import { fileKind } from '../utils/fileKind';
import PdfHighlightViewer, { positionsToBoxes } from './PdfHighlightViewer';

const ExcelPreview = lazy(() => import('./office/ExcelPreview'));
const PptPreview = lazy(() => import('./office/PptPreview'));
const DocxPreview = lazy(() => import('./office/DocxPreview'));

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render untrusted file/chunk text as HTML for layout only.
 * Always escape — never pass through raw HTML (stored XSS).
 */
function toHtmlContent(content: string, { ellipsis = false, maxLen = 220 } = {}) {
  let text = content || '';
  if (ellipsis && text.length > maxLen) {
    text = `${text.slice(0, maxLen)}…`;
  }
  return escapeHtml(text).replace(/\n/g, '<br />');
}

function chunkHasPositions(c: ChunkItem) {
  return Array.isArray(c.positions) && c.positions.some((p) => Array.isArray(p) && p.length >= 5);
}

const PAGE_SIZE = 30;

export default function DocumentPreviewPage({
  kbId,
  document,
  onBack,
}: {
  kbId: string;
  document: DocumentItem;
  onBack: () => void;
}) {
  const [chunks, setChunks] = useState<ChunkItem[]>([]);
  const [total, setTotal] = useState(document.chunkCount || 0);
  const [page, setPage] = useState(1);
  const [keywords, setKeywords] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [chunkBusy, setChunkBusy] = useState(false);
  const [chunkError, setChunkError] = useState('');
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileError, setFileError] = useState('');
  const [fileLoading, setFileLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'full' | 'ellipse'>('full');
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null);

  const kind = useMemo(() => fileKind(document.name), [document.name]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const selectedChunk = useMemo(
    () => chunks.find((c) => c.id === selectedChunkId) ?? null,
    [chunks, selectedChunkId],
  );

  const pdfHighlights = useMemo(
    () => positionsToBoxes(selectedChunk?.positions),
    [selectedChunk],
  );

  const loadChunks = useCallback(
    async (nextPage: number, nextKeywords: string) => {
      setChunkBusy(true);
      setChunkError('');
      try {
        const res = await docApi.chunks(kbId, document.id, {
          page: nextPage,
          pageSize: PAGE_SIZE,
          keywords: nextKeywords || undefined,
        });
        setChunks(res.chunks);
        setTotal(res.total);
        setPage(res.page || nextPage);
        // Keep selection if still on this page; otherwise clear
        setSelectedChunkId((prev) =>
          prev && res.chunks.some((c) => c.id === prev) ? prev : null,
        );
      } catch (e) {
        setChunkError(e instanceof Error ? e.message : String(e));
      } finally {
        setChunkBusy(false);
      }
    },
    [kbId, document.id],
  );

  useEffect(() => {
    void loadChunks(1, '');
  }, [loadChunks]);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    setFileLoading(true);
    setFileError('');
    setFileUrl(null);
    setFileText(null);

    (async () => {
      try {
        const { blob, objectUrl } = await docApi.fetchFileBlob(kbId, document.id);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        revoked = objectUrl;
        const k = fileKind(document.name);
        if (k === 'text' || k === 'html' || blob.type.startsWith('text/') || blob.type.includes('html')) {
          const text = await blob.text();
          if (!cancelled) setFileText(text);
          URL.revokeObjectURL(objectUrl);
          revoked = null;
        } else {
          setFileUrl(objectUrl);
        }
      } catch (e) {
        if (!cancelled) {
          setFileError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setFileLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [kbId, document.id, document.name]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const onSearch = () => {
    setKeywords(searchInput.trim());
    void loadChunks(1, searchInput.trim());
  };

  const onSelectChunk = (chunk: ChunkItem) => {
    setSelectedChunkId((prev) => (prev === chunk.id ? null : chunk.id));
  };

  const fileHtml = useMemo(() => {
    if (fileText === null) return null;
    return toHtmlContent(fileText);
  }, [fileText]);

  return (
    <div className="kb-page doc-preview-page">
      <header className="doc-preview-page-header">
        <button className="btn btn-secondary" type="button" onClick={onBack}>
          ← Back
        </button>
        <div className="doc-preview-page-heading">
          <h1 title={document.name}>{document.name}</h1>
          <div className="doc-preview-meta">
            Size: {formatBytes(document.sizeBytes)}
            {' · '}
            Uploaded: {formatTime(document.createdAt)}
            {' · '}
            <span className={`badge ${document.status}`}>{document.status}</span>
            {total > 0 ? ` · ${total} chunks` : ''}
            {kind === 'pdf' && selectedChunk && (
              <>
                {' · '}
                {pdfHighlights.length > 0
                  ? `Highlighting chunk on page ${pdfHighlights[0].pageNumber}`
                  : 'Selected chunk has no PDF positions'}
              </>
            )}
          </div>
        </div>
      </header>

      <div className="doc-preview-split">
        <section className="doc-preview-pane doc-preview-file" aria-label="Original document">
          <header className="doc-preview-file-header">
            <h3>Original file</h3>
          </header>

          <div className="doc-preview-file-body">
            {fileLoading && <p className="empty-hint">Loading document…</p>}
            {!fileLoading && fileError && (
              <div className="doc-preview-file-fallback">
                <p className="error-text">{fileError}</p>
                <p className="empty-hint">
                  Original file could not be loaded. Chunk results are still available on the right.
                </p>
              </div>
            )}
            {!fileLoading && !fileError && kind === 'pdf' && fileUrl && (
              <PdfHighlightViewer url={fileUrl} highlights={pdfHighlights} />
            )}
            {!fileLoading && !fileError && kind === 'image' && fileUrl && (
              <div className="doc-preview-image-wrap">
                <img src={fileUrl} alt={document.name} />
              </div>
            )}
            {!fileLoading && !fileError && kind === 'excel' && fileUrl && (
              <Suspense fallback={<p className="empty-hint">Loading spreadsheet viewer…</p>}>
                <ExcelPreview url={fileUrl} />
              </Suspense>
            )}
            {!fileLoading && !fileError && kind === 'ppt' && fileUrl && (
              <Suspense fallback={<p className="empty-hint">Loading presentation viewer…</p>}>
                <PptPreview url={fileUrl} />
              </Suspense>
            )}
            {!fileLoading && !fileError && kind === 'docx' && fileUrl && (
              <Suspense fallback={<p className="empty-hint">Loading Word viewer…</p>}>
                <DocxPreview url={fileUrl} />
              </Suspense>
            )}
            {!fileLoading && !fileError && fileHtml !== null && (
              <div
                className="doc-preview-html"
                dangerouslySetInnerHTML={{ __html: fileHtml }}
              />
            )}
            {!fileLoading && !fileError && kind === 'other' && fileUrl && (
              <div className="doc-preview-file-fallback">
                <p className="empty-hint">Inline preview is not available for this file type.</p>
                <a className="btn" href={fileUrl} download={document.name}>
                  Download file
                </a>
              </div>
            )}
          </div>
        </section>

        <section className="doc-preview-pane doc-preview-chunks" aria-label="Chunk results">
          <header className="doc-preview-chunks-header">
            <div className="doc-preview-chunks-title-row">
              <div>
                <h3>Chunk result</h3>
                <p className="doc-preview-subtitle">
                  {kind === 'pdf'
                    ? 'Click a chunk to highlight its source region in the PDF.'
                    : 'View the chunked segments used for embedding and retrieval.'}
                  {total > 0 ? ` · ${total} total` : ''}
                </p>
              </div>
            </div>

            <div className="doc-preview-toolbar">
              <div className="doc-preview-view-toggle">
                <button
                  type="button"
                  className={`btn btn-secondary ${viewMode === 'full' ? 'active' : ''}`}
                  onClick={() => setViewMode('full')}
                >
                  Full text
                </button>
                <button
                  type="button"
                  className={`btn btn-secondary ${viewMode === 'ellipse' ? 'active' : ''}`}
                  onClick={() => setViewMode('ellipse')}
                >
                  Ellipse
                </button>
              </div>
              <div className="doc-preview-search">
                <input
                  type="search"
                  placeholder="Search chunks…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      onSearch();
                    }
                  }}
                />
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={onSearch}
                  disabled={chunkBusy}
                >
                  Search
                </button>
              </div>
            </div>
          </header>

          <div className="doc-preview-chunks-body">
            {chunkError && <p className="error-text">{chunkError}</p>}
            {chunkBusy && chunks.length === 0 && <p className="empty-hint">Loading chunks…</p>}
            {!chunkBusy && chunks.length === 0 && (
              <p className="empty-hint">
                No chunks yet. Click <strong>Parse</strong> first, then preview again.
              </p>
            )}
            {chunks.map((c, i) => {
              const index = (page - 1) * PAGE_SIZE + i + 1;
              const html = toHtmlContent(c.content || '', {
                ellipsis: viewMode === 'ellipse',
              });
              const selected = selectedChunkId === c.id;
              const hasPos = chunkHasPositions(c);
              return (
                <article
                  key={c.id || i}
                  className={`doc-chunk-card ${selected ? 'selected' : ''} ${
                    kind === 'pdf' ? 'clickable' : ''
                  }`}
                  onClick={() => {
                    if (kind === 'pdf') onSelectChunk(c);
                  }}
                  onKeyDown={(e) => {
                    if (kind !== 'pdf') return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectChunk(c);
                    }
                  }}
                  role={kind === 'pdf' ? 'button' : undefined}
                  tabIndex={kind === 'pdf' ? 0 : undefined}
                  aria-pressed={kind === 'pdf' ? selected : undefined}
                >
                  <div className="doc-chunk-card-meta">
                    <span>#{index}</span>
                    {c.available === false && <span className="badge fail">unavailable</span>}
                    {kind === 'pdf' && (
                      <span className={`doc-chunk-pos-badge ${hasPos ? 'has-pos' : 'no-pos'}`}>
                        {hasPos ? '📍 has position' : 'no position'}
                      </span>
                    )}
                    <span className="doc-chunk-id" title={c.id}>
                      {c.id}
                    </span>
                  </div>
                  <div
                    className="doc-chunk-card-content doc-chunk-html"
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                </article>
              );
            })}
          </div>

          {total > PAGE_SIZE && (
            <footer className="doc-preview-pagination">
              <button
                className="btn btn-secondary"
                type="button"
                disabled={chunkBusy || page <= 1}
                onClick={() => void loadChunks(page - 1, keywords)}
              >
                Previous
              </button>
              <span>
                Page {page} / {totalPages}
              </span>
              <button
                className="btn btn-secondary"
                type="button"
                disabled={chunkBusy || page >= totalPages}
                onClick={() => void loadChunks(page + 1, keywords)}
              >
                Next
              </button>
            </footer>
          )}
        </section>
      </div>
    </div>
  );
}
