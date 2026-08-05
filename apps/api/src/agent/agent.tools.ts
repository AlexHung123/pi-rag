import { Logger } from '@nestjs/common';
import { Type } from 'typebox';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { PrismaService } from '../prisma/prisma.service';
import type { MemoryService } from '../memory/memory.service';
import { resolveDisplayNameForUpdate } from '../memory/profile-from-message';
import { maybePolishMemoryContent } from '../memory/memory-polish';
import type { RetrieveHit } from '../ragflow/ragflow.types';
import { getRagRetrievalConfig } from '../rag/rag-config';
import {
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

const toolsLogger = new Logger('AgentTools');

/** Compact retrieval summary for Nest logs (no full chunk dump). */
function logEvidenceForLlm(
  tool: string,
  hits: MappedHit[],
  text: string,
  meta?: { query?: string; path?: string; insufficient?: boolean },
): void {
  const scores = hits
    .map((h) =>
      typeof h.score === 'number' && Number.isFinite(h.score)
        ? h.score.toFixed(3)
        : '-',
    )
    .join(', ');
  toolsLogger.log(
    `[${tool}] evidence → LLM: hits=${hits.length}` +
      (meta?.query != null ? ` query="${meta.query}"` : '') +
      (meta?.path ? ` path=${meta.path}` : '') +
      (meta?.insufficient ? ' insufficient=true' : '') +
      (scores ? ` scores=[${scores}]` : '') +
      ` evidenceChars=${text.length}`,
  );
}

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

/** Nest HttpException often puts the useful text in getResponse().message */
function toolErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'getResponse' in err) {
    try {
      const r = (err as { getResponse: () => unknown }).getResponse();
      if (typeof r === 'string' && r.trim()) return r;
      if (r && typeof r === 'object' && 'message' in r) {
        const m = (r as { message: unknown }).message;
        if (typeof m === 'string' && m.trim()) return m;
        if (Array.isArray(m) && m.length) return m.map(String).join('; ');
      }
    } catch {
      /* fall through */
    }
  }
  return err instanceof Error ? err.message : String(err);
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

export type AgentToolTurnContext = {
  /** Latest user message for this prompt (set each turn before agent.prompt). */
  latestUserMessage: string;
  /**
   * UI-selected knowledge base UUIDs for this turn (server-enforced).
   * When non-empty, retrieval tools prefer these over model-supplied ids.
   */
  knowledgeBaseIds: string[];
  /**
   * Optional UI-selected document UUIDs for this turn.
   * Empty = whole selected KBs. Mapped to RAGFlow document_ids server-side.
   */
  documentIds: string[];
};

