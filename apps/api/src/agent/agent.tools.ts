import { Type } from 'typebox';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RetrieveHit } from '../ragflow/ragflow.types';

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

/** Normalized citation source for chat UI. */
export type CitationSource = {
  id: string;
  content: string;
  documentName?: string;
  documentId?: string;
  /** App document UUID (for Locate / preview). */
  appDocumentId?: string;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  score?: number;
  /** 1-based display index among returned hits. */
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

const MAX_TOP_K = 10;
const DEFAULT_TOP_K = 10;

function clampTopK(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TOP_K;
  return Math.min(MAX_TOP_K, Math.max(1, Math.floor(value)));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter(Boolean);
}

export function createUserTools(deps: {
  userId: string;
  knowledge: KnowledgeService;
  ragflow: RagflowService;
  prisma: PrismaService;
}): AppAgentTool[] {
  const { userId, knowledge, ragflow, prisma } = deps;

  const retrieve: AppAgentTool = {
    name: 'retrieve_chunks',
    label: 'Retrieve chunks',
    description:
      'Retrieve relevant text chunks from knowledge bases the user selected in the UI. Prefer this before claiming facts from documents. Pass knowledgeBaseIds from the selected-KB prompt (required). Returns at most 10 chunks (topK default 10).',
    parameters: Type.Object({
      question: Type.String({ description: 'Question or search query' }),
      knowledgeBaseId: Type.Optional(
        Type.String({ description: 'Optional single app knowledge base UUID (user-selected)' }),
      ),
      knowledgeBaseIds: Type.Optional(
        Type.Array(Type.String(), {
          description: 'User-selected app knowledge base UUIDs to search (from the UI selection)',
        }),
      ),
      topK: Type.Optional(
        Type.Number({ description: `Max chunks (default ${DEFAULT_TOP_K}, max ${MAX_TOP_K})` }),
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
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                hits: [],
                message:
                  'No knowledge bases selected. The user must select knowledge bases in the UI before retrieval.',
              }),
            },
          ],
          details: { hits: [], sources: [] },
        };
      }

      // Readable KBs only (owned, public, or shared) — never invent ids.
      let kbs = await knowledge.list(userId);
      const allowed = new Set(scopeIds);
      kbs = kbs.filter((k) => allowed.has(k.id));
      if (!kbs.length) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                hits: [],
                message:
                  'Selected knowledge base ids were not found or are not accessible to this user.',
              }),
            },
          ],
          details: { hits: [], sources: [] },
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

      const topK = clampTopK(params.topK);
      const hits = await ragflow.retrieve({
        datasetIds: accessible.map((k) => k.ragflowDatasetId),
        question: String(params.question || ''),
        topK,
      });

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

      const mapped = hits.map((h) => {
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

      const sources = hitsToCitationSources(mapped);

      return {
        content: [{ type: 'text', text: JSON.stringify(mapped, null, 2) }],
        details: { hits: mapped, sources },
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
- When the user asks a factual question that needs document content AND selected knowledge base IDs are present, you MUST call retrieve_chunks with those knowledgeBaseIds and topK=10 before answering. Do not invent document content.
- If no knowledge bases are selected, answer without document retrieval and, if facts from documents are needed, ask the user to select knowledge bases in the UI.
- Only use tool results for document content; never invent document contents.
- Knowledge bases are user-private; never claim access to other users' data.
- If retrieval returns nothing relevant, say you don't know based on the selected knowledge bases.
- Be concise and practical. Cite document names when possible.
- Prefer topK=10 (maximum 10 chunks). Use the most relevant chunks only.
`;

/** Build a prompt prefix when the UI has knowledge bases selected. */
export function buildSelectedKbPromptPrefix(
  selected: Array<{ id: string; name: string }>,
): string {
  if (!selected.length) return '';
  const lines = selected.map((k) => `- ${k.name} (id: ${k.id})`).join('\n');
  const ids = JSON.stringify(selected.map((k) => k.id));
  return (
    `[Selected knowledge bases for this question]\n${lines}\n\n` +
    `If this is a greeting, small talk, or a question about you / your capabilities (not document facts), answer directly WITHOUT calling retrieve_chunks. ` +
    `If the user needs facts from the selected knowledge bases, call retrieve_chunks with knowledgeBaseIds=${ids} and topK=10 before answering, ` +
    `base your analysis only on the retrieved chunks, and mention document names when citing facts.\n\n` +
    `[User question]\n`
  );
}
