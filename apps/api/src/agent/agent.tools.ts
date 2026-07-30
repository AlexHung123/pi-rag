import { Type } from 'typebox';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RetrieveHit } from '../ragflow/ragflow.types';
import { getRagRetrievalConfig } from '../rag/rag-config';
import {
  applyCharBudget,
  dedupeHitsById,
  evidenceLabelFromScore,
  filterHitsByThreshold,
  formatEvidenceForModel,
  mappedHitsToCitationSources,
  type CitationSource,
  type MappedHit,
} from '../rag/evidence';
import { expandAdjacentHits } from '../rag/expand-hits';
import {
  resolveDocumentScope,
  resolveRetrievalScope,
} from '../rag/resolve-scope';
import {
  formatDocCandidates,
  resolveSummaryDocument,
  runSummarizeDocument,
} from '../rag/summarize-document';

export type { CitationSource };
export { evidenceLabelFromScore };

/** pi-agent-core AgentTool shape (TypeBox parameters). */
export type AppAgentTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (partial: unknown) => void,
  ) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details: unknown;
  }>;
};

export function hitsToCitationSources(
  hits: Array<
    RetrieveHit & {
      knowledgeBaseId?: string;
      knowledgeBaseName?: string;
      appDocumentId?: string;
      positions?: number[][];
    }
  >,
): CitationSource[] {
  return mappedHitsToCitationSources(hits);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter(Boolean);
}

