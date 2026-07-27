import React, { useCallback, useEffect, useState } from 'react';
import {
  DocxEditorViewer,
  useDocxEditor,
} from '@extend-ai/react-docx';
import { isZipLikeBlob } from '../../utils/fileKind';

/**
 * Client-side Word (.docx) preview via @extend-ai/react-docx.
 * Legacy binary .doc is not supported.
 */
export default function DocxPreview({ url }: { url: string }) {
  const editor = useDocxEditor({ initialFileName: 'document.docx' });
  const { importDocxFile, totalPages } = editor;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    setError('');

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to load file (${res.status})`);
      const blob = await res.blob();

      const zipLike = await isZipLikeBlob(blob);
      if (!zipLike) {
        setError(
          'This file is not a modern .docx (ZIP) package. Legacy .doc is not supported for inline preview.',
        );
        setLoading(false);
        return;
      }

      const file = new File([blob], 'document.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      await importDocxFile(file);
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse Word document');
      setLoading(false);
    }
  }, [url, importDocxFile]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="office-preview docx-preview">
      <div className="docx-preview-toolbar">
        <span className="docx-preview-toolbar-label">
          {loading ? 'Loading…' : error ? 'Preview unavailable' : `Pages: ${totalPages || '—'}`}
        </span>
      </div>

      {loading && <p className="empty-hint office-preview-status">Loading document…</p>}

      {error && !loading && (
        <div className="doc-preview-file-fallback">
          <p className="error-text">{error}</p>
          <p className="empty-hint">Only modern .docx files can be previewed inline.</p>
          <a className="btn" href={url} download>
            Download file
          </a>
        </div>
      )}

      {!error && (
        <div className="docx-preview-body" style={{ visibility: loading ? 'hidden' : 'visible' }}>
          <DocxEditorViewer
            editor={editor}
            mode="read-only"
            pageGapBackgroundColor="#e5e7eb"
            loadingState={
              <div className="office-preview-status">
                <p className="empty-hint">Rendering pages…</p>
              </div>
            }
          />
        </div>
      )}
    </div>
  );
}
