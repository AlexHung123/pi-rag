import { describe, expect, it, vi } from 'vitest';
import type { RetrievalScopeOk } from '../src/rag/resolve-scope';
import {
  buildSummarizeDocumentHeader,
  chunksToMappedHits,
  extractSummaryLengthHint,
  listAllDocumentChunks,
  matchDocumentsByNameHint,
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

  it('merges all chunks and returns full_text for the agent', async () => {
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
    });

    expect(result.details.path).toBe('full_text');
    expect(result.details.chunkCount).toBe(2);
    expect(result.text).toMatch(/full_text|Full document/i);
    expect(result.text).toMatch(/Hello world section one/);
    expect(result.text).toMatch(/Section two with more detail/);
    expect(result.sources.length).toBe(2);
  });

  it('merges long documents the same way (no map-reduce)', async () => {
    const longA = 'A'.repeat(1500);
    const longB = 'B'.repeat(1500);
    const listChunks = vi.fn().mockResolvedValue({
      chunks: [
        { id: 'c1', content: longA },
        { id: 'c2', content: longB },
      ],
      total: 2,
    });

    const result = await runSummarizeDocument({
      doc,
      listChunks,
      focus: 'key points',
    });

    expect(result.details.path).toBe('full_text');
    expect(result.details.chunkCount).toBe(2);
    expect(result.details.totalChars).toBe(3000);
    expect(result.details.focus).toBe('key points');
    expect(result.text).toMatch(/User focus \/ requirements: key points/);
    expect(result.sources.length).toBe(2);
    expect(result.sources[0]?.appDocumentId).toBe('doc-1');
  });

  it('puts target length into header when focus includes 字數', async () => {
    const listChunks = vi.fn().mockResolvedValue({
      chunks: [{ id: 'c1', content: '會議內容若干。' }],
      total: 1,
    });

    const result = await runSummarizeDocument({
      doc,
      listChunks,
      focus: '要5000字，涵蓋政策重點',
    });

    expect(result.text).toMatch(/Target length: about 5000 Chinese characters/);
    expect(result.text).toMatch(/User focus \/ requirements: 要5000字/);
    expect(result.text).toMatch(/do not stop at a short outline/i);
  });


  it('handles empty document', async () => {
    const listChunks = vi.fn().mockResolvedValue({ chunks: [], total: 0 });
    const result = await runSummarizeDocument({ doc, listChunks });
    expect(result.details.chunkCount).toBe(0);
    expect(result.text).toMatch(/no chunks/i);
  });
});

describe('extractSummaryLengthHint', () => {
  it('parses Chinese 字 counts', () => {
    expect(extractSummaryLengthHint('幫我總結 要5000字').targetChars).toBe(5000);
    expect(extractSummaryLengthHint('約 3000 字').targetChars).toBe(3000);
  });

  it('parses English character counts', () => {
    expect(
      extractSummaryLengthHint('about 2000 Chinese characters').targetChars,
    ).toBe(2000);
  });
});

describe('buildSummarizeDocumentHeader', () => {
  it('includes target length when present in focus', () => {
    const header = buildSummarizeDocumentHeader({
      documentName: 'a.md',
      knowledgeBaseName: 'KB',
      chunkCount: 2,
      totalChars: 100,
      focus: '5000字',
    });
    expect(header).toMatch(/Target length: about 5000/);
    expect(header).toMatch(/User focus \/ requirements: 5000字/);
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
