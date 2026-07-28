/**
 * Shared ownership + id-mapping for all retrieval tools.
 * Tools never invent knowledge-base or document ids.
 */

import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RetrieveHit } from '../ragflow/ragflow.types';
import type { MappedHit } from './evidence';

export type ScopedDocument = {
  id: string;
  ragflowDocumentId: string;
  name: string;
};

export type ScopedKnowledgeBase = {
  id: string;
  name: string;
  ragflowDatasetId: string;
  documents: ScopedDocument[];
};

export type RetrievalScopeOk = {
  ok: true;
  accessible: ScopedKnowledgeBase[];
  datasetIds: string[];
  mapHit: (hit: RetrieveHit & { sourceQuery?: string }) => MappedHit;
};

export type RetrievalScopeErr = {
  ok: false;
  message: string;
};

export type RetrievalScope = RetrievalScopeOk | RetrievalScopeErr;

export type DocumentScopeOk = {
  ok: true;
  appDocumentId: string;
  documentName: string;
  ragflowDocumentId: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  ragflowDatasetId: string;
};

export type DocumentScopeErr = {
  ok: false;
  message: string;
};

export type DocumentScope = DocumentScopeOk | DocumentScopeErr;

/**
 * Resolve UI-selected knowledge base ids to RAGFlow datasets the user can read.
 * Empty / foreign ids fail closed — never auto-pick KBs.
 */
export async function resolveRetrievalScope(
  userId: string,
  knowledgeBaseIds: string[],
  knowledge: KnowledgeService,
  prisma: PrismaService,
): Promise<RetrievalScope> {
  const scopeIds = (knowledgeBaseIds || []).map(String).filter(Boolean);
  if (!scopeIds.length) {
    return {
      ok: false,
      message:
        'No knowledge bases selected. The user must select knowledge bases in the UI before retrieval.',
    };
  }

  // Readable KBs only (owned, public, or shared) — never invent ids.
  let kbs = await knowledge.list(userId);
  const allowed = new Set(scopeIds);
  kbs = kbs.filter((k) => allowed.has(k.id));
  if (!kbs.length) {
    return {
      ok: false,
      message:
        'Selected knowledge base ids were not found or are not accessible to this user.',
    };
  }

  const rows = await prisma.knowledgeBase.findMany({
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

  if (!rows.length) {
    return {
      ok: false,
      message:
        'Selected knowledge base ids were not found or are not accessible to this user.',
    };
  }

  const accessible: ScopedKnowledgeBase[] = rows.map((k) => ({
    id: k.id,
    name: k.name,
    ragflowDatasetId: k.ragflowDatasetId,
    documents: k.documents.map((d) => ({
      id: d.id,
      ragflowDocumentId: d.ragflowDocumentId,
      name: d.name,
    })),
  }));

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

  return {
    ok: true,
    accessible,
    datasetIds: accessible.map((k) => k.ragflowDatasetId),
    mapHit: (h) => {
      const kb = h.datasetId ? byRf.get(h.datasetId) : undefined;
      const doc = h.documentId ? docByRf.get(h.documentId) : undefined;
      return {
        ...h,
        documentName: h.documentName || doc?.name,
        knowledgeBaseId: kb?.id ?? doc?.knowledgeBaseId,
        knowledgeBaseName: kb?.name,
        appDocumentId: doc?.appDocumentId,
      };
    },
  };
}

/**
 * Resolve a portal document UUID for list_document_chunks.
 * Fails closed on missing / unreadable documents (no existence leak beyond generic message).
 */
export async function resolveDocumentScope(
  userId: string,
  appDocumentId: string,
  knowledge: KnowledgeService,
  prisma: PrismaService,
): Promise<DocumentScope> {
  const id = (appDocumentId || '').trim();
  if (!id) {
    return {
      ok: false,
      message: 'appDocumentId is required (portal document UUID from prior sources).',
    };
  }

  const doc = await prisma.document.findFirst({
    where: { id },
    include: {
      knowledgeBase: {
        select: {
          id: true,
          name: true,
          ownerUserId: true,
          visibility: true,
          ragflowDatasetId: true,
          members: { select: { userId: true, role: true } },
        },
      },
    },
  });

  if (!doc) {
    return {
      ok: false,
      message: 'Document not found or not accessible.',
    };
  }

  const kb = doc.knowledgeBase;
  if (!knowledge.canRead(userId, kb)) {
    return {
      ok: false,
      message: 'Document not found or not accessible.',
    };
  }

  return {
    ok: true,
    appDocumentId: doc.id,
    documentName: doc.name,
    ragflowDocumentId: doc.ragflowDocumentId,
    knowledgeBaseId: kb.id,
    knowledgeBaseName: kb.name,
    ragflowDatasetId: kb.ragflowDatasetId,
  };
}
