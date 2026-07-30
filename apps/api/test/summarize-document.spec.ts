import { describe, expect, it, vi } from 'vitest';
import type { RetrievalScopeOk } from '../src/rag/resolve-scope';
import {
  chunksToMappedHits,
  listAllDocumentChunks,
  matchDocumentsByNameHint,
  partitionHitsByCharBudget,
  resolveSummaryDocument,
  runSummarizeDocument,
  type DocCandidate,
} from '../src/rag/summarize-document';
import type { MappedHit } from '../src/rag/evidence';

function sampleDoc(
  overrides: Partial<DocCandidate> & Pick<DocCandidate, 'appDocumentId' | 'documentName'>,
): DocCandidate {
  return {
    ragflowDocumentId: `rf-${overrides.appDocumentId}`,
    knowledgeBaseId: 'kb-1',
    knowledgeBaseName: 'KB One',
    ragflowDatasetId: 'ds-1',
    ...overrides,
  };
}

function scopeWithDocs(docs: DocCandidate[]): RetrievalScopeOk {
  const byKb = new Map<string, DocCandidate[]>();
  for (const d of docs) {
    const list = byKb.get(d.knowledgeBaseId) || [];
    list.push(d);
    byKb.set(d.knowledgeBaseId, list);
  }
  return {
    ok: true,
    datasetIds: [...byKb.keys()].map((id) => docs.find((d) => d.knowledgeBaseId === id)!.ragflowDatasetId),
    accessible: [...byKb.entries()].map(([kbId, list]) => ({
      id: kbId,
      name: list[0]!.knowledgeBaseName,
      ragflowDatasetId: list[0]!.ragflowDatasetId,
      documents: list.map((d) => ({
        id: d.appDocumentId,
        name: d.documentName,
        ragflowDocumentId: d.ragflowDocumentId,
      })),
    })),
    mapHit: (h) => h as MappedHit,
  };
}

function hit(content: string, id: string): MappedHit {
  return {
    id,
    content,
    documentName: 'doc.md',
    appDocumentId: 'doc-1',
  };
}

describe('matchDocumentsByNameHint', () => {
  const docs = [
    sampleDoc({ appDocumentId: 'a', documentName: '2026.07.transcript.md' }),
    sampleDoc({ appDocumentId: 'b', documentName: 'policy.pdf' }),
    sampleDoc({ appDocumentId: 'c', documentName: 'notes.md' }),
  ];

  it('matches exact filename case-insensitively', () => {
    const m = matchDocumentsByNameHint(docs, '2026.07.TRANSCRIPT.md');
    expect(m).toHaveLength(1);
    expect(m[0]!.appDocumentId).toBe('a');
  });

  it('matches basename without extension', () => {
    const m = matchDocumentsByNameHint(docs, '2026.07.transcript');
    expect(m).toHaveLength(1);
    expect(m[0]!.appDocumentId).toBe('a');
  });

  it('matches substring', () => {
    const m = matchDocumentsByNameHint(docs, 'transcript');
    expect(m).toHaveLength(1);
    expect(m[0]!.appDocumentId).toBe('a');
  });
});