function clampPageSize(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function scopeIdsFromParams(params: Record<string, unknown>): string[] {
  const multiIds = asStringArray(params.knowledgeBaseIds);
  const singleId = params.knowledgeBaseId
    ? String(params.knowledgeBaseId)
    : '';
  return multiIds.length ? multiIds : singleId ? [singleId] : [];
}

/**
 * Optional light multi-query expansion without an extra LLM call:
 * if the agent already passes queries[], use them; otherwise use question alone
 * (or split on "?" / "？" for multi-part questions).
 */
function resolveQueries(
  params: Record<string, unknown>,
  maxQueries: number,
  multiEnabled: boolean,
): string[] {
  const fromArray = asStringArray(params.queries)
    .map((q) => q.trim())
    .filter(Boolean);
  if (fromArray.length) {
    return Array.from(new Set(fromArray)).slice(0, maxQueries);
  }
  const question = String(params.question || '').trim();
  if (!question) return [];
  if (!multiEnabled) return [question];

  // Split multi-part questions into short sub-queries when clearly multi-sentence.
  const parts = question
    .split(/(?<=[?？])\s+|(?<=[。！])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 4);
  if (parts.length > 1) {
    return Array.from(new Set([question, ...parts])).slice(0, maxQueries);
  }
  return [question];
}

export function createUserTools(deps: {
  userId: string;
  knowledge: KnowledgeService;
  ragflow: RagflowService;
  prisma: PrismaService;
}): AppAgentTool[] {
  const { userId, knowledge, ragflow, prisma } = deps;
  const ragCfg = getRagRetrievalConfig();

  const retrieve: AppAgentTool = {
    name: 'retrieve_chunks',
    label: 'Retrieve chunks',
    description:
      'Semantic/hybrid retrieval from user-selected knowledge bases. Use for concepts, mechanisms, summaries, comparisons, and open-ended factual questions. Pass knowledgeBaseIds from the selected-KB prompt (required). Prefer a clear self-contained question (or queries[] for multi-aspect). Returns ranked evidence with [n] citation indices. For error codes, clause numbers, proper nouns, or exact phrases prefer keyword_search.',
    parameters: Type.Object({
      question: Type.String({
        description:
          'Primary search question (self-contained; resolve pronouns from chat context)',
      }),
      queries: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Optional 1–3 short semantic sub-queries for multi-aspect retrieval; merged and deduped',
        }),
      ),
      knowledgeBaseId: Type.Optional(
        Type.String({
          description: 'Optional single app knowledge base UUID (user-selected)',
        }),
      ),
      knowledgeBaseIds: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'User-selected app knowledge base UUIDs to search (from the UI selection)',
        }),
      ),
      topK: Type.Optional(
        Type.Number({
          description: `Max evidence chunks returned (default ${ragCfg.pageSize}, max 20)`,
        }),
      ),
    }),
    execute: async (_id, params) => {
      const scope = await resolveRetrievalScope(
        userId,
        scopeIdsFromParams(params),
        knowledge,
        prisma,
      );
      if (!scope.ok) {
        return {
          content: [{ type: 'text', text: scope.message }],
          details: { hits: [], sources: [], message: scope.message },
        };
      }

      const pageSize = clampPageSize(params.topK, ragCfg.pageSize, 20);
      const topK = Math.max(pageSize, ragCfg.topK);
      const queries = resolveQueries(
        params,
        ragCfg.multiQueryMax,
        ragCfg.multiQueryEnabled,
      );
      if (!queries.length) {
        const message = 'retrieve_chunks requires a non-empty question.';
        return {
          content: [{ type: 'text', text: message }],
          details: { hits: [], sources: [], message },
        };
      }

      const allHits: MappedHit[] = [];
      for (const q of queries) {
        const hits = await ragflow.retrieve({
          datasetIds: scope.datasetIds,
          question: q,
          pageSize,
          topK,
          similarityThreshold: ragCfg.similarityThreshold,
          vectorSimilarityWeight: ragCfg.vectorSimilarityWeight,
          rerankId: ragCfg.rerankId,
        });
        for (const h of hits) {
          allHits.push({ ...scope.mapHit(h), sourceQuery: q });
        }
      }

      let merged = dedupeHitsById(allHits);
      merged = filterHitsByThreshold(merged, ragCfg.similarityThreshold);
      merged = merged.slice(0, pageSize);
      merged = await expandAdjacentHits(merged, {
        listChunks: (datasetId, documentId, o) =>
          ragflow.listChunks(datasetId, documentId, o),
      });

      const maxScore = merged.reduce(
        (m, h) => Math.max(m, typeof h.score === 'number' ? h.score : 0),
        0,
      );
      const insufficient =
        merged.length === 0 ||
        (maxScore > 0 && maxScore < ragCfg.similarityThreshold + 0.1);

      const sources = mappedHitsToCitationSources(merged);
      const text = formatEvidenceForModel(merged, {
        maxChunkChars: ragCfg.maxChunkChars,
        query: queries.join(' | '),
        insufficient,
        message:
          merged.length === 0
            ? 'No chunks passed the similarity threshold. Refuse to invent facts.'
            : undefined,
      });

      return {
        content: [{ type: 'text', text }],
        details: {
          hits: merged,
          sources,
          queries,
          pageSize,
          topK,
          similarityThreshold: ragCfg.similarityThreshold,
          insufficient,
          path: 'semantic',
          adjacentExpand: ragCfg.adjacentExpandEnabled,
        },
      };
    },
  };

  const keywordSearch: AppAgentTool = {
    name: 'keyword_search',
    label: 'Keyword search',
    description:
      'Keyword / exact-term retrieval via RAGFlow (ElasticSearch keyword matching + low vector weight). Use for error codes (e.g. ERR-xxxx), clause numbers, proper nouns, document titles, and exact phrases. Pass knowledgeBaseIds from the UI selection. For conceptual "how does X work" questions use retrieve_chunks instead. May be combined with retrieve_chunks in the same turn.',
    parameters: Type.Object({
      query: Type.String({
        description:
          'Short phrase, error code, clause number, proper noun, or exact title to match',
      }),
      knowledgeBaseIds: Type.Array(Type.String(), {
        description:
          'User-selected app knowledge base UUIDs (from the UI selection)',
      }),
      topK: Type.Optional(
        Type.Number({
          description: `Max evidence chunks returned (default ${ragCfg.pageSize}, max 20)`,
        }),
      ),
    }),
    execute: async (_id, params) => {
      const query = String(params.query || '').trim();
      if (!query) {
        const message = 'keyword_search requires a non-empty query.';
        return {
          content: [{ type: 'text', text: message }],
          details: { hits: [], sources: [], message },
        };
      }

      const scope = await resolveRetrievalScope(
        userId,
        asStringArray(params.knowledgeBaseIds),
        knowledge,
        prisma,
      );
      if (!scope.ok) {
        return {
          content: [{ type: 'text', text: scope.message }],
          details: { hits: [], sources: [], message: scope.message },
        };
      }

      const pageSize = clampPageSize(params.topK, ragCfg.pageSize, 20);
      const topK = Math.max(pageSize, ragCfg.topK);
      const thr = ragCfg.keywordSimilarityThreshold;
      const vWeight = ragCfg.keywordVectorWeight;

      // Primary path: same POST /api/v1/retrieval with keyword-biased params.
      // keyword=true → RAGFlow ElasticSearch term matching; low vector weight
      // prefers term_similarity over pure embedding similarity.
      const hits = await ragflow.retrieve({
        datasetIds: scope.datasetIds,
        question: query,
        pageSize,
        topK,
        similarityThreshold: thr,
        vectorSimilarityWeight: vWeight,
        keyword: ragCfg.keywordEnableEs,
        // Skip rerank on keyword path — keeps literal ranking stable.
        rerankId: undefined,
      });

      let merged = dedupeHitsById(hits.map((h) => scope.mapHit(h)));
      merged = filterHitsByThreshold(merged, thr);
      merged = merged.slice(0, pageSize);
      merged = await expandAdjacentHits(merged, {
        listChunks: (datasetId, documentId, o) =>
          ragflow.listChunks(datasetId, documentId, o),
      });

      const maxScore = merged.reduce(
        (m, h) => Math.max(m, typeof h.score === 'number' ? h.score : 0),
        0,
      );
      const insufficient =
        merged.length === 0 || (maxScore > 0 && maxScore < thr + 0.1);

      const sources = mappedHitsToCitationSources(merged);
      const text = formatEvidenceForModel(merged, {
        maxChunkChars: ragCfg.maxChunkChars,
        query,
        insufficient,
        message:
          merged.length === 0
            ? 'No keyword matches found. Try a shorter exact term or use retrieve_chunks for conceptual search.'
            : undefined,
      });

      return {
        content: [{ type: 'text', text }],
        details: {
          hits: merged,
          sources,
          query,
          pageSize,
          topK,
          similarityThreshold: thr,
          vectorSimilarityWeight: vWeight,
          keyword: ragCfg.keywordEnableEs,
          insufficient,
          path: 'keyword',
          adjacentExpand: ragCfg.adjacentExpandEnabled,
        },
      };
    },
  };

  const listDocumentChunks: AppAgentTool = {
    name: 'list_document_chunks',
    label: 'List document chunks',
    description:
      'Browse chunks of a single document after you already know its portal appDocumentId (from prior retrieval sources or the user). Use to expand context for a named document section. Do NOT invent document ids. Optional keywords filter within the document.',
    parameters: Type.Object({
      appDocumentId: Type.String({
        description:
          'Portal document UUID only (from prior sources[].appDocumentId) — never invent',
      }),
      page: Type.Optional(
        Type.Number({ description: 'Page number (default 1)' }),
      ),
      pageSize: Type.Optional(
        Type.Number({
          description: `Chunks per page (default 8, max ${ragCfg.listDocPageSizeMax})`,
        }),
      ),
      keywords: Type.Optional(
        Type.String({
          description: 'Optional in-document keyword filter',
        }),
      ),
    }),
    execute: async (_id, params) => {
      const appDocumentId = String(params.appDocumentId || '').trim();
      const docScope = await resolveDocumentScope(
        userId,
        appDocumentId,
        knowledge,
        prisma,
      );
      if (!docScope.ok) {
        return {
          content: [{ type: 'text', text: docScope.message }],
          details: { hits: [], sources: [], message: docScope.message },
        };
      }

      const page =
        typeof params.page === 'number' && Number.isFinite(params.page)
          ? Math.max(1, Math.floor(params.page))
          : 1;
      const pageSize = clampPageSize(
        params.pageSize,
        8,
        ragCfg.listDocPageSizeMax,
      );
      const keywords = params.keywords
        ? String(params.keywords).trim()
        : undefined;

      const listed = await ragflow.listChunks(
        docScope.ragflowDatasetId,
        docScope.ragflowDocumentId,
        { page, pageSize, keywords: keywords || undefined },
      );

      let mapped: MappedHit[] = (listed.chunks || []).map((c, i) => ({
        id: String(c.id || `chunk-${i + 1}`),
        content: String(c.content || c.content_with_weight || ''),
        documentId: docScope.ragflowDocumentId,
        documentName: docScope.documentName,
        datasetId: docScope.ragflowDatasetId,
        knowledgeBaseId: docScope.knowledgeBaseId,
        knowledgeBaseName: docScope.knowledgeBaseName,
        appDocumentId: docScope.appDocumentId,
        positions: Array.isArray(c.positions)
          ? (c.positions as MappedHit['positions'])
          : undefined,
        // Browse order — no retrieval score; leave undefined.
        score: undefined,
      }));

      mapped = applyCharBudget(mapped, ragCfg.listDocCharBudget);

      const sources = mappedHitsToCitationSources(mapped);
      const text = formatEvidenceForModel(mapped, {
        maxChunkChars: ragCfg.maxChunkChars,
        query: keywords
          ? `list ${docScope.documentName} keywords=${keywords}`
          : `list ${docScope.documentName} page=${page}`,
        message:
          mapped.length === 0
            ? 'No chunks returned for this document (empty, filtered, or not parsed).'
            : undefined,
      });

      return {
        content: [{ type: 'text', text }],
        details: {
          hits: mapped,
          sources,
          appDocumentId: docScope.appDocumentId,
          documentName: docScope.documentName,
          page,
          pageSize,
          total: listed.total,
          keywords: keywords || null,
          charBudget: ragCfg.listDocCharBudget,
          path: 'list_document',
        },
      };
    },
  };

  const summarizeDocument: AppAgentTool = {
    name: 'summarize_document',
    label: 'Summarize document',
    description:
      'Read a full document in order (all chunks) and produce material for a whole-document summary. Prefer this for "总结/摘要/summarize this document" over retrieve_chunks or keyword_search. Pass knowledgeBaseIds from the UI selection. Identify the document via appDocumentId (best), documentNameHint (filename/title), or omit both when the selected KB has exactly one indexed document. Do NOT chain many keyword searches for a summary.',
    parameters: Type.Object({
      knowledgeBaseIds: Type.Array(Type.String(), {
        description:
          'User-selected app knowledge base UUIDs (from the UI selection)',
      }),
      appDocumentId: Type.Optional(
        Type.String({
          description:
            'Portal document UUID (from prior sources or user). Preferred when known.',
        }),
      ),
      documentNameHint: Type.Optional(
        Type.String({
          description:
            'Filename or title to match within selected knowledge bases (e.g. 2026.07.transcript.md)',
        }),
      ),
      focus: Type.Optional(
        Type.String({
          description:
            'Optional focus for the summary (e.g. only policy points)',
        }),
      ),
    }),
    execute: async (_id, params) => {
      const scope = await resolveRetrievalScope(
        userId,
        asStringArray(params.knowledgeBaseIds),
        knowledge,
        prisma,
      );
      if (!scope.ok) {
        return {
          content: [{ type: 'text', text: scope.message }],
          details: { sources: [], message: scope.message, path: 'summarize' },
        };
      }

      const appDocumentId = params.appDocumentId
        ? String(params.appDocumentId).trim()
        : undefined;
      const documentNameHint = params.documentNameHint
        ? String(params.documentNameHint).trim()
        : undefined;
      const focus = params.focus ? String(params.focus).trim() : undefined;

      // Prefer portal scope when id is explicit (ownership re-check).
      let doc;
      if (appDocumentId) {
        const docScope = await resolveDocumentScope(
          userId,
          appDocumentId,
          knowledge,
          prisma,
        );
        if (!docScope.ok) {
          return {
            content: [{ type: 'text', text: docScope.message }],
            details: {
              sources: [],
              message: docScope.message,
              path: 'summarize',
            },
          };
        }
        // Must still be inside the selected KB set.
        const inScope = scope.accessible.some(
          (kb) =>
            kb.id === docScope.knowledgeBaseId &&
            kb.documents.some((d) => d.id === docScope.appDocumentId),
        );
        if (!inScope) {
          const message =
            'Document is not in the currently selected knowledge bases. Ask the user to select the right KB.';
          return {
            content: [{ type: 'text', text: message }],
            details: { sources: [], message, path: 'summarize' },
          };
        }
        doc = {
          appDocumentId: docScope.appDocumentId,
          documentName: docScope.documentName,
          ragflowDocumentId: docScope.ragflowDocumentId,
          knowledgeBaseId: docScope.knowledgeBaseId,
          knowledgeBaseName: docScope.knowledgeBaseName,
          ragflowDatasetId: docScope.ragflowDatasetId,
        };
      } else {
        const resolved = resolveSummaryDocument(scope, {
          documentNameHint,
        });
        if (!resolved.ok) {
          const list = resolved.candidates
            ? `\nCandidates:\n${formatDocCandidates(resolved.candidates)}`
            : '';
          const message = `${resolved.message}${list}`;
          return {
            content: [{ type: 'text', text: message }],
            details: {
              sources: [],
              message: resolved.message,
              candidates: resolved.candidates || [],
              path: 'summarize',
            },
          };
        }
        doc = resolved.doc;
      }

      try {
        const result = await runSummarizeDocument({
          doc,
          focus,
          listChunks: (datasetId, documentId, o) =>
            ragflow.listChunks(datasetId, documentId, o),
        });
        return {
          content: [{ type: 'text', text: result.text }],
          details: {
            sources: result.sources,
            ...result.details,
          },
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text',
              text: `summarize_document failed: ${message}. You may fall back to retrieve_chunks once, but do not spam keyword_search.`,
            },
          ],
          details: {
            sources: [],
            message,
            path: 'summarize_error',
            appDocumentId: doc.appDocumentId,
            documentName: doc.documentName,
          },
        };
      }
    },
  };

  return [retrieve, keywordSearch, listDocumentChunks, summarizeDocument];
}

