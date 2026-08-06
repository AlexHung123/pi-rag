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

/**
 * Truncate chunk body for optional display caps.
 * maxChars <= 0 means no truncation (full text).
 */
export function truncateChunk(text: string, maxChars: number): string {
  const t = (text || '').trim();
  if (maxChars <= 0 || t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}…`;
}

/**
 * Head+tail clip for a single oversized text blob (tool results / summarize).
 * maxChars <= 0 means no truncation.
 */
export function clipTextToBudget(text: string, maxChars: number): string {
  const t = text || '';
  if (maxChars <= 0 || t.length <= maxChars) return t;
  if (maxChars < 64) return `${t.slice(0, maxChars)}…`;
  const marker = '\n\n…[truncated to fit context budget]…\n\n';
  const budget = maxChars - marker.length;
  const head = Math.floor(budget * 0.6);
  const tail = Math.max(0, budget - head);
  return `${t.slice(0, head)}${marker}${t.slice(t.length - tail)}`;
}

export type FormatEvidenceOpts = {
  /** <= 0 or omit = full chunk body. */
  maxChunkChars?: number;
  /**
   * Hard cap on total formatted evidence characters (header + blocks).
   * When exceeded, later hits are omitted and a truncation note is appended.
   * <= 0 or omit = no total budget.
   */
  maxTotalChars?: number;
  query?: string;
  insufficient?: boolean;
  message?: string;
};

/** Truncation / budget stats for evidence formatting logs. */
export type FormatEvidenceStats = {
  hitCount: number;
  includedCount: number;
  omittedByTotalBudget: number;
  /** Chunks whose body was shortened by maxChunkChars (or partial room). */
  chunksTruncated: number;
  rawContentChars: number;
  outputChars: number;
  maxChunkChars: number;
  maxTotalChars: number;
  /** True if any per-chunk or total-budget compression applied. */
  compressed: boolean;
};

export type FormatEvidenceResult = {
  text: string;
  stats: FormatEvidenceStats;
};

/**
 * Human-readable evidence block for the model (not raw JSON dump).
 * Citation indices match CitationSource.index (1-based).
 *
 * Applies per-chunk maxChunkChars and optional maxTotalChars so a single
 * retrieve/keyword tool result cannot blow the model context window.
 * maxChunkChars / maxTotalChars <= 0 means no cap on that dimension.
 */
export function formatEvidenceForModel(
  hits: MappedHit[],
  opts: FormatEvidenceOpts = {},
): string {
  return formatEvidenceForModelWithStats(hits, opts).text;
}

/** Same as formatEvidenceForModel but returns truncation stats for logging. */
export function formatEvidenceForModelWithStats(
  hits: MappedHit[],
  opts: FormatEvidenceOpts = {},
): FormatEvidenceResult {
  const maxChunkChars = opts.maxChunkChars ?? 0;
  const maxTotalChars = opts.maxTotalChars ?? 0;

  if (!hits.length) {
    const text = [
      'No relevant evidence found in the selected knowledge bases.',
      opts.message ||
        'Tell the user you cannot answer from the selected knowledge bases; do not invent facts.',
    ].join('\n');
    return {
      text,
      stats: {
        hitCount: 0,
        includedCount: 0,
        omittedByTotalBudget: 0,
        chunksTruncated: 0,
        rawContentChars: 0,
        outputChars: text.length,
        maxChunkChars,
        maxTotalChars,
        compressed: false,
      },
    };
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

  const blocks: string[] = [];
  let used = header.length;
  let omitted = 0;
  let chunksTruncated = 0;
  let rawContentChars = 0;

  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    const n = i + 1;
    const rawBody = (h.content || '').trim();
    rawContentChars += rawBody.length;
    const doc = h.documentName || h.documentId || 'unknown document';
    const kb = h.knowledgeBaseName ? ` | KB: ${h.knowledgeBaseName}` : '';
    const score =
      typeof h.score === 'number' ? ` | score=${h.score.toFixed(3)}` : '';
    let body = truncateChunk(h.content || '', maxChunkChars);
    let bodyTruncated =
      maxChunkChars > 0 && rawBody.length > maxChunkChars;
    let block = `[${n}] ${doc}${kb}${score}\n${body}`;
    const sep = blocks.length ? 2 : 1; // \n\n between blocks, or one \n after header

    if (maxTotalChars > 0 && used + sep + block.length > maxTotalChars) {
      // Try to keep a partial first/current block if nothing fits yet.
      const room = maxTotalChars - used - sep;
      if (blocks.length === 0 && room > 80) {
        const meta = `[${n}] ${doc}${kb}${score}\n`;
        const bodyRoom = Math.max(0, room - meta.length - 1);
        const bodyCap =
          maxChunkChars > 0
            ? Math.min(maxChunkChars, bodyRoom)
            : bodyRoom;
        body = truncateChunk(h.content || '', bodyCap);
        bodyTruncated = rawBody.length > bodyCap;
        block = `${meta}${body}`;
        if (block.length > room) {
          block = clipTextToBudget(block, room);
        }
        blocks.push(block);
        if (bodyTruncated) chunksTruncated += 1;
        used += sep + block.length;
        omitted = hits.length - 1;
      } else {
        omitted = hits.length - i;
      }
      break;
    }

    blocks.push(block);
    if (bodyTruncated) chunksTruncated += 1;
    used += sep + block.length;
  }

  let out = `${header}\n${blocks.join('\n\n')}`;
  if (omitted > 0) {
    const note =
      `\n\n… truncated ${omitted} more chunk(s) to fit context budget` +
      (maxTotalChars > 0 ? ` (max ~${maxTotalChars} chars).` : '.');
    if (maxTotalChars <= 0 || out.length + note.length <= maxTotalChars) {
      out += note;
    } else {
      out = clipTextToBudget(out + note, maxTotalChars);
    }
  }

  const stats: FormatEvidenceStats = {
    hitCount: hits.length,
    includedCount: blocks.length,
    omittedByTotalBudget: omitted,
    chunksTruncated,
    rawContentChars,
    outputChars: out.length,
    maxChunkChars,
    maxTotalChars,
    compressed: chunksTruncated > 0 || omitted > 0,
  };
  return { text: out, stats };
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

