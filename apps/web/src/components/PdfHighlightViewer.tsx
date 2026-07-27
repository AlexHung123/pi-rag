import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import type { ChunkPosition } from '../services/api';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Vite-friendly pdf.js worker
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export type PdfHighlightBox = {
  pageNumber: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
};

/** Normalize RAGFlow positions: [page, x1, x2, y1, y2] */
export function positionsToBoxes(positions?: ChunkPosition[] | null): PdfHighlightBox[] {
  if (!Array.isArray(positions)) return [];
  const boxes: PdfHighlightBox[] = [];
  for (const raw of positions) {
    if (!Array.isArray(raw) || raw.length < 5) continue;
    const nums = raw.map((v) => Number(v));
    if (nums.some((n) => !Number.isFinite(n))) continue;
    const [pageNumber, x1, x2, y1, y2] = nums;
    if (pageNumber < 1) continue;
    boxes.push({
      pageNumber: Math.round(pageNumber),
      x1: Math.min(x1, x2),
      x2: Math.max(x1, x2),
      y1: Math.min(y1, y2),
      y2: Math.max(y1, y2),
    });
  }
  return boxes;
}

type Props = {
  url: string;
  /** Highlight boxes for the selected chunk (RAGFlow positions). */
  highlights?: PdfHighlightBox[];
  className?: string;
};

export default function PdfHighlightViewer({ url, highlights = [], className }: Props) {
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState('');
  const [pageWidth, setPageWidth] = useState(640);
  /** pdf.js page size at scale=1, used to map RAGFlow coords → % */
  const [nativeSize, setNativeSize] = useState<{ width: number; height: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Fit page width to container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 80) setPageWidth(Math.floor(w - 8));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onDocumentLoad = useCallback(async (pdf: { numPages: number; getPage: (n: number) => Promise<{ getViewport: (o: { scale: number }) => { width: number; height: number } }> }) => {
    setNumPages(pdf.numPages);
    setError('');
    try {
      const page = await pdf.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      setNativeSize({ width: vp.width, height: vp.height });
    } catch {
      setNativeSize(null);
    }
  }, []);

  const highlightByPage = useMemo(() => {
    const map = new Map<number, PdfHighlightBox[]>();
    for (const box of highlights) {
      const list = map.get(box.pageNumber) || [];
      list.push(box);
      map.set(box.pageNumber, list);
    }
    return map;
  }, [highlights]);

  // Scroll first highlight page into view when selection changes
  useEffect(() => {
    if (!highlights.length) return;
    const page = highlights[0].pageNumber;
    const timer = window.setTimeout(() => {
      const el = pageRefs.current.get(page);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [highlights]);

  const boxStyle = (box: PdfHighlightBox): React.CSSProperties | null => {
    if (!nativeSize || nativeSize.width <= 0 || nativeSize.height <= 0) return null;
    const { width: pw, height: ph } = nativeSize;
    // RAGFlow stores coords in page space matching pdf.js viewport scale=1
    const left = (box.x1 / pw) * 100;
    const top = (box.y1 / ph) * 100;
    const width = ((box.x2 - box.x1) / pw) * 100;
    const height = ((box.y2 - box.y1) / ph) * 100;
    if (width <= 0 || height <= 0) return null;
    return {
      left: `${Math.max(0, left)}%`,
      top: `${Math.max(0, top)}%`,
      width: `${Math.min(100, Math.max(0.2, width))}%`,
      height: `${Math.min(100, Math.max(0.2, height))}%`,
    };
  };

  return (
    <div ref={containerRef} className={`pdf-highlight-viewer ${className || ''}`.trim()}>
      {error && <p className="error-text">{error}</p>}
      <Document
        file={url}
        onLoadSuccess={onDocumentLoad}
        onLoadError={(e) => setError(e.message || 'Failed to load PDF')}
        loading={<p className="empty-hint">Loading PDF…</p>}
      >
        {Array.from({ length: numPages }, (_, i) => {
          const pageNumber = i + 1;
          const pageBoxes = highlightByPage.get(pageNumber) || [];
          return (
            <div
              key={pageNumber}
              className="pdf-highlight-page"
              ref={(el) => {
                if (el) pageRefs.current.set(pageNumber, el);
                else pageRefs.current.delete(pageNumber);
              }}
            >
              <Page
                pageNumber={pageNumber}
                width={pageWidth}
                renderTextLayer
                renderAnnotationLayer={false}
                loading={<div className="pdf-highlight-page-loading">Page {pageNumber}…</div>}
              />
              {pageBoxes.map((box, idx) => {
                const style = boxStyle(box);
                if (!style) return null;
                return (
                  <div
                    key={`${pageNumber}-${idx}`}
                    className="pdf-highlight-box"
                    style={style}
                    title={`Page ${pageNumber}`}
                  />
                );
              })}
            </div>
          );
        })}
      </Document>
      {highlights.length === 0 && numPages > 0 && (
        <p className="pdf-highlight-hint empty-hint">
          Click a chunk on the right to highlight its source region (when positions are available).
        </p>
      )}
    </div>
  );
}
