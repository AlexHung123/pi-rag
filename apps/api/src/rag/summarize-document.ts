/**
 * Full-document summarize path: ordered listChunks → merge all chunks →
 * return full text for the agent to summarize.
 */

import type { RagflowChunk } from '../ragflow/ragflow.types';
import {
  clipTextToBudget,
  formatEvidenceForModel,
  mappedHitsToCitationSources,
  type CitationSource,
  type MappedHit,
} from './evidence';
import { getRagRetrievalConfig } from './rag-config';
import type {
  DocumentScopeOk,
  RetrievalScopeOk,
  ScopedDocument,
  ScopedKnowledgeBase,
} from './resolve-scope';

export type DocCandidate = {
  appDocumentId: string;
  documentName: string;
  ragflowDocumentId: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  ragflowDatasetId: string;
};

export type ResolveSummaryDocResult =
  | { ok: true; doc: DocCandidate }
  | { ok: false; message: string; candidates?: DocCandidate[] };

export type ListAllChunksFn = (
  datasetId: string,
  documentId: string,
  opts: { page?: number; pageSize?: number },
) => Promise<{ chunks: RagflowChunk[]; total: number }>;

export type SummarizeDocumentResult = {
  text: string;
  sources: CitationSource[];
  details: {
    path: 'full_text';
    appDocumentId: string;
    documentName: string;
    chunkCount: number;
    totalChars: number;
    focus?: string | null;
  };
};

function normalizeName(s: string): string {
  return (s || '').trim().toLowerCase();
}

/** Strip common extensions for softer filename matching. */
function basenameKey(name: string): string {
  return normalizeName(name).replace(
    /\.(md|txt|pdf|docx?|pptx?|xlsx?|csv|json|html?|mp3|mp4|wav|m4a)$/i,
    '',
  );
}

/**
 * Match documents in retrieval scope by portal id or name hint.
 * - exact id wins
 * - exact name (case-insensitive)
 * - substring / basename contains
 * - single indexed doc in scope when no hint
 */
export function resolveSummaryDocument(
  scope: RetrievalScopeOk,
  opts: { appDocumentId?: string; documentNameHint?: string },
): ResolveSummaryDocResult {
  const all: DocCandidate[] = [];
  for (const kb of scope.accessible) {
    for (const d of kb.documents) {
      all.push(candidateFromScoped(kb, d));
    }
  }

  const id = (opts.appDocumentId || '').trim();
  if (id) {
    const hit = all.find((d) => d.appDocumentId === id);
    if (!hit) {
      return {
        ok: false,
        message:
          'Document not found in selected knowledge bases (check appDocumentId).',
      };
    }
    return { ok: true, doc: hit };
  }

  const hint = (opts.documentNameHint || '').trim();
  if (!hint) {
    if (all.length === 1) {
      return { ok: true, doc: all[0]! };
    }
    if (all.length === 0) {
      return {
        ok: false,
        message:
          'No indexed documents in the selected knowledge bases. Upload/parse a document first.',
      };
    }
    return {
      ok: false,
      message:
        'Multiple documents in selected knowledge bases. Pass appDocumentId or documentNameHint (filename/title).',
      candidates: all.slice(0, 12),
    };
  }

  const matches = matchDocumentsByNameHint(all, hint);
  if (matches.length === 1) {
    return { ok: true, doc: matches[0]! };
  }
  if (matches.length === 0) {
    return {
      ok: false,
      message: `No document matched name hint "${hint}" in selected knowledge bases.`,
      candidates: all.slice(0, 12),
    };
  }
  return {
    ok: false,
    message: `Multiple documents matched "${hint}". Pass a more specific documentNameHint or appDocumentId.`,
    candidates: matches.slice(0, 12),
  };
}

