import React, { useEffect, useRef, useState } from 'react';
import jsPreviewExcel, { type JsExcelPreview } from '@js-preview/excel';
import '@js-preview/excel/lib/index.css';

/**
 * Client-side Excel preview (RAGFlow-style) via @js-preview/excel.
 * Accepts a blob: or same-origin URL of the original .xlsx/.xls file.
 */
export default function ExcelPreview({ url }: { url: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let previewer: JsExcelPreview | null = null;

    (async () => {
      setLoading(true);
      setError('');
      if (!hostRef.current || !url) {
        setLoading(false);
        return;
      }

      // Clear previous DOM so re-init is clean
      hostRef.current.innerHTML = '';

      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to load file (${res.status})`);
        const buffer = await res.arrayBuffer();
        if (cancelled || !hostRef.current) return;

        previewer = jsPreviewExcel.init(hostRef.current, {
          minColLength: 0,
          showContextmenu: false,
        });
        await previewer.preview(buffer);
        if (!cancelled) setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to parse Excel file');
          setLoading(false);
          try {
            previewer?.destroy();
          } catch {
            /* ignore */
          }
          previewer = null;
        }
      }
    })();

    return () => {
      cancelled = true;
      try {
        previewer?.destroy();
      } catch {
        /* ignore */
      }
      if (hostRef.current) hostRef.current.innerHTML = '';
    };
  }, [url]);

  return (
    <div className="office-preview excel-preview">
      {loading && <p className="empty-hint office-preview-status">Loading spreadsheet…</p>}
      {error && (
        <div className="doc-preview-file-fallback">
          <p className="error-text">{error}</p>
          <p className="empty-hint">Excel preview failed. You can still download the original file.</p>
          <a className="btn" href={url} download>
            Download file
          </a>
        </div>
      )}
      <div
        ref={hostRef}
        className="office-preview-host excel-preview-host"
        style={{ display: error ? 'none' : undefined }}
        aria-hidden={!!error}
      />
    </div>
  );
}
