import { KnowledgeService } from '../knowledge/knowledge.service';
import { DocumentsService } from '../documents/documents.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { PrismaService } from '../prisma/prisma.service';

/** Local tool shape compatible with pi-agent-core AgentTool execute contract. */
export type AppAgentTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (partial: unknown) => void,
  ) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details?: unknown;
  }>;
};

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

export function createUserTools(deps: {
  userId: string;
  knowledge: KnowledgeService;
  documents: DocumentsService;
  ragflow: RagflowService;
  prisma: PrismaService;
}): AppAgentTool[] {
  const { userId, knowledge, documents, ragflow, prisma } = deps;

  const listKbs: AppAgentTool = {
    name: 'list_my_knowledge_bases',
    label: 'List knowledge bases',
    description: 'List knowledge bases owned by the current user.',
    parameters: objectSchema({}),
    execute: async () => {
      const items = await knowledge.list(userId);
      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
        details: { count: items.length },
      };
    },
  };

  const createKb: AppAgentTool = {
    name: 'create_knowledge_base',
    label: 'Create knowledge base',
    description: 'Create a new knowledge base for the current user.',
    parameters: objectSchema(
      {
        name: { type: 'string', description: 'Knowledge base name' },
        description: { type: 'string' },
        chunkMethod: { type: 'string' },
      },
      ['name'],
    ),
    execute: async (_id, params) => {
      const kb = await knowledge.create(userId, {
        name: String(params.name || ''),
        description: params.description ? String(params.description) : undefined,
        chunkMethod: params.chunkMethod ? String(params.chunkMethod) : undefined,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(kb, null, 2) }],
        details: kb,
      };
    },
  };

  const listDocs: AppAgentTool = {
    name: 'list_documents',
    label: 'List documents',
    description: 'List documents in a knowledge base owned by the user.',
    parameters: objectSchema(
      { knowledgeBaseId: { type: 'string' } },
      ['knowledgeBaseId'],
    ),
    execute: async (_id, params) => {
      const items = await documents.list(userId, String(params.knowledgeBaseId));
      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
        details: { count: items.length },
      };
    },
  };

  const parseDocs: AppAgentTool = {
    name: 'parse_documents',
    label: 'Parse documents',
    description: 'Trigger chunking/parse for a document in an owned knowledge base.',
    parameters: objectSchema(
      {
        knowledgeBaseId: { type: 'string' },
        documentId: { type: 'string' },
      },
      ['knowledgeBaseId', 'documentId'],
    ),
    execute: async (_id, params) => {
      const doc = await documents.parse(
        userId,
        String(params.knowledgeBaseId),
        String(params.documentId),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }],
        details: doc,
      };
    },
  };

  const previewDoc: AppAgentTool = {
    name: 'preview_document',
    label: 'Preview document',
    description: 'Preview document metadata and sample chunks.',
    parameters: objectSchema(
      {
        knowledgeBaseId: { type: 'string' },
        documentId: { type: 'string' },
      },
      ['knowledgeBaseId', 'documentId'],
    ),
    execute: async (_id, params) => {
      const preview = await documents.preview(
        userId,
        String(params.knowledgeBaseId),
        String(params.documentId),
        5,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(preview, null, 2) }],
        details: preview,
      };
    },
  };

  const retrieve: AppAgentTool = {
    name: 'retrieve_chunks',
    label: 'Retrieve chunks',
    description:
      'Retrieve relevant chunks from the user knowledge bases to answer a question.',
    parameters: objectSchema(
      {
        question: { type: 'string' },
        knowledgeBaseId: { type: 'string' },
        topK: { type: 'number' },
      },
      ['question'],
    ),
    execute: async (_id, params) => {
      let kbs = await knowledge.list(userId);
      if (params.knowledgeBaseId) {
        kbs = kbs.filter((k) => k.id === String(params.knowledgeBaseId));
      }
      if (!kbs.length) {
        return {
          content: [{ type: 'text', text: 'No knowledge bases available.' }],
          details: { hits: [] },
        };
      }
      const owned = await prisma.knowledgeBase.findMany({
        where: { ownerUserId: userId, id: { in: kbs.map((k) => k.id) } },
      });
      const hits = await ragflow.retrieve({
        datasetIds: owned.map((k) => k.ragflowDatasetId),
        question: String(params.question || ''),
        topK: typeof params.topK === 'number' ? params.topK : 6,
      });
      const byRf = new Map(owned.map((k) => [k.ragflowDatasetId, k]));
      const mapped = hits.map((h) => ({
        ...h,
        knowledgeBaseId: h.datasetId ? byRf.get(h.datasetId)?.id : undefined,
        knowledgeBaseName: h.datasetId ? byRf.get(h.datasetId)?.name : undefined,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(mapped, null, 2) }],
        details: { hits: mapped },
      };
    },
  };

  return [listKbs, createKb, listDocs, parseDocs, previewDoc, retrieve];
}

export const DOMAIN_SYSTEM_PROMPT = `You are a vertical-domain RAG expert assistant for pi-rag.
You help the current user manage their private knowledge bases and answer questions using only their data.

Rules:
- Only use tools to access knowledge; never invent document contents.
- Knowledge bases are user-private; never claim access to other users' data.
- Prefer retrieve_chunks before answering domain questions.
- If retrieval returns nothing relevant, say you don't know based on the knowledge base.
- When helping with ingestion, guide: create KB → upload (via UI) → parse → preview chunks.
- Be concise and practical. Cite document names when possible.
`;
