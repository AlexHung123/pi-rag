/**
 * Format retrieval hits as compact evidence for the LLM + citation UI.
 */

import type { RetrieveHit } from '../ragflow/ragflow.types';

/** Citation shape shared with chat UI (kept here to avoid circular imports). */
export type CitationSource = {
  id: string;
  content: string;
  documentName?: string;
  documentId?: string;
  appDocumentId?: string;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  score?: number;
  index: number;
  evidenceLabel: string;
  positions?: number[][];
};

export function evidenceLabelFromScore(score?: number): string {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'Evidence';
  if (score >= 0.75) return 'Strong evidence';
  if (score >= 0.5) return 'Moderate evidence';
  return 'Weak evidence';
}

export type MappedHit = RetrieveHit & {
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  appDocumentId?: string;
  positions?: number[][];
  /** Which search query produced this hit (multi-query). */
  sourceQuery?: string;
};

export function filterHitsByThreshold(
  hits: MappedHit[],
  threshold: number,
): MappedHit[] {
  return hits.filter((h) => {
    if (typeof h.score !== 'number' || Number.isNaN(h.score)) {
      // Keep unscored hits (some engines omit similarity).
      return true;
    }
    return h.score >= threshold;
  });
}

/** Deduplicate by chunk id, keeping highest score. */
export function dedupeHitsById(hits: MappedHit[]): MappedHit[] {
  const map = new Map<string, MappedHit>();
  for (const h of hits) {
    const key = h.id || `${h.documentId}:${h.content.slice(0, 40)}`;
    const prev = map.get(key);
    if (!prev || (h.score ?? 0) > (prev.score ?? 0)) {
      map.set(key, h);
    }
  }
  return Array.from(map.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export function truncateChunk(text: string, maxChars: number): string {
  const t = (text || '').trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}…`;
}

/**
 * Human-readable evidence block for the model (not raw JSON dump).
 * Citation indices match CitationSource.index (1-based).
 */
export function formatEvidenceForModel(
  hits: MappedHit[],
  opts: {
    maxChunkChars: number;
    query?: string;
    insufficient?: boolean;
    message?: string;
  },
): string {
  if (!hits.length) {
    return [
      'No relevant evidence found in the selected knowledge bases.',
      opts.message || 'Tell the user you cannot answer from the selected knowledge bases; do not invent facts.',
    ].join('\n');
  }

  const header = [
    'Use ONLY the evidence below. Cite as [1], [2], … matching the source numbers.',
    'If evidence is insufficient, say you do not know based on the selected knowledge bases.',
    opts.query ? `Search query: ${opts.query}` : '',
    opts.insufficient
      ? 'WARNING: Top scores are weak; treat answers as low-confidence or refuse.'
      : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');

  const blocks = hits.map((h, i) => {
    const n = i + 1;
    const doc = h.documentName || h.documentId || 'unknown document';
    const kb = h.knowledgeBaseName ? ` | KB: ${h.knowledgeBaseName}` : '';
    const score =
      typeof h.score === 'number' ? ` | score=${h.score.toFixed(3)}` : '';
    const body = truncateChunk(h.content || '', opts.maxChunkChars);
    return `[${n}] ${doc}${kb}${score}\n${body}`;
  });

  return `${header}\n${blocks.join('\n\n')}`;
}

export function mappedHitsToCitationSources(hits: MappedHit[]): CitationSource[] {
  return hits.map((h, i) => ({
    id: h.id || `hit-${i + 1}`,
    content: h.content || '',
    documentName: h.documentName,
    documentId: h.documentId,
    appDocumentId: h.appDocumentId,
    knowledgeBaseId: h.knowledgeBaseId,
    knowledgeBaseName: h.knowledgeBaseName,
    score: h.score,
    index: i + 1,
    evidenceLabel: evidenceLabelFromScore(h.score),
    positions: h.positions,
  }));
}

/**
 * Merge citation sources from multiple tools in one turn.
 * Dedupes by chunk id (keep highest score), re-indexes [n] 1-based.
 */
export function mergeCitationSources(
  ...batches: CitationSource[][]
): CitationSource[] {
  const map = new Map<string, CitationSource>();
  for (const batch of batches) {
    for (const s of batch) {
      if (!s) continue;
      const key = s.id || `${s.documentId || ''}:${(s.content || '').slice(0, 40)}`;
      const prev = map.get(key);
      if (!prev || (s.score ?? 0) > (prev.score ?? 0)) {
        map.set(key, s);
      }
    }
  }
  return Array.from(map.values())
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map((s, i) => ({
      ...s,
      index: i + 1,
      evidenceLabel: s.evidenceLabel || evidenceLabelFromScore(s.score),
    }));
}

/**
 * Apply a total character budget across chunks (for list_document_chunks).
 * Keeps order; truncates the last included chunk if needed.
 */
export function applyCharBudget(
  hits: MappedHit[],
  budget: number,
): MappedHit[] {
  if (budget <= 0 || !hits.length) return [];
  const out: MappedHit[] = [];
  let used = 0;
  for (const h of hits) {
    const len = (h.content || '').length;
    if (used >= budget) break;
    if (used + len <= budget) {
      out.push(h);
      used += len;
      continue;
    }
    const remain = budget - used;
    if (remain < 40) break;
    out.push({
      ...h,
      content: truncateChunk(h.content || '', remain),
    });
    break;
  }
  return out;
}