export function createUserTools(deps: {
  userId: string;
  knowledge: KnowledgeService;
  ragflow: RagflowService;
  prisma: PrismaService;
  memory: MemoryService;
  /** Mutable; agent.service updates selection + latestUserMessage each turn. */
  turnContext: AgentToolTurnContext;
}): AppAgentTool[] {
  const { userId, knowledge, ragflow, prisma, memory, turnContext } = deps;
  const ragCfg = getRagRetrievalConfig();

  /** Prefer UI KB selection; always apply UI document filter when set. */
  function resolveScopeKbIds(params: Record<string, unknown>): string[] {
    if (turnContext.knowledgeBaseIds.length) {
      return turnContext.knowledgeBaseIds;
    }
    return scopeIdsFromParams(params);
  }

  async function retrievalScopeForTurn(params: Record<string, unknown>) {
    return resolveRetrievalScope(
      userId,
      resolveScopeKbIds(params),
      knowledge,
      prisma,
      { documentIds: turnContext.documentIds },
    );
  }

  const retrieve: AppAgentTool = {
    name: 'retrieve_chunks',
    label: 'Retrieve chunks',
    description:
      'Semantic/hybrid retrieval from user-selected knowledge bases. Use for concepts, mechanisms, summaries, comparisons, and open-ended factual questions. Pass knowledgeBaseIds from the selected-KB prompt (required). Prefer a clear self-contained question (or queries[] for multi-aspect). Returns ranked evidence with [n] citation indices. For error codes, clause numbers, person names, job/position titles, company names, department names, proper nouns, or exact phrases prefer keyword_search.',
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
          description: `Max evidence chunks returned (default ${ragCfg.pageSize}, max 50)`,
        }),
      ),
    }),
    execute: async (_id, params) => {
      const scope = await retrievalScopeForTurn(params);
      if (!scope.ok) {
        return {
          content: [{ type: 'text', text: scope.message }],
          details: { hits: [], sources: [], message: scope.message },
        };
      }

      const pageSize = clampPageSize(params.topK, ragCfg.pageSize, 50);
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
          // RAGFlow POST /api/v1/retrieval document_ids (optional hard filter)
          documentIds: scope.ragflowDocumentIds,
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

      logEvidenceForLlm('retrieve_chunks', merged, text, {
        query: queries.join(' | '),
        path: 'semantic',
        insufficient,
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
      'Keyword / exact-term retrieval via RAGFlow /api/v1/retrieval (vector_similarity_weight=0, highlight). Use for error codes (e.g. ERR-xxxx), clause numbers, person names (人名), job/position titles (職位/職稱), company names (公司名), department names (部門名), proper nouns, document titles, and exact phrases. Pass knowledgeBaseIds from the UI selection. For conceptual "how does X work" questions use retrieve_chunks instead. May be combined with retrieve_chunks in the same turn. Do not pass a result limit — server returns up to the configured page size.',
    parameters: Type.Object({
      query: Type.String({
        description:
          'Short phrase, error code, clause number, person name, job/position title, company name, department name, proper noun, or exact title to match',
      }),
      knowledgeBaseIds: Type.Array(Type.String(), {
        description:
          'User-selected app knowledge base UUIDs (from the UI selection)',
      }),
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

      const scope = await retrievalScopeForTurn(params);
      if (!scope.ok) {
        return {
          content: [{ type: 'text', text: scope.message }],
          details: { hits: [], sources: [], message: scope.message },
        };
      }

      // Always use server RAG_PAGE_SIZE — models often pass topK=10 and cap every search.
      const pageSize = ragCfg.pageSize;
      const candidateTopK = Math.max(pageSize, ragCfg.keywordTopK);
      const thr = ragCfg.keywordSimilarityThreshold;

      try {
        // RAGFlow POST /api/v1/retrieval with term ranking (v_weight=0, highlight).
        const hits = await ragflow.keywordSearch({
          datasetIds: scope.datasetIds,
          question: query,
          pageSize,
          topK: candidateTopK,
          documentIds: scope.ragflowDocumentIds,
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
        // Keyword matches are high-confidence; only mark insufficient when empty
        // or after-normalization scores are all very weak.
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

        const path = 'ragflow_retrieval_term';
        logEvidenceForLlm('keyword_search', merged, text, {
          query,
          path,
          insufficient,
        });

        return {
          content: [{ type: 'text', text }],
          details: {
            hits: merged,
            sources,
            query,
            pageSize,
            topK: candidateTopK,
            similarityThreshold: thr,
            vectorSimilarityWeight: ragCfg.keywordVectorWeight,
            path,
            adjacentExpand: ragCfg.adjacentExpandEnabled,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toolsLogger.warn(`keyword_search error: ${message}`);
        return {
          content: [
            {
              type: 'text',
              text: `keyword_search failed: ${message}. Try a shorter exact term or use retrieve_chunks.`,
            },
          ],
          details: {
            hits: [],
            sources: [],
            query,
            message,
            path: 'ragflow_retrieval_term',
          },
          // Soft failure so the agent can continue / fall back instead of hard tool error.
        };
      }
    },
  };

  const summarizeDocument: AppAgentTool = {
    name: 'summarize_document',
    label: 'Summarize document',
    description:
      'Read a full document in order (all chunks) and produce material for a whole-document summary. Prefer this for "总结/摘要/summarize this document" over retrieve_chunks or keyword_search. Pass knowledgeBaseIds from the UI selection. Identify the document via appDocumentId (best), documentNameHint (filename/title), or omit both when the selected KB has exactly one indexed document. If the user asked for a length (e.g. 5000字 / 2000 characters) or topical focus, pass that in focus. Do NOT chain many keyword searches for a summary.',
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
            'Optional focus and/or length for the summary. Include user length requests (e.g. "5000字", "about 2000 characters") and topical focus (e.g. only policy points).',
        }),
      ),
    }),
    execute: async (_id, params) => {
      const scope = await retrievalScopeForTurn(params);
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
        // Must still be inside the selected KB + optional document filter.
        const inScope = scope.accessible.some(
          (kb) =>
            kb.id === docScope.knowledgeBaseId &&
            kb.documents.some((d) => d.id === docScope.appDocumentId),
        );
        if (!inScope) {
          const message = scope.ragflowDocumentIds?.length
            ? 'Document is not in the currently selected documents. Ask the user to adjust the document selection in the UI.'
            : 'Document is not in the currently selected knowledge bases. Ask the user to select the right KB.';
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

  const profileUpdate: AppAgentTool = {
    name: 'profile_update',
    label: 'Update profile',
    description:
      'Update the user L1 profile (stable identity & defaults): display name, language, response style, bio. Use when the user sets how to address them, default reply language, overall answer style, or short background (叫我…/以後用繁中/回答短一點/我是…). Pass only fields that should change. To clear a field, pass empty string. For free-form facts/preferences that are not these profile fields, use memory_save instead. CRITICAL for displayName: copy the name EXACTLY as the user typed it (same letters/spelling); never "correct", transliterate, or retype from memory.',
    parameters: Type.Object({
      displayName: Type.Optional(
        Type.String({
          description:
            'EXACT spelling from the user message (max 80). Empty string clears. Do not alter characters (e.g. alexhong must stay alexhong, not alekhong).',
        }),
      ),
      language: Type.Optional(
        Type.String({
          description:
            'Default reply language (max 32). Empty clears. e.g. zh-Hant, en, 繁體中文',
        }),
      ),
      responseStyle: Type.Optional(
        Type.String({
          description:
            'Default length/tone/structure (max 200). Empty clears. e.g. short, detailed, bullet-first',
        }),
      ),
      bio: Type.Optional(
        Type.String({
          description:
            'Short background (max 2000). Role, team, main context. Empty string sets empty bio.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const dto: {
        displayName?: string | null;
        language?: string | null;
        responseStyle?: string | null;
        bio?: string;
      } = {};
      let any = false;
      // Prefer exact spelling from the user message (avoids model retyping typos).
      const resolvedName = resolveDisplayNameForUpdate(
        turnContext.latestUserMessage || '',
        params.displayName !== undefined
          ? String(params.displayName)
          : undefined,
      );
      if (resolvedName !== undefined) {
        any = true;
        dto.displayName = resolvedName.trim() === '' ? null : resolvedName;
      }
      if (params.language !== undefined) {
        any = true;
        const v = String(params.language);
        dto.language = v.trim() === '' ? null : v;
      }
      if (params.responseStyle !== undefined) {
        any = true;
        const v = String(params.responseStyle);
        dto.responseStyle = v.trim() === '' ? null : v;
      }
      if (params.bio !== undefined) {
        any = true;
        dto.bio = String(params.bio);
      }
      if (!any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'profile_update failed: provide at least one of displayName, language, responseStyle, bio',
            },
          ],
          details: { ok: false },
        };
      }
      try {
        const profile = await memory.updateProfile(userId, dto);
        const lines = [
          `displayName: ${profile.displayName ?? '(empty)'}`,
          `language: ${profile.language ?? '(empty)'}`,
          `responseStyle: ${profile.responseStyle ?? '(empty)'}`,
          `bio: ${profile.bio?.trim() ? profile.bio : '(empty)'}`,
        ];
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Updated profile (canonical values from database — quote displayName EXACTLY when confirming):\n` +
                `${lines.join('\n')}\n` +
                `Confirm briefly using these exact strings. Profile is injected every turn going forward.`,
            },
          ],
          details: { ok: true, profile },
        };
      } catch (err) {
        const message = toolErrorMessage(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: `profile_update failed: ${message}`,
            },
          ],
          details: { ok: false, message },
        };
      }
    },
  };

  const memorySave: AppAgentTool = {
    name: 'memory_save',
    label: 'Save memory',
    description:
      'Persist a durable L2 fact or preference as a free-form sentence for future conversations. Use when the user says 記住/记得/remember/記著/幫我記住 for something that is NOT a profile field. For name/language/overall style/bio use profile_update instead. Write ONE concise self-contained sentence in content. Do NOT use for one-off instructions for the current reply only. Do NOT dump full documents (those belong in knowledge bases).',
    parameters: Type.Object({
      content: Type.String({
        description:
          'One concise durable fact/preference (max ~500 chars), e.g. "Prefer markdown tables for comparisons"',
      }),
      category: Type.Optional(
        Type.String({
          description:
            'preference | fact | project | other (default preference when it is a style/habit; fact for identity; project for decisions)',
        }),
      ),
      pinned: Type.Optional(
        Type.Boolean({
          description:
            'true if the user wants this always prioritized (記住並置頂 / pin)',
        }),
      ),
      importance: Type.Optional(
        Type.Number({
          description:
            '1–5 importance (default 3; use 4–5 for strong preferences)',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const content = String(params.content || '').trim();
      if (!content) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'memory_save failed: content is required',
            },
          ],
          details: { ok: false },
        };
      }
      const rawCat = String(params.category || 'preference').toLowerCase();
      const allowed = ['preference', 'fact', 'project', 'other'] as const;
      const category = (allowed as readonly string[]).includes(rawCat)
        ? (rawCat as (typeof allowed)[number])
        : 'preference';
      let importance = 3;
      if (
        typeof params.importance === 'number' &&
        Number.isFinite(params.importance)
      ) {
        importance = Math.min(5, Math.max(1, Math.floor(params.importance)));
      }
      try {
        // Chat path only: optional LLM polish → one sentence; failure keeps original.
        const polished = await maybePolishMemoryContent(content);
        const item = await memory.createItem(userId, {
          content: polished.content,
          category,
          pinned: Boolean(params.pinned),
          importance,
        });
        const polishNote = polished.polished
          ? ' (content lightly polished for storage)'
          : '';
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Saved memory${polishNote} (id=${item.id}, category=${item.category}, pinned=${item.pinned}): ${item.content}\n` +
                `Confirm briefly to the user using this exact content. It will apply in future turns/chats (budgeted injection).`,
            },
          ],
          details: {
            ok: true,
            item,
            polished: polished.polished,
            originalContent: content,
          },
        };
      } catch (err) {
        const message = toolErrorMessage(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: `memory_save failed: ${message}`,
            },
          ],
          details: { ok: false, message },
        };
      }
    },
  };

  const memoryForget: AppAgentTool = {
    name: 'memory_forget',
    label: 'Forget memory',
    description:
      'Delete a previously saved personal memory when the user says 忘掉/忘记/forget/別再記得/刪除記憶. Pass query as the memory id (preferred) or a distinctive content substring. If multiple match, list them and ask the user to clarify — do not guess.',
    parameters: Type.Object({
      query: Type.String({
        description:
          'Memory id (UUID) or distinctive content substring to match an active memory',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const query = String(params.query || '').trim();
      try {
        const result = await memory.forgetByQuery(userId, query);
        if (result.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Forgot memory id=${result.deleted.id}: ${result.deleted.content}`,
              },
            ],
            details: { ok: true, deleted: result.deleted },
          };
        }
        if (result.reason === 'ambiguous' && result.candidates?.length) {
          const lines = result.candidates
            .map(
              (c, i) =>
                `${i + 1}. id=${c.id} [${c.category}] ${c.content.slice(0, 120)}`,
            )
            .join('\n');
          return {
            content: [
              {
                type: 'text' as const,
                text: `${result.message}\nCandidates:\n${lines}\nAsk the user which one, then call memory_forget with the id.`,
              },
            ],
            details: { ...result },
          };
        }
        return {
          content: [{ type: 'text' as const, text: result.message }],
          details: { ...result },
        };
      } catch (err) {
        const message = toolErrorMessage(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: `memory_forget failed: ${message}`,
            },
          ],
          details: { ok: false, message },
        };
      }
    },
  };

  const memoryList: AppAgentTool = {
    name: 'memory_list',
    label: 'List memories',
    description:
      "List the user's active personal memories (id, category, pinned, content). Use when the user asks what you remember, or before forgetting when the target is unclear. Does not return other users' data.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({
          description: 'Max items to return (default 20, max 50)',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      try {
        let limit = 20;
        if (typeof params.limit === 'number' && Number.isFinite(params.limit)) {
          limit = Math.min(50, Math.max(1, Math.floor(params.limit)));
        }
        const items = await memory.listItems(userId, { status: 'active' });
        const slice = items.slice(0, limit);
        if (!slice.length) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No active personal memories stored. User can add some via chat (記住…) or My Memory settings.',
              },
            ],
            details: { ok: true, items: [] },
          };
        }
        const lines = slice
          .map(
            (c, i) =>
              `${i + 1}. id=${c.id} [${c.category}]${c.pinned ? '[pinned]' : ''} ★${c.importance} ${c.content}`,
          )
          .join('\n');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Active memories (${slice.length}${items.length > slice.length ? ` of ${items.length}` : ''}):\n${lines}`,
            },
          ],
          details: { ok: true, items: slice, total: items.length },
        };
      } catch (err) {
        const message = toolErrorMessage(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: `memory_list failed: ${message}`,
            },
          ],
          details: { ok: false, message },
        };
      }
    },
  };

  return [
    retrieve,
    keywordSearch,
    summarizeDocument,
    profileUpdate,
    memorySave,
    memoryForget,
    memoryList,
  ];
}

