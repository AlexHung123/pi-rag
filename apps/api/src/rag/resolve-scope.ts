/**
 * Shared ownership + id-mapping for all retrieval tools.
 * Tools never invent knowledge-base or document ids.
 *
 * Document filter (optional UI selection) maps to RAGFlow
 * POST /api/v1/retrieval body.document_ids (see RAGFlow HTTP API).
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

function hasRagflowId(
  d: { id: string; ragflowDocumentId: string | null; name: string },
): d is { id: string; ragflowDocumentId: string; name: string } {
  return Boolean(d.ragflowDocumentId);
}

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
  /**
   * RAGFlow document ids for POST /api/v1/retrieval `document_ids`.
   * Undefined = no document-level filter (search whole selected datasets).
   */
  ragflowDocumentIds?: string[];
  /** Explicit UI document UUIDs that survived validation (empty if no filter). */
  selectedDocumentIds: string[];
  /** KB ids treated as "entire KB" under mixed expansion. */
  entireKbIds: string[];
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

export type ResolveRetrievalScopeOptions = {
  /**
   * Optional UI-selected portal document UUIDs.
   * Empty/omit → whole selected KBs.
   * Non-empty → mixed expansion (see expandUiDocumentFilter).
   */
  documentIds?: string[];
};

/**
 * Mixed expansion for optional document filter under selected KBs.
 *
 * When `uiDocumentIds` is empty: no filter (caller keeps full accessible lists).
 * When non-empty:
 * - KBs with ≥1 valid selected doc → only those docs
 * - KBs with 0 selected docs → entire KB (all ready docs)
 * - If no selected id is valid for any accessible KB → fail closed
 */
export function expandUiDocumentFilter(
  accessible: ScopedKnowledgeBase[],
  uiDocumentIds: string[] | undefined,
):
  | {
      ok: true;
      accessible: ScopedKnowledgeBase[];
      ragflowDocumentIds?: string[];
      selectedDocumentIds: string[];
      entireKbIds: string[];
    }
  | { ok: false; message: string } {
  const raw = (uiDocumentIds || []).map(String).filter(Boolean);
  if (!raw.length) {
    return {
      ok: true,
      accessible,
      ragflowDocumentIds: undefined,
      selectedDocumentIds: [],
      entireKbIds: accessible.map((k) => k.id),
    };
  }

  const wanted = new Set(raw);
  const docByAppId = new Map<
    string,
    { kb: ScopedKnowledgeBase; doc: ScopedDocument }
  >();
  for (const kb of accessible) {
    for (const d of kb.documents) {
      docByAppId.set(d.id, { kb, doc: d });
    }
  }

  const validSelected: Array<{ kbId: string; doc: ScopedDocument }> = [];
  for (const id of wanted) {
    const hit = docByAppId.get(id);
    if (hit) validSelected.push({ kbId: hit.kb.id, doc: hit.doc });
  }

  if (!validSelected.length) {
    return {
      ok: false,
      message:
        'Selected documents were not found or are not accessible in the selected knowledge bases.',
    };
  }

  const selectedByKb = new Map<string, ScopedDocument[]>();
  for (const { kbId, doc } of validSelected) {
    const list = selectedByKb.get(kbId) || [];
    if (!list.some((d) => d.id === doc.id)) list.push(doc);
    selectedByKb.set(kbId, list);
  }

  const entireKbIds: string[] = [];
  const filtered: ScopedKnowledgeBase[] = [];
  const ragflowIds: string[] = [];
  const selectedDocumentIds = validSelected.map((v) => v.doc.id);

  for (const kb of accessible) {
    const picked = selectedByKb.get(kb.id);
    if (picked?.length) {
      filtered.push({ ...kb, documents: picked });
      for (const d of picked) ragflowIds.push(d.ragflowDocumentId);
    } else {
      // Whole KB: include all ready docs so RAGFlow document_ids does not drop siblings.
      entireKbIds.push(kb.id);
      filtered.push(kb);
      for (const d of kb.documents) ragflowIds.push(d.ragflowDocumentId);
    }
  }

  return {
    ok: true,
    accessible: filtered,
    ragflowDocumentIds: [...new Set(ragflowIds)],
    selectedDocumentIds: [...new Set(selectedDocumentIds)],
    entireKbIds,
  };
}

function buildMapHit(accessible: ScopedKnowledgeBase[]) {
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

  return (h: RetrieveHit & { sourceQuery?: string }): MappedHit => {
    const kb = h.datasetId ? byRf.get(h.datasetId) : undefined;
    const doc = h.documentId ? docByRf.get(h.documentId) : undefined;
    return {
      ...h,
      documentName: h.documentName || doc?.name,
      knowledgeBaseId: kb?.id ?? doc?.knowledgeBaseId,
      knowledgeBaseName: kb?.name,
      appDocumentId: doc?.appDocumentId,
    };
  };
}

/**
 * Resolve UI-selected knowledge base ids to RAGFlow datasets the user can read.
 * Empty / foreign ids fail closed — never auto-pick KBs.
 * Optional documentIds apply mixed expansion → RAGFlow `document_ids`.
 */
export async function resolveRetrievalScope(
  userId: string,
  knowledgeBaseIds: string[],
  knowledge: KnowledgeService,
  prisma: PrismaService,
  options: ResolveRetrievalScopeOptions = {},
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
          status: true,
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

  // Ready for chat: has RAGFlow id and parse status done (skip audio awaiting transcript).
  const accessible: ScopedKnowledgeBase[] = rows.map((k) => ({
    id: k.id,
    name: k.name,
    ragflowDatasetId: k.ragflowDatasetId,
    documents: k.documents
      .filter(
        (d) =>
          hasRagflowId(d) && (d.status === 'done' || d.status == null),
      )
      .map((d) => ({
        id: d.id,
        ragflowDocumentId: d.ragflowDocumentId as string,
        name: d.name,
      })),
  }));

  const expanded = expandUiDocumentFilter(accessible, options.documentIds);
  if (!expanded.ok) {
    return expanded;
  }

  return {
    ok: true,
    accessible: expanded.accessible,
    datasetIds: expanded.accessible.map((k) => k.ragflowDatasetId),
    ragflowDocumentIds: expanded.ragflowDocumentIds,
    selectedDocumentIds: expanded.selectedDocumentIds,
    entireKbIds: expanded.entireKbIds,
    mapHit: buildMapHit(expanded.accessible),
  };
}

/**
 * Resolve a portal document UUID for document-scoped tools (e.g. summarize_document).
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

  if (!doc.ragflowDocumentId) {
    return {
      ok: false,
      message:
        'Document is not indexed yet (e.g. audio still transcribing). Try again after parse completes.',
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
