import { Type } from 'typebox';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { PrismaService } from '../prisma/prisma.service';
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
      'Retrieve relevant text chunks from knowledge bases the user selected in the UI. Prefer this before claiming facts from documents. Pass knowledgeBaseIds from the selected-KB prompt (required). Prefer a clear self-contained question (or queries[] for multi-aspect). Returns ranked evidence with [n] citation indices.',
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
      const multiIds = asStringArray(params.knowledgeBaseIds);
      const singleId = params.knowledgeBaseId
        ? String(params.knowledgeBaseId)
        : '';
      const scopeIds = multiIds.length
        ? multiIds
        : singleId
          ? [singleId]
          : [];

      // KBs are chosen only by the user in the UI — never invent or auto-pick ids.
      if (!scopeIds.length) {
        const message =
          'No knowledge bases selected. The user must select knowledge bases in the UI before retrieval.';
        return {
          content: [{ type: 'text', text: message }],
          details: { hits: [], sources: [], message },
        };
      }

      // Readable KBs only (owned, public, or shared) — never invent ids.
      let kbs = await knowledge.list(userId);
      const allowed = new Set(scopeIds);
      kbs = kbs.filter((k) => allowed.has(k.id));
      if (!kbs.length) {
        const message =
          'Selected knowledge base ids were not found or are not accessible to this user.';
        return {
          content: [{ type: 'text', text: message }],
          details: { hits: [], sources: [], message },
        };
      }

      const accessible = await prisma.knowledgeBase.findMany({
        where: {
          id: { in: kbs.map((k) => k.id) },
          OR: [
            { ownerUserId: userId },
            { visibility: 'public' },
            { members: { some: { userId } } },
          ],
        },
        include: {
          documents: {
            select: {
              id: true,
              ragflowDocumentId: true,
              name: true,
            },
          },
        },
      });

      const pageSize = clampPageSize(params.topK, ragCfg.pageSize, 20);
      // Over-retrieve candidates inside RAGFlow (~3x page, or env RAG_TOP_K).
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

      const datasetIds = accessible.map((k) => k.ragflowDatasetId);
      const allHits: MappedHit[] = [];

      for (const q of queries) {
        const hits = await ragflow.retrieve({
          datasetIds,
          question: q,
          pageSize,
          topK,
          similarityThreshold: ragCfg.similarityThreshold,
          vectorSimilarityWeight: ragCfg.vectorSimilarityWeight,
          rerankId: ragCfg.rerankId,
        });
        for (const h of hits) {
          allHits.push({ ...h, sourceQuery: q });
        }
      }

      const byRf = new Map(accessible.map((k) => [k.ragflowDatasetId, k]));
      const docByRf = new Map<
        string,
        { appDocumentId: string; knowledgeBaseId: string; name: string }
      >();
      for (const kb of accessible) {
        for (const d of kb.documents) {
          docByRf.set(d.ragflowDocumentId, {
            appDocumentId: d.id,
            knowledgeBaseId: kb.id,
            name: d.name,
          });
        }
      }

      const mapped: MappedHit[] = allHits.map((h) => {
        const kb = h.datasetId ? byRf.get(h.datasetId) : undefined;
        const doc = h.documentId ? docByRf.get(h.documentId) : undefined;
        return {
          ...h,
          documentName: h.documentName || doc?.name,
          knowledgeBaseId: kb?.id ?? doc?.knowledgeBaseId,
          knowledgeBaseName: kb?.name,
          appDocumentId: doc?.appDocumentId,
        };
      });

      let merged = dedupeHitsById(mapped);
      merged = filterHitsByThreshold(merged, ragCfg.similarityThreshold);
      merged = merged.slice(0, pageSize);

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
        },
      };
    },
  };

  return [retrieve];
}

export const DOMAIN_SYSTEM_PROMPT = `You are the CSB Knowledge Base Portal assistant.
You answer the current user's questions. Knowledge bases are created, managed, and selected only in the UI; you do not create or list them.

Language:
- Default language is Traditional Chinese (繁體中文). Reply in Traditional Chinese unless the user writes in English.
- If the user writes primarily in English, reply in English.
- Match the user's language for mixed or other languages when clear; otherwise prefer Traditional Chinese.

Rules:
- Knowledge bases are selected by the user in the UI only. Never invent or guess knowledge base ids.
- Do NOT call retrieve_chunks for greetings, small talk, or meta questions about you (e.g. hello, hi, 你好, who are you, 你是誰, what can you do, 你可以做什麼, thanks). Answer those directly from this system role without tools or sources.
- When the user asks a factual question that needs document content AND selected knowledge base IDs are present, you MUST call retrieve_chunks with those knowledgeBaseIds before answering. Do not invent document content.
- Prefer a self-contained question (resolve "it/this/上面" from history). Optional queries[] for multi-aspect topics.
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
      `You may pass this as retrieve_chunks.question (or refine it).\n\n`
    : '';
  return (
    `[Selected knowledge bases for this question]\n${lines}\n\n` +
    `If this is a greeting, small talk, or a question about you / your capabilities (not document facts), answer directly WITHOUT calling retrieve_chunks. ` +
    `If the user needs facts from the selected knowledge bases, call retrieve_chunks with knowledgeBaseIds=${ids} before answering. ` +
    `Base your analysis only on the retrieved evidence. Cite with [1], [2], … and mention document names.\n\n` +
    rewriteHint +
    `[User question]\n`
  );
}
