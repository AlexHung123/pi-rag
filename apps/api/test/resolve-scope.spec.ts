import { describe, expect, it, vi } from 'vitest';
import {
  expandUiDocumentFilter,
  resolveDocumentScope,
  resolveRetrievalScope,
  type ScopedKnowledgeBase,
} from '../src/rag/resolve-scope';
import type { KnowledgeService } from '../src/knowledge/knowledge.service';
import type { PrismaService } from '../src/prisma/prisma.service';

function mockKnowledge(
  list: Array<{ id: string; name: string }>,
): KnowledgeService {
  return {
    list: vi.fn().mockResolvedValue(list),
    canRead: vi.fn().mockImplementation((userId: string, kb: { ownerUserId: string }) => {
      return kb.ownerUserId === userId || (kb as { visibility?: string }).visibility === 'public';
    }),
  } as unknown as KnowledgeService;
}

const sampleAccessible: ScopedKnowledgeBase[] = [
  {
    id: 'kb-1',
    name: 'PolicyAddress2',
    ragflowDatasetId: 'rf-ds-1',
    documents: [
      { id: 'app-d1', ragflowDocumentId: 'rf-d1', name: 'a.pdf' },
      { id: 'app-d2', ragflowDocumentId: 'rf-d2', name: 'b.pdf' },
    ],
  },
  {
    id: 'kb-2',
    name: 'SFC',
    ragflowDatasetId: 'rf-ds-2',
    documents: [
      { id: 'app-d3', ragflowDocumentId: 'rf-d3', name: 'c.pdf' },
      { id: 'app-d4', ragflowDocumentId: 'rf-d4', name: 'd.pdf' },
    ],
  },
];

describe('expandUiDocumentFilter', () => {
  it('returns no document_ids filter when ui selection empty', () => {
    const r = expandUiDocumentFilter(sampleAccessible, []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ragflowDocumentIds).toBeUndefined();
    expect(r.accessible).toEqual(sampleAccessible);
    expect(r.entireKbIds).toEqual(['kb-1', 'kb-2']);
  });

  it('mixed expansion: partial KB2 + whole KB1', () => {
    const r = expandUiDocumentFilter(sampleAccessible, ['app-d3']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entireKbIds).toEqual(['kb-1']);
    expect(r.selectedDocumentIds).toEqual(['app-d3']);
    expect(r.ragflowDocumentIds?.sort()).toEqual(
      ['rf-d1', 'rf-d2', 'rf-d3'].sort(),
    );
    const kb2 = r.accessible.find((k) => k.id === 'kb-2');
    expect(kb2?.documents.map((d) => d.id)).toEqual(['app-d3']);
    const kb1 = r.accessible.find((k) => k.id === 'kb-1');
    expect(kb1?.documents).toHaveLength(2);
  });

  it('fails closed when all document ids invalid', () => {
    const r = expandUiDocumentFilter(sampleAccessible, ['nope']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/not found or are not accessible/i);
    }
  });
});

describe('resolveRetrievalScope', () => {
  it('fails closed when no knowledge base ids selected', async () => {
    const knowledge = mockKnowledge([{ id: 'kb-1', name: 'A' }]);
    const prisma = { knowledgeBase: { findMany: vi.fn() } } as unknown as PrismaService;

    const scope = await resolveRetrievalScope('user-1', [], knowledge, prisma);

    expect(scope.ok).toBe(false);
    if (!scope.ok) {
      expect(scope.message).toMatch(/No knowledge bases selected/i);
    }
    expect(prisma.knowledgeBase.findMany).not.toHaveBeenCalled();
  });

  it('fails closed when selected ids are not accessible', async () => {
    const knowledge = mockKnowledge([{ id: 'kb-owned', name: 'Mine' }]);
    const prisma = { knowledgeBase: { findMany: vi.fn() } } as unknown as PrismaService;

    const scope = await resolveRetrievalScope(
      'user-1',
      ['kb-foreign'],
      knowledge,
      prisma,
    );

    expect(scope.ok).toBe(false);
    if (!scope.ok) {
      expect(scope.message).toMatch(/not found or are not accessible/i);
    }
    expect(prisma.knowledgeBase.findMany).not.toHaveBeenCalled();
  });

  it('maps document filter to ragflow document ids', async () => {
    const knowledge = mockKnowledge([
      { id: 'kb-1', name: 'PolicyAddress2' },
    ]);
    const prisma = {
      knowledgeBase: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'kb-1',
            name: 'PolicyAddress2',
            ragflowDatasetId: 'rf-ds-1',
            documents: [
              {
                id: 'app-d1',
                ragflowDocumentId: 'rf-d1',
                name: 'a.pdf',
                status: 'done',
              },
              {
                id: 'app-d2',
                ragflowDocumentId: 'rf-d2',
                name: 'b.pdf',
                status: 'done',
              },
              {
                id: 'app-running',
                ragflowDocumentId: 'rf-run',
                name: 'c.pdf',
                status: 'running',
              },
            ],
          },
        ]),
      },
    } as unknown as PrismaService;

    const scope = await resolveRetrievalScope(
      'user-1',
      ['kb-1'],
      knowledge,
      prisma,
      { documentIds: ['app-d2'] },
    );

    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.ragflowDocumentIds).toEqual(['rf-d2']);
    expect(scope.accessible[0]?.documents.map((d) => d.id)).toEqual(['app-d2']);
  });
});

describe('resolveDocumentScope', () => {
  it('fails closed when document missing', async () => {
    const knowledge = mockKnowledge([]);
    const prisma = {
      document: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaService;

    const scope = await resolveDocumentScope(
      'user-1',
      'doc-missing',
      knowledge,
      prisma,
    );

    expect(scope.ok).toBe(false);
    if (!scope.ok) {
      expect(scope.message).toMatch(/not found or not accessible/i);
    }
  });

  it('fails closed when user cannot read the KB', async () => {
    const knowledge = {
      list: vi.fn(),
      canRead: vi.fn().mockReturnValue(false),
    } as unknown as KnowledgeService;
    const prisma = {
      document: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'doc-1',
          name: 'Secret.pdf',
          ragflowDocumentId: 'rf-doc',
          knowledgeBase: {
            id: 'kb-1',
            name: 'Other',
            ownerUserId: 'user-other',
            visibility: 'private',
            ragflowDatasetId: 'rf-ds',
            members: [],
          },
        }),
      },
    } as unknown as PrismaService;

    const scope = await resolveDocumentScope('user-1', 'doc-1', knowledge, prisma);

    expect(scope.ok).toBe(false);
    if (!scope.ok) {
      expect(scope.message).toMatch(/not found or not accessible/i);
    }
  });
});