export const DOMAIN_SYSTEM_PROMPT = `You are the CSB Knowledge Base Portal assistant.
You answer the current user's questions. Knowledge bases are created, managed, and selected only in the UI; you do not create or list them.

Language (priority, highest first):
- Explicit override in the current user message (e.g. "用英文回答" / "reply in English") — honor for this turn.
- Profile Language (injected each turn under Profile → Language when set in My Memory or via profile_update) — use as the default reply language for all turns. Do not switch just because the user wrote in another language.
- If Profile has no Language: match the language of the user's message when clear (Chinese → Chinese, English → English, etc.).
- If still unclear: Traditional Chinese (繁體中文).
- Profile language can be set/changed via profile_update or the My Memory UI; after it is set, prefer it until the user changes it or overrides in a message.

Personal memory tools (always available; durable across chats):
- profile_update — L1 stable identity/defaults: displayName (叫我… / should be … / my name is …), language, responseStyle, bio. Pass only changed fields. Prefer this over memory_save for those fields. displayName MUST be copied character-for-character from the user message (never retype or "fix" spelling).
- memory_save — L2 free-form long-term facts (記住/记得/remember/記著/幫我記住) that are NOT name/language/style/bio. Pass the user's intent as content; server may lightly polish to one sentence (proper nouns kept exact). category preference|fact|project|other. Pin only if they ask.
- memory_forget — forget an L2 item (忘掉/忘记/forget). Prefer memory id; else content substring. If multiple match, ask which one.
- memory_list — what you remember / 你還記得什麼 (lists L2 items; profile is separate and already in context when set).
- When the user asks their name / 我叫什麼 / what is my name: use the injected Profile Name field EXACTLY (same characters). Do not invent or alter spelling. If Profile has no Name, say you do not have a stored name.
- After profile_update, confirm using the tool result displayName string exactly as returned (DB canonical).
- Do NOT call memory_save or profile_update for one-off instructions that only apply to the current answer.
- Do NOT put document/PDF content into memory; use knowledge bases for documents.
- Profile and memories can also be edited in the UI (My Memory).

Retrieval tools (when knowledge bases are selected):
- summarize_document — WHOLE-document summary / 总结整份文件 / 全文摘要 / "summarize this document". Reads all chunks in order and returns full text for you to summarize. Prefer ONE call. Pass knowledgeBaseIds; identify doc via appDocumentId, documentNameHint (filename), or omit both if the selected KB has exactly one document. Put length requests (e.g. 5000字) and topical focus into the focus parameter.
- retrieve_chunks — concepts, mechanisms, partial topics, comparisons, open-ended factual questions (semantic/hybrid). NOT for whole-document summaries.
- keyword_search — error codes, clause numbers, person names (人名), job/position titles (職位/職稱), company names (公司名), department names (部門名), proper nouns, exact phrases, titles. Prefer this whenever the user asks about a specific person, role/title, company, or department in documents. Do NOT spam keyword_search to "cover" a full document for summary.
- You may call retrieve_chunks and keyword_search in the same turn for non-summary Q&A when helpful (concept + exact term).

Rules:
- Knowledge bases are selected by the user in the UI only. Never invent or guess knowledge base ids or document ids.
- Do NOT call retrieval tools for greetings, small talk, or meta questions about you (e.g. hello, hi, 你好, who are you, 你是誰, what can you do, 你可以做什麼, thanks). Answer those directly from this system role without tools or sources. For "what do you remember about me", use memory_list instead of retrieval.
- Whole-document summary intent (总结/摘要/概述整份/summarize this document/全文) → call summarize_document once. Do NOT chain many retrieve_chunks or keyword_search queries for that intent.
- When the user specifies a length or depth for a summary (e.g. 5000字, 約3000字, about 2000 characters, detailed/詳細), you MUST honor it: pass that requirement in summarize_document.focus and expand the final answer to approach the requested length. Do not stop at a short outline when they asked for a long summary.
- For non-summary Q&A, be concise and practical unless the user asks for detail or a specific length.
- When the user asks a non-summary factual question that needs document content AND selected knowledge base IDs are present, you MUST call at least one retrieval tool (retrieve_chunks and/or keyword_search) with those knowledgeBaseIds before answering. Do not invent document content.
- Prefer a self-contained question (resolve "it/this/上面" from history). Optional queries[] for multi-aspect topics on retrieve_chunks.
- If no knowledge bases are selected, answer without document retrieval and, if facts from documents are needed, ask the user to select knowledge bases in the UI.
- Only use tool evidence for document content; cite with [1], [2] matching evidence indices.
- If retrieval returns no / weak evidence, say you don't know based on the selected knowledge bases.
- Knowledge bases are user-private; never claim access to other users' data.
- Mention document names when citing facts.
`;

