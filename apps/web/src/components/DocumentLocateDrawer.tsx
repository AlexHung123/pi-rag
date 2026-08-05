import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import {
  docApi,
  type CitationSource,
  type ChunkItem,
  type DocumentItem,
} from '../services/api';
import { fileKind } from '../utils/fileKind';
import PdfHighlightViewer, { positionsToBoxes } from './PdfHighlightViewer';

const ExcelPreview = lazy(() => import('./office/ExcelPreview'));
const PptPreview = lazy(() => import('./office/PptPreview'));
const DocxPreview = lazy(() => import('./office/DocxPreview'));

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render untrusted file text as HTML for layout only.
 * Always escape — never pass through raw HTML (stored XSS).
 */
function toHtmlContent(content: string) {
  return escapeHtml(content).replace(/\n/g, '<br />');
}

async function resolveDocument(
  source: CitationSource,
): Promise<{ kbId: string; document: DocumentItem } | null> {
  const kbId = source.knowledgeBaseId;
  if (!kbId) return null;

  // Prefer direct get via list match; list is cheap and needed for name fallback.
  const { items } = await docApi.list(kbId);

  if (source.appDocumentId) {
    const byId = items.find((d) => d.id === source.appDocumentId);
    if (byId) return { kbId, document: byId };
  }

  // RAGFlow document id (from retrieval hit) → app document
  if (source.documentId) {
    const byRf = items.find(
      (d) => d.ragflowDocumentId === source.documentId || d.id === source.documentId,
    );
    if (byRf) return { kbId, document: byRf };
  }

  if (source.documentName) {
    const name = source.documentName.toLowerCase();
    const byName = items.find((d) => d.name.toLowerCase() === name);
    if (byName) return { kbId, document: byName };
    const byPartial = items.find(
      (d) =>
        d.name.toLowerCase().includes(name) || name.includes(d.name.toLowerCase()),
    );
    if (byPartial) return { kbId, document: byPartial };
  }

  return null;
}

function positionsFromChunk(chunk: ChunkItem | null | undefined): number[][] | undefined {
  if (!chunk?.positions?.length) return undefined;
  return chunk.positions;
}

/** Prefer retrieval positions; otherwise try to match a stored chunk for PDF highlight. */
async function resolvePositions(
  kbId: string,
  docId: string,
  source: CitationSource,
): Promise<number[][] | undefined> {
  if (Array.isArray(source.positions) && source.positions.length) {
    return source.positions;
  }

  try {
    // Page through a few batches looking for chunk id match
    for (let page = 1; page <= 5; page++) {
      const res = await docApi.chunks(kbId, docId, { page, pageSize: 50 });
      if (!res.chunks.length) break;

      let match: ChunkItem | undefined;
      if (source.id) {
        match = res.chunks.find((c) => c.id === source.id);
      }
      if (!match && source.content) {
        const needle = source.content.slice(0, 80).trim();
        if (needle.length >= 12) {
          match = res.chunks.find((c) => (c.content || '').includes(needle));
        }
      }
      if (match) {
        const pos = positionsFromChunk(match);
        if (pos?.length) return pos;
      }
      if (res.chunks.length < 50 || page * 50 >= res.total) break;
    }
  } catch {
    /* keep going without highlight */
  }
  return undefined;
}

export default function DocumentLocateDrawer({
  source,
  onClose,
}: {
  source: CitationSource;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [document, setDocument] = useState<DocumentItem | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const [positions, setPositions] = useState<number[][] | undefined>(undefined);

  const title = document?.name || source.documentName || 'Original file';
  const kind = useMemo(() => fileKind(title), [title]);
  const highlights = useMemo(() => positionsToBoxes(positions), [positions]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    (async () => {
      setLoading(true);
      setError('');
      setDocument(null);
      setFileUrl(null);
      setFileText(null);
      setPositions(undefined);

      try {
        const resolved = await resolveDocument(source);
        if (cancelled) return;
        if (!resolved) {
          setError(
            'Could not find this document in your knowledge bases. It may have been deleted.',
          );
          setLoading(false);
          return;
        }

        setDocument(resolved.document);
        const pos = await resolvePositions(
          resolved.kbId,
          resolved.document.id,
          source,
        );
        if (cancelled) return;
        setPositions(pos);

        const { blob, objectUrl: url } = await docApi.fetchFileBlob(
          resolved.kbId,
          resolved.document.id,
        );
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;

        const k = fileKind(resolved.document.name);
        if (k === 'text' || k === 'html') {
          const text = await blob.text();
          if (cancelled) return;
          setFileText(text);
          setFileUrl(url);
        } else {
          setFileUrl(url);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fileHtml = useMemo(() => {
    if (fileText === null) return null;
    return toHtmlContent(fileText);
  }, [fileText]);

  return (
    <div className="locate-drawer-root" role="dialog" aria-modal="true" aria-label="Original file">
      <button
        type="button"
        className="locate-drawer-backdrop"
        aria-label="Close original file"
        onClick={onClose}
      />
      <aside className="locate-drawer">
        <header className="locate-drawer-header">
          <div className="locate-drawer-heading">
            <h2 title={title}>{title}</h2>
            <p className="locate-drawer-sub">
              Original file
              {kind === 'pdf' && highlights.length > 0
                ? ` · Highlighting page ${highlights[0].pageNumber}`
                : ''}
              {source.knowledgeBaseName ? ` · ${source.knowledgeBaseName}` : ''}
            </p>
          </div>
          <button type="button" className="locate-drawer-close" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="locate-drawer-body">
          <section className="locate-drawer-file" aria-label="Original document">
            <header className="locate-drawer-file-header">
              <h3>Original file</h3>
            </header>
            <div className="locate-drawer-file-body">
              {loading && <p className="empty-hint">Loading document…</p>}
              {!loading && error && (
                <div className="doc-preview-file-fallback">
                  <p className="error-text">{error}</p>
                </div>
              )}
              {!loading && !error && kind === 'pdf' && fileUrl && (
                <PdfHighlightViewer url={fileUrl} highlights={highlights} />
              )}
              {!loading && !error && kind === 'image' && fileUrl && (
                <div className="doc-preview-image-wrap">
                  <img src={fileUrl} alt={title} />
                </div>
              )}
              {!loading && !error && kind === 'excel' && fileUrl && (
                <Suspense fallback={<p className="empty-hint">Loading spreadsheet viewer…</p>}>
                  <ExcelPreview url={fileUrl} />
                </Suspense>
              )}
              {!loading && !error && kind === 'ppt' && fileUrl && (
                <Suspense fallback={<p className="empty-hint">Loading presentation viewer…</p>}>
                  <PptPreview url={fileUrl} />
                </Suspense>
              )}
              {!loading && !error && kind === 'docx' && fileUrl && (
                <Suspense fallback={<p className="empty-hint">Loading Word viewer…</p>}>
                  <DocxPreview url={fileUrl} />
                </Suspense>
              )}
              {!loading && !error && fileHtml !== null && (
                <div
                  className="doc-preview-html"
                  dangerouslySetInnerHTML={{ __html: fileHtml }}
                />
              )}
              {!loading && !error && kind === 'other' && fileUrl && (
                <div className="doc-preview-file-fallback">
                  <p className="empty-hint">Inline preview is not available for this file type.</p>
                  <a className="btn" href={fileUrl} download={title}>
                    Download file
                  </a>
                </div>
              )}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