export const DOMAIN_SYSTEM_PROMPT = `You are the CSB Knowledge Base Portal assistant.
You answer the current user's questions. Knowledge bases are created, managed, and selected only in the UI; you do not create or list them.

Language:
- Default language is Traditional Chinese (繁體中文). Reply in Traditional Chinese unless the user writes in English.
- If the user writes primarily in English, reply in English.
- Match the user's language for mixed or other languages when clear; otherwise prefer Traditional Chinese.

Retrieval tools (when knowledge bases are selected):
- summarize_document — WHOLE-document summary / 总结整份文件 / 全文摘要 / "summarize this document". Reads all chunks in order (map-reduce if long). Prefer ONE call. Pass knowledgeBaseIds; identify doc via appDocumentId, documentNameHint (filename), or omit both if the selected KB has exactly one document.
- retrieve_chunks — concepts, mechanisms, partial topics, comparisons, open-ended factual questions (semantic/hybrid). NOT for whole-document summaries.
- keyword_search — error codes, clause numbers, proper nouns, exact phrases, titles. Do NOT spam keyword_search to "cover" a full document for summary.
- list_document_chunks — browse a known document by portal appDocumentId from prior sources; never invent document ids.
- You may call retrieve_chunks and keyword_search in the same turn for non-summary Q&A when helpful (concept + exact term).

Rules:
- Knowledge bases are selected by the user in the UI only. Never invent or guess knowledge base ids or document ids.
- Do NOT call retrieval tools for greetings, small talk, or meta questions about you (e.g. hello, hi, 你好, who are you, 你是誰, what can you do, 你可以做什麼, thanks). Answer those directly from this system role without tools or sources.
- Whole-document summary intent (总结/摘要/概述整份/summarize this document/全文) → call summarize_document once. Do NOT chain many retrieve_chunks or keyword_search queries for that intent.
- When the user asks a non-summary factual question that needs document content AND selected knowledge base IDs are present, you MUST call at least one retrieval tool (retrieve_chunks and/or keyword_search) with those knowledgeBaseIds before answering. Do not invent document content.
- Prefer a self-contained question (resolve "it/this/上面" from history). Optional queries[] for multi-aspect topics on retrieve_chunks.
- If no knowledge bases are selected, answer without document retrieval and, if facts from documents are needed, ask the user to select knowledge bases in the UI.
- Only use tool evidence for document content; cite with [1], [2] matching evidence indices.
- If retrieval returns no / weak evidence, say you don't know based on the selected knowledge bases.
- Knowledge bases are user-private; never claim access to other users' data.
- Be concise and practical. Mention document names when citing facts.
`;

