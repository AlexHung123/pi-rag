import React, { useEffect, useRef, useState } from 'react';
import { init } from 'pptx-preview';

/**
 * Client-side PowerPoint preview (RAGFlow-style) via pptx-preview.
 * Best with modern .pptx; legacy .ppt may fail.
 */
export default function PptPreview({ url }: { url: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError('');
      if (!hostRef.current || !url) {
        setLoading(false);
        return;
      }

      hostRef.current.innerHTML = '';

      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to load file (${res.status})`);
        const buffer = await res.arrayBuffer();
        if (cancelled || !hostRef.current) return;

        const el = hostRef.current;
        // Leave padding for scrollbars / chrome
        const width = Math.max(320, el.clientWidth - 24);
        const height = Math.max(240, el.clientHeight - 24);

        const viewer = init(el, {
          width,
          height,
          mode: 'list',
        });
        await viewer.preview(buffer);
        if (!cancelled) setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error
              ? e.message
              : 'Failed to parse PowerPoint file (legacy .ppt may be unsupported)',
          );
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (hostRef.current) hostRef.current.innerHTML = '';
    };
  }, [url]);

  return (
    <div className="office-preview ppt-preview">
      {loading && <p className="empty-hint office-preview-status">Loading presentation…</p>}
      {error && (
        <div className="doc-preview-file-fallback">
          <p className="error-text">{error}</p>
          <p className="empty-hint">
            PowerPoint preview failed. Complex or legacy (.ppt) files may not be supported.
          </p>
          <a className="btn" href={url} download>
            Download file
          </a>
        </div>
      )}
      <div
        ref={hostRef}
        className="office-preview-host ppt-preview-host"
        style={{ display: error ? 'none' : undefined }}
        aria-hidden={!!error}
      />
    </div>
  );
}