export function matchDocumentsByNameHint(
  docs: DocCandidate[],
  hint: string,
): DocCandidate[] {
  const h = normalizeName(hint);
  const hBase = basenameKey(hint);
  if (!h) return [];

  const exact = docs.filter((d) => normalizeName(d.documentName) === h);
  if (exact.length) return exact;

  const exactBase = docs.filter((d) => basenameKey(d.documentName) === hBase);
  if (exactBase.length) return exactBase;

  const contains = docs.filter((d) => {
    const n = normalizeName(d.documentName);
    const b = basenameKey(d.documentName);
    return n.includes(h) || h.includes(n) || b.includes(hBase) || hBase.includes(b);
  });
  return contains;
}

function candidateFromScoped(
  kb: ScopedKnowledgeBase,
  d: ScopedDocument,
): DocCandidate {
  return {
    appDocumentId: d.id,
    documentName: d.name,
    ragflowDocumentId: d.ragflowDocumentId,
    knowledgeBaseId: kb.id,
    knowledgeBaseName: kb.name,
    ragflowDatasetId: kb.ragflowDatasetId,
  };
}

export function docCandidateFromDocumentScope(scope: DocumentScopeOk): DocCandidate {
  return {
    appDocumentId: scope.appDocumentId,
    documentName: scope.documentName,
    ragflowDocumentId: scope.ragflowDocumentId,
    knowledgeBaseId: scope.knowledgeBaseId,
    knowledgeBaseName: scope.knowledgeBaseName,
    ragflowDatasetId: scope.ragflowDatasetId,
  };
}

/** Paginate listChunks until all chunks loaded (document list order). */
export async function listAllDocumentChunks(
  listChunks: ListAllChunksFn,
  datasetId: string,
  documentId: string,
  pageSize: number,
  maxPages = 200,
): Promise<{ chunks: RagflowChunk[]; total: number }> {
  const all: RagflowChunk[] = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const res = await listChunks(datasetId, documentId, { page, pageSize });
    total = res.total || total;
    const batch = res.chunks || [];
    all.push(...batch);
    if (batch.length === 0) break;
    if (batch.length < pageSize) break;
    if (total > 0 && all.length >= total) break;
  }
  return { chunks: all, total: total || all.length };
}

export function chunksToMappedHits(
  chunks: RagflowChunk[],
  doc: DocCandidate,
): MappedHit[] {
  return chunks.map((c, i) => ({
    id: String(c.id || `chunk-${i + 1}`),
    content: String(c.content || c.content_with_weight || ''),
    documentId: doc.ragflowDocumentId,
    documentName: doc.documentName,
    datasetId: doc.ragflowDatasetId,
    knowledgeBaseId: doc.knowledgeBaseId,
    knowledgeBaseName: doc.knowledgeBaseName,
    appDocumentId: doc.appDocumentId,
    positions: Array.isArray(c.positions)
      ? (c.positions as MappedHit['positions'])
      : undefined,
    score: undefined,
  }));
}

export function totalContentChars(hits: MappedHit[]): number {
  return hits.reduce((n, h) => n + (h.content || '').length, 0);
}

/**
 * Detect explicit length requests such as "5000字", "约 3000 字",
 * "about 2000 characters".
 */
export function extractSummaryLengthHint(text: string): {
  targetChars?: number;
  matched?: string;
} {
  const t = (text || '').trim();
  if (!t) return {};

  const zh = t.match(
    /(?:约|約|大概|大約|至少|最少|要|達|达|共|共約|共约)?\s*(\d{3,6})\s*字/,
  );
  if (zh?.[1]) {
    const n = Number(zh[1]);
    if (Number.isFinite(n) && n > 0) {
      return { targetChars: n, matched: zh[0].trim() };
    }
  }

  const en = t.match(
    /(?:about|approx\.?|approximately|around|at\s+least|~)?\s*(\d{3,6})\s*(?:chinese\s+)?(?:characters?|chars?)\b/i,
  );
  if (en?.[1]) {
    const n = Number(en[1]);
    if (Number.isFinite(n) && n > 0) {
      return { targetChars: n, matched: en[0].trim() };
    }
  }

  return {};
}