/** Build a prompt prefix when the UI has knowledge bases selected. */
export function buildSelectedKbPromptPrefix(
  selected: Array<{ id: string; name: string }>,
  opts?: { rewriteQuery?: string },
): string {
  if (!selected.length) return '';
  const lines = selected.map((k) => `- ${k.name} (id: ${k.id})`).join('\n');
  const ids = JSON.stringify(selected.map((k) => k.id));
  const rewriteHint = opts?.rewriteQuery
    ? `Suggested retrieval question (self-contained): ${opts.rewriteQuery}\n` +
      `You may pass this as retrieve_chunks.question or keyword_search.query (or refine it).\n\n`
    : '';
  return (
    `[Selected knowledge bases for this question]\n${lines}\n\n` +
    `If this is a greeting, small talk, or a question about you / your capabilities (not document facts), answer directly WITHOUT calling retrieval tools. ` +
    `If the user wants a whole-document summary (总结/摘要/summarize this document), call summarize_document once with knowledgeBaseIds=${ids} ` +
    `(pass documentNameHint if they named a file; appDocumentId if known). Do not chain keyword_search for summaries. ` +
    `If the user needs other facts from the selected knowledge bases, retrieve with knowledgeBaseIds=${ids} before answering ` +
    `(use retrieve_chunks for concepts; keyword_search for codes/exact phrases; both if helpful). ` +
    `Base your analysis only on the retrieved evidence. Cite with [1], [2], … and mention document names.\n\n` +
    rewriteHint +
    `[User question]\n`
  );
}
