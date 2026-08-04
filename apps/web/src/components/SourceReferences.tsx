import React, { useMemo, useState } from 'react';
import type { CitationSource } from '../services/api';

function formatScore(score?: number): string {
  if (typeof score !== 'number' || Number.isNaN(score)) return '—';
  return score.toFixed(3);
}

function evidenceClass(label: string): string {
  const lower = label.toLowerCase();
  if (lower.includes('strong')) return 'evidence-strong';
  if (lower.includes('moderate')) return 'evidence-moderate';
  if (lower.includes('weak')) return 'evidence-weak';
  return 'evidence-default';
}

function evidenceBucket(label?: string): 'strong' | 'moderate' | 'other' {
  const lower = (label || '').toLowerCase();
  if (lower.includes('strong')) return 'strong';
  if (lower.includes('moderate')) return 'moderate';
  return 'other';
}

const DEFAULT_EXPAND_MAX = 5;

export default function SourceReferences({
  sources,
  onLocate,
}: {
  sources: CitationSource[];
  onLocate?: (source: CitationSource) => void;
}) {
  const [open, setOpen] = useState(() => sources.length <= DEFAULT_EXPAND_MAX);

  const counts = useMemo(() => {
    let strong = 0;
    let moderate = 0;
    for (const s of sources) {
      const b = evidenceBucket(s.evidenceLabel);
      if (b === 'strong') strong += 1;
      else if (b === 'moderate') moderate += 1;
    }
    return { strong, moderate };
  }, [sources]);

  if (!sources.length) return null;

  return (
    <div className="sources-panel">
      <button
        type="button"
        className="sources-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="sources-title">
          Sources <span className="sources-count">{sources.length}</span>
          {(counts.strong > 0 || counts.moderate > 0) && (
            <span className="sources-evidence-counts">
              {counts.strong > 0 && (
                <span className="sources-ev-pill evidence-strong">
                  {counts.strong} strong
                </span>
              )}
              {counts.moderate > 0 && (
                <span className="sources-ev-pill evidence-moderate">
                  {counts.moderate} moderate
                </span>
              )}
            </span>
          )}
        </span>
        <span className="sources-toggle">{open ? 'Collapse' : 'Expand'}</span>
      </button>

      {open && (
        <div className="sources-list">
          {sources.map((s) => (
            <article key={`${s.id}-${s.index}`} className="source-card">
              <header className="source-card-header">
                <div className="source-card-meta">
                  <span
                    className="source-doc-name"
                    title={s.documentName || 'Document'}
                  >
                    {s.documentName || 'Unknown document'}
                  </span>
                  <span className="source-body-tag">Body #{s.index}</span>
                  <span
                    className={`source-evidence ${evidenceClass(s.evidenceLabel || '')}`}
                  >
                    {s.evidenceLabel || 'Evidence'}
                  </span>
                  <span className="source-score">
                    Score {formatScore(s.score)}
                  </span>
                </div>
                {onLocate &&
                  (s.appDocumentId ||
                    s.documentId ||
                    s.knowledgeBaseId ||
                    s.documentName) && (
                    <button
                      type="button"
                      className="source-locate-btn"
                      onClick={() => onLocate(s)}
                      title="Open original file"
                    >
                      Locate
                    </button>
                  )}
              </header>
              <p className="source-content">{s.content}</p>
              {s.knowledgeBaseName && (
                <footer className="source-kb-name">{s.knowledgeBaseName}</footer>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