/** Build the agent-facing header for a full-document summarize payload. */
export function buildSummarizeDocumentHeader(opts: {
  documentName: string;
  knowledgeBaseName: string;
  chunkCount: number;
  totalChars: number;
  focus?: string;
}): string {
  const focus = (opts.focus || '').trim() || undefined;
  const lengthHint = extractSummaryLengthHint(focus || '');

  const lengthLines: string[] = [];
  if (lengthHint.targetChars) {
    lengthLines.push(
      `Target length: about ${lengthHint.targetChars} Chinese characters` +
        (lengthHint.matched ? ` (from user request: "${lengthHint.matched}")` : '') +
        `. Expand with section detail from the evidence; do not stop at a short outline. Aim near this length (within ~15%).`,
    );
  } else if (focus) {
    lengthLines.push(
      `If the user focus above includes a length/字數 requirement, honor it in the final summary.`,
    );
  }

  return [
    `Full document text for summarization (all chunks merged in order).`,
    `Document: ${opts.documentName}`,
    `KB: ${opts.knowledgeBaseName}`,
    `Chunks: ${opts.chunkCount}, chars: ${opts.totalChars}`,
    `Path: full_text`,
    focus ? `User focus / requirements: ${focus}` : '',
    ...lengthLines,
    `Write a clear summary from this full text. Cite [n] when referencing specific passages.`,
    lengthHint.targetChars
      ? `Do not default to a brief bullet outline when a target length is set — expand thoroughly.`
      : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Load every chunk for the document (ordered), merge into one evidence block,
 * and return text for the agent to summarize. No map-reduce / server LLM.
 */
export async function runSummarizeDocument(opts: {
  doc: DocCandidate;
  focus?: string;
  listChunks: ListAllChunksFn;
}): Promise<SummarizeDocumentResult> {
  const cfg = getRagRetrievalConfig();
  const focus = (opts.focus || '').trim() || undefined;

  const { chunks } = await listAllDocumentChunks(
    opts.listChunks,
    opts.doc.ragflowDatasetId,
    opts.doc.ragflowDocumentId,
    cfg.summarizeListPageSize,
  );

  const hits = chunksToMappedHits(chunks, opts.doc);
  const totalChars = totalContentChars(hits);

  if (!hits.length) {
    return {
      text: `Document "${opts.doc.documentName}" has no chunks (empty or not parsed). Cannot summarize.`,
      sources: [],
      details: {
        path: 'full_text',
        appDocumentId: opts.doc.appDocumentId,
        documentName: opts.doc.documentName,
        chunkCount: 0,
        totalChars: 0,
        focus: focus || null,
      },
    };
  }

  const sources = mappedHitsToCitationSources(hits);
  const header = buildSummarizeDocumentHeader({
    documentName: opts.doc.documentName,
    knowledgeBaseName: opts.doc.knowledgeBaseName,
    chunkCount: hits.length,
    totalChars,
    focus,
  });

  const body = formatEvidenceForModel(hits, {
    maxChunkChars: cfg.summarizeMaxChunkChars,
    // Leave room for the header inside the total summarize budget.
    maxTotalChars:
      cfg.summarizeMaxTotalChars > 0
        ? Math.max(1_000, cfg.summarizeMaxTotalChars - header.length - 1)
        : 0,
    query: `summarize ${opts.doc.documentName}`,
  });

  let text = `${header}\n${body}`;
  // Final safety clip so one summarize call cannot blow the model context.
  if (
    cfg.summarizeMaxTotalChars > 0 &&
    text.length > cfg.summarizeMaxTotalChars
  ) {
    text = clipTextToBudget(text, cfg.summarizeMaxTotalChars);
  }

  return {
    text,
    sources,
    details: {
      path: 'full_text',
      appDocumentId: opts.doc.appDocumentId,
      documentName: opts.doc.documentName,
      chunkCount: hits.length,
      totalChars,
      focus: focus || null,
    },
  };
}

/** Format candidate list for agent when resolution is ambiguous. */
export function formatDocCandidates(candidates: DocCandidate[]): string {
  if (!candidates.length) return '';
  return candidates
    .map(
      (c) =>
        `- ${c.documentName} (appDocumentId: ${c.appDocumentId}, KB: ${c.knowledgeBaseName})`,
    )
    .join('\n');
}