/** Build a prompt prefix when the UI has knowledge bases selected. */
export function buildSelectedKbPromptPrefix(
  selected: Array<{ id: string; name: string }>,
  opts?: {
    rewriteQuery?: string;
    /** Explicit UI document filter (names for the model; enforcement is server-side). */
    documents?: Array<{ id: string; name: string; knowledgeBaseId?: string }>;
    /** KB ids that remain whole-KB under mixed expansion. */
    entireKbIds?: string[];
  },
): string {
  if (!selected.length) return '';
  const lines = selected.map((k) => `- ${k.name} (id: ${k.id})`).join('\n');
  const ids = JSON.stringify(selected.map((k) => k.id));
  const rewriteHint = opts?.rewriteQuery
    ? `Suggested retrieval question (self-contained): ${opts.rewriteQuery}\n` +
      `You may pass this as retrieve_chunks.question or keyword_search.query (or refine it). ` +
      `Do not treat length/format instructions as retrieval terms; put those in summarize_document.focus or the final answer.\n\n`
    : '';

  const docs = opts?.documents || [];
  const entireKbIds = new Set(opts?.entireKbIds || []);
  let docBlock = '';
  if (docs.length) {
    const entireLines = selected
      .filter((k) => entireKbIds.has(k.id))
      .map((k) => `- ${k.name}: all indexed documents`);
    const explicitLines = docs.map((d) => `- ${d.name} (id: ${d.id})`);
    docBlock =
      `[Selected documents (retrieval is limited to this scope)]\n` +
      [...entireLines, ...explicitLines].join('\n') +
      `\n` +
      `Do not retrieve or invent content from other documents. Prefer appDocumentId from this list when summarizing.\n\n`;
  }

  return (
    `[Selected knowledge bases for this question]\n${lines}\n\n` +
    docBlock +
    `If this is a greeting, small talk, or a question about you / your capabilities (not document facts), answer directly WITHOUT calling retrieval tools. ` +
    `If the user wants a whole-document summary (总结/摘要/summarize this document), call summarize_document once with knowledgeBaseIds=${ids} ` +
    `(pass documentNameHint if they named a file; appDocumentId if known; pass focus with any length request like 5000字 and topical focus). ` +
    `Honor user-requested summary length — expand thoroughly, do not give a short outline when they asked for many characters. Do not chain keyword_search for summaries. ` +
    `If the user needs other facts from the selected knowledge bases, retrieve with knowledgeBaseIds=${ids} before answering ` +
    `(use retrieve_chunks for concepts; keyword_search for codes/exact phrases/person names/job titles/company names/department names; both if helpful). ` +
    `Base your analysis only on the retrieved evidence. Cite with [1], [2], … and mention document names.\n\n` +
    rewriteHint +
    `[User question]\n`
  );
}
