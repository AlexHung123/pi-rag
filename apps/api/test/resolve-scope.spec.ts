import { describe, expect, it, vi } from 'vitest';
import {
  resolveDocumentScope,
  resolveRetrievalScope,
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