describe('resolveSummaryDocument', () => {
  it('auto-selects when only one indexed document', () => {
    const only = sampleDoc({
      appDocumentId: 'solo',
      documentName: 'only.md',
    });
    const r = resolveSummaryDocument(scopeWithDocs([only]), {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.appDocumentId).toBe('solo');
  });

  it('requires hint when multiple documents', () => {
    const r = resolveSummaryDocument(
      scopeWithDocs([
        sampleDoc({ appDocumentId: 'a', documentName: 'a.md' }),
        sampleDoc({ appDocumentId: 'b', documentName: 'b.md' }),
      ]),
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/Multiple documents/i);
      expect(r.candidates?.length).toBe(2);
    }
  });

  it('resolves by documentNameHint', () => {
    const r = resolveSummaryDocument(
      scopeWithDocs([
        sampleDoc({ appDocumentId: 'a', documentName: 'a.md' }),
        sampleDoc({
          appDocumentId: 'b',
          documentName: '2026.07.transcript.md',
        }),
      ]),
      { documentNameHint: '2026.07.transcript.md' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.appDocumentId).toBe('b');
  });

  it('resolves by appDocumentId', () => {
    const r = resolveSummaryDocument(
      scopeWithDocs([
        sampleDoc({ appDocumentId: 'a', documentName: 'a.md' }),
        sampleDoc({ appDocumentId: 'b', documentName: 'b.md' }),
      ]),
      { appDocumentId: 'b' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.documentName).toBe('b.md');
  });
});

describe('partitionHitsByCharBudget', () => {
  it('keeps order and splits by budget', () => {
    const hits = [hit('aaaa', '1'), hit('bbbb', '2'), hit('cccc', '3')];
    const parts = partitionHitsByCharBudget(hits, 8);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.map((h) => h.id)).toEqual(['1', '2']);
    expect(parts[1]!.map((h) => h.id)).toEqual(['3']);
  });

  it('puts oversized single chunk in its own segment', () => {
    const hits = [hit('x'.repeat(20), 'big')];
    const parts = partitionHitsByCharBudget(hits, 5);
    expect(parts).toHaveLength(1);
    expect(parts[0]![0]!.id).toBe('big');
  });
});

describe('listAllDocumentChunks', () => {
  it('paginates until short page', async () => {
    const listChunks = vi
      .fn()
      .mockResolvedValueOnce({
        chunks: [{ id: '1', content: 'a' }, { id: '2', content: 'b' }],
        total: 3,
      })
      .mockResolvedValueOnce({
        chunks: [{ id: '3', content: 'c' }],
        total: 3,
      });

    const res = await listAllDocumentChunks(listChunks, 'ds', 'doc', 2);
    expect(res.chunks).toHaveLength(3);
    expect(listChunks).toHaveBeenCalledTimes(2);
  });
});

describe('runSummarizeDocument', () => {
  const doc = sampleDoc({
    appDocumentId: 'doc-1',
    documentName: 'short.md',
  });

  it('uses full_text path when under direct budget', async () => {
    const listChunks = vi.fn().mockResolvedValue({
      chunks: [
        { id: 'c1', content: 'Hello world section one.' },
        { id: 'c2', content: 'Section two with more detail.' },
      ],
      total: 2,
    });

    const result = await runSummarizeDocument({
      doc,
      listChunks,
      chatComplete: vi.fn(),
    });

    expect(result.details.path).toBe('full_text');
    expect(result.details.chunkCount).toBe(2);
    expect(result.text).toMatch(/full_text|Full document/i);
    expect(result.sources.length).toBe(2);
    expect(result.details.truncated).toBe(false);
  });

  it('uses map_reduce when over direct budget', async () => {
    const prev = process.env.RAG_SUMMARIZE_DIRECT_CHARS;
    const prevMap = process.env.RAG_SUMMARIZE_MAP_CHARS;
    // Config floors DIRECT at 2000 and MAP at 2000 — exceed those floors.
    process.env.RAG_SUMMARIZE_DIRECT_CHARS = '2000';
    process.env.RAG_SUMMARIZE_MAP_CHARS = '2000';

    try {
      const longA = 'A'.repeat(1500);
      const longB = 'B'.repeat(1500);
      const listChunks = vi.fn().mockResolvedValue({
        chunks: [
          { id: 'c1', content: longA },
          { id: 'c2', content: longB },
        ],
        total: 2,
      });

      const chatComplete = vi
        .fn()
        .mockResolvedValueOnce('Section A summary')
        .mockResolvedValueOnce('Section B summary')
        .mockResolvedValueOnce('Merged full summary of A and B');

      const result = await runSummarizeDocument({
        doc,
        listChunks,
        chatComplete,
        focus: 'key points',
      });

      expect(result.details.path).toBe('map_reduce');
      expect(result.details.mapSegments).toBeGreaterThanOrEqual(1);
      expect(result.text).toMatch(/Merged full summary|map_reduce/i);
      expect(chatComplete.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(result.sources[0]?.appDocumentId).toBe('doc-1');
    } finally {
      if (prev === undefined) delete process.env.RAG_SUMMARIZE_DIRECT_CHARS;
      else process.env.RAG_SUMMARIZE_DIRECT_CHARS = prev;
      if (prevMap === undefined) delete process.env.RAG_SUMMARIZE_MAP_CHARS;
      else process.env.RAG_SUMMARIZE_MAP_CHARS = prevMap;
    }
  });

  it('handles empty document', async () => {
    const listChunks = vi.fn().mockResolvedValue({ chunks: [], total: 0 });
    const result = await runSummarizeDocument({ doc, listChunks });
    expect(result.details.chunkCount).toBe(0);
    expect(result.text).toMatch(/no chunks/i);
  });
});

describe('chunksToMappedHits', () => {
  it('preserves order and maps ids', () => {
    const doc = sampleDoc({ appDocumentId: 'd1', documentName: 'n.md' });
    const hits = chunksToMappedHits(
      [
        { id: '1', content: 'a' },
        { id: '2', content_with_weight: 'b' },
      ],
      doc,
    );
    expect(hits.map((h) => h.content)).toEqual(['a', 'b']);
    expect(hits[0]!.appDocumentId).toBe('d1');
  });
});
