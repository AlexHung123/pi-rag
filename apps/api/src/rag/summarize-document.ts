/**
 * Full-document summarize path: ordered listChunks → direct full text
 * or map-reduce when over character budget.
 */

import { Logger } from '@nestjs/common';
import type { RagflowChunk } from '../ragflow/ragflow.types';
import {
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

const logger = new Logger('SummarizeDocument');

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

export type ChatCompleteFn = (args: {
  system: string;
  user: string;
  maxTokens: number;
}) => Promise<string>;

export type SummarizeDocumentResult = {
  text: string;
  sources: CitationSource[];
  details: {
    path: 'full_text' | 'map_reduce';
    appDocumentId: string;
    documentName: string;
    chunkCount: number;
    totalChars: number;
    truncated: boolean;
    mapSegments?: number;
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
 * Partition ordered hits into character-budget segments (keeps order).
 * A single oversized chunk becomes its own segment (not split mid-chunk).
 */
export function partitionHitsByCharBudget(
  hits: MappedHit[],
  budget: number,
): MappedHit[][] {
  if (!hits.length) return [];
  const cap = Math.max(1, budget);
  const segments: MappedHit[][] = [];
  let current: MappedHit[] = [];
  let used = 0;

  for (const h of hits) {
    const len = (h.content || '').length;
    if (current.length && used + len > cap) {
      segments.push(current);
      current = [];
      used = 0;
    }
    current.push(h);
    used += len;
  }
  if (current.length) segments.push(current);
  return segments;
}

function formatSegmentBody(hits: MappedHit[]): string {
  return hits
    .map((h, i) => {
      const body = (h.content || '').trim();
      return `--- chunk ${i + 1} ---\n${body}`;
    })
    .join('\n\n');
}

function documentLevelSource(doc: DocCandidate, summaryPreview: string): CitationSource {
  return {
    id: `doc:${doc.appDocumentId}`,
    content: summaryPreview.slice(0, 2000),
    documentName: doc.documentName,
    documentId: doc.ragflowDocumentId,
    appDocumentId: doc.appDocumentId,
    knowledgeBaseId: doc.knowledgeBaseId,
    knowledgeBaseName: doc.knowledgeBaseName,
    index: 1,
    evidenceLabel: 'Document summary',
  };
}

export async function runSummarizeDocument(opts: {
  doc: DocCandidate;
  focus?: string;
  listChunks: ListAllChunksFn;
  chatComplete?: ChatCompleteFn;
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
        truncated: false,
        focus: focus || null,
      },
    };
  }

  if (totalChars <= cfg.summarizeDirectChars) {
    const sources = mappedHitsToCitationSources(hits);
    const header = [
      `Full document text for summarization (ordered chunks).`,
      `Document: ${opts.doc.documentName}`,
      `KB: ${opts.doc.knowledgeBaseName}`,
      `Chunks: ${hits.length}, chars: ${totalChars}`,
      `Path: full_text`,
      focus ? `User focus: ${focus}` : '',
      `Write a clear summary from this full text. Cite [n] when referencing specific passages.`,
      '',
    ]
      .filter(Boolean)
      .join('\n');

    // Prefer full-text framing over generic retrieval "insufficient" messaging.
    const body = formatEvidenceForModel(hits, {
      maxChunkChars: cfg.summarizeMaxChunkChars,
      query: `summarize ${opts.doc.documentName}`,
    });

    return {
      text: `${header}\n${body}`,
      sources,
      details: {
        path: 'full_text',
        appDocumentId: opts.doc.appDocumentId,
        documentName: opts.doc.documentName,
        chunkCount: hits.length,
        totalChars,
        truncated: false,
        focus: focus || null,
      },
    };
  }

  // Map-reduce path
  const chat = opts.chatComplete || defaultChatComplete;
  const segments = partitionHitsByCharBudget(hits, cfg.summarizeMapChars);
  const truncated = segments.length > cfg.summarizeMaxMapCalls;
  const usedSegments = segments.slice(0, cfg.summarizeMaxMapCalls);

  logger.debug(
    `map-reduce doc="${opts.doc.documentName}" chunks=${hits.length} chars=${totalChars} segments=${segments.length} used=${usedSegments.length}`,
  );

  const sectionSummaries: string[] = [];
  for (let i = 0; i < usedSegments.length; i++) {
    const seg = usedSegments[i]!;
    const body = formatSegmentBody(seg);
    const system = `You are summarizing one section of a longer document for a later merge step.
Rules:
- Output ONLY the section summary, no preamble.
- Preserve key names, numbers, decisions, and action items.
- Use the same language as the source text when clear; prefer Traditional Chinese for mixed HK/TW content.
- Be dense but complete for this section only.`;
    const user = [
      `Document: ${opts.doc.documentName}`,
      `Section ${i + 1} of ${usedSegments.length}${truncated ? ` (document has more sections not included)` : ''}`,
      focus ? `User focus (emphasize if present in this section): ${focus}` : '',
      '',
      body,
    ]
      .filter(Boolean)
      .join('\n');

    const summary = await chat({
      system,
      user,
      maxTokens: cfg.summarizeMapMaxTokens,
    });
    sectionSummaries.push(
      summary.trim() || `(Section ${i + 1}: empty map output)`,
    );
  }

  const reduceSystem = `You merge section summaries into one coherent document summary.
Rules:
- Output ONLY the final summary.
- Prefer Traditional Chinese unless the source is clearly English-only.
- Structure with short sections or bullets when helpful.
- Cover the whole document; do not invent facts beyond the section summaries.
- Mention important people, orgs, and decisions by name.`;
  const reduceUser = [
    `Document: ${opts.doc.documentName}`,
    focus ? `User focus: ${focus}` : '',
    truncated
      ? `NOTE: Only the first ${usedSegments.length} of ${segments.length} sections were mapped; note partial coverage.`
      : '',
    '',
    'Section summaries:',
    ...sectionSummaries.map((s, i) => `### Section ${i + 1}\n${s}`),
    '',
    'Write the final merged summary:',
  ]
    .filter(Boolean)
    .join('\n');

  const merged = (
    await chat({
      system: reduceSystem,
      user: reduceUser,
      maxTokens: cfg.summarizeReduceMaxTokens,
    })
  ).trim();

  const finalSummary =
    merged ||
    sectionSummaries.join('\n\n') ||
    'Map-reduce produced an empty summary.';

  const text = [
    `Document summary (server map-reduce; base your reply on this).`,
    `Document: ${opts.doc.documentName}`,
    `KB: ${opts.doc.knowledgeBaseName}`,
    `Chunks: ${hits.length}, chars: ${totalChars}, map segments: ${usedSegments.length}${truncated ? ' (truncated)' : ''}`,
    `Path: map_reduce`,
    focus ? `User focus: ${focus}` : '',
    truncated
      ? `WARNING: Document exceeded max map segments; summary covers only the first ${usedSegments.length} segments.`
      : '',
    '',
    finalSummary,
    '',
    'You may present this summary to the user (polish language if needed). Cite the document by name. Do not invent extra facts.',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    text,
    sources: [documentLevelSource(opts.doc, finalSummary)],
    details: {
      path: 'map_reduce',
      appDocumentId: opts.doc.appDocumentId,
      documentName: opts.doc.documentName,
      chunkCount: hits.length,
      totalChars,
      truncated,
      mapSegments: usedSegments.length,
      focus: focus || null,
    },
  };
}

async function defaultChatComplete(args: {
  system: string;
  user: string;
  maxTokens: number;
}): Promise<string> {
  const baseUrl = (
    process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  ).replace(/\/$/, '');
  const model = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: args.maxTokens,
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `summarize LLM HTTP ${res.status}: ${errText.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return (json.choices?.[0]?.message?.content || '').trim();
  } finally {
    clearTimeout(timer);
  }
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
