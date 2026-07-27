/**
 * Adjacent-chunk expand (P1d).
 *
 * After retrieval, for top hits that have document + dataset ids, load that
 * document's chunks via listChunks (stable list order) and attach i−1 / i+1
 * when the hit id is found. Fail-open: any list error skips expand for that doc.
 *
 * Gate: uses list-chunks order (not PDF positions). Disabled via env.
 */

import type { RagflowChunk } from '../ragflow/ragflow.types';
import type { MappedHit } from './evidence';
import { dedupeHitsById } from './evidence';
import { getRagRetrievalConfig } from './rag-config';

export type ListChunksFn = (
  datasetId: string,
  documentId: string,
  opts: { page?: number; pageSize?: number },
) => Promise<{ chunks: RagflowChunk[]; total: number }>;

export type ExpandAdjacentOptions = {
  listChunks: ListChunksFn;
  /** Max primary hits to expand (default from config). */
  maxHits?: number;
  /** Max listChunks pages to scan per document. */
  maxPages?: number;
  pageSize?: number;
  enabled?: boolean;
};

/**
 * Expand top hits with previous/next chunks from the same document.
 * Preserves original hit order first, then appends neighbors (lower score).
 */
export async function expandAdjacentHits(
  hits: MappedHit[],
  opts: ExpandAdjacentOptions,
): Promise<MappedHit[]> {
  const cfg = getRagRetrievalConfig();
  const enabled = opts.enabled ?? cfg.adjacentExpandEnabled;
  if (!enabled || !hits.length) return hits;

  const maxHits = Math.max(
    1,
    opts.maxHits ?? cfg.adjacentExpandMaxHits,
  );
  const pageSize = Math.min(100, Math.max(10, opts.pageSize ?? 50));
  const maxPages = Math.min(5, Math.max(1, opts.maxPages ?? 3));

  const primary = hits.slice(0, maxHits);
  const byDoc = new Map<
    string,
    {
      datasetId: string;
      documentId: string;
      template: MappedHit;
      hitIds: Set<string>;
    }
  >();

  for (const h of primary) {
    const datasetId = h.datasetId?.trim();
    const documentId = h.documentId?.trim();
    const chunkId = h.id?.trim();
    if (!datasetId || !documentId || !chunkId) continue;
    const key = `${datasetId}::${documentId}`;
    let group = byDoc.get(key);
    if (!group) {
      group = {
        datasetId,
        documentId,
        template: h,
        hitIds: new Set(),
      };
      byDoc.set(key, group);
    }
    group.hitIds.add(chunkId);
  }

  if (!byDoc.size) return hits;

  const neighbors: MappedHit[] = [];

  for (const group of byDoc.values()) {
    try {
      const ordered = await loadOrderedChunks(
        opts.listChunks,
        group.datasetId,
        group.documentId,
        pageSize,
        maxPages,
      );
      if (!ordered.length) continue;

      const indexById = new Map<string, number>();
      ordered.forEach((c, i) => {
        if (c.id) indexById.set(c.id, i);
      });

      for (const hitId of group.hitIds) {
        const idx = indexById.get(hitId);
        if (idx === undefined) continue;
        const base = hits.find((h) => h.id === hitId) || group.template;
        const baseScore =
          typeof base.score === 'number' && !Number.isNaN(base.score)
            ? base.score
            : 0.5;

        for (const offset of [-1, 1] as const) {
          const n = ordered[idx + offset];
          if (!n?.id) continue;
          // Skip if already a primary hit
          if (hits.some((h) => h.id === n.id)) continue;
          neighbors.push(
            chunkToMappedHit(n, base, {
              score: Math.max(0, baseScore * 0.85),
              sourceQuery: base.sourceQuery
                ? `${base.sourceQuery} [adjacent ${offset < 0 ? 'prev' : 'next'}]`
                : `adjacent ${offset < 0 ? 'prev' : 'next'}`,
            }),
          );
        }
      }
    } catch {
      // Fail-open per document
      continue;
    }
  }

  if (!neighbors.length) return hits;

  // Keep primary hits first (by original order), then neighbors by score.
  const primaryIds = new Set(hits.map((h) => h.id).filter(Boolean));
  const extra = dedupeHitsById(neighbors).filter((h) => !primaryIds.has(h.id));
  return [...hits, ...extra];
}

async function loadOrderedChunks(
  listChunks: ListChunksFn,
  datasetId: string,
  documentId: string,
  pageSize: number,
  maxPages: number,
): Promise<Array<RagflowChunk & { id: string }>> {
  const out: Array<RagflowChunk & { id: string }> = [];
  let total = Infinity;
  for (let page = 1; page <= maxPages && out.length < total; page++) {
    const res = await listChunks(datasetId, documentId, { page, pageSize });
    total = typeof res.total === 'number' ? res.total : out.length + res.chunks.length;
    for (const c of res.chunks || []) {
      const id = String(c.id || '').trim();
      if (!id) continue;
      out.push({ ...c, id });
    }
    if ((res.chunks || []).length < pageSize) break;
  }
  return out;
}

function chunkToMappedHit(
  chunk: RagflowChunk & { id: string },
  template: MappedHit,
  extra: { score?: number; sourceQuery?: string },
): MappedHit {
  return {
    id: chunk.id,
    content: String(chunk.content || chunk.content_with_weight || ''),
    documentId: template.documentId,
    documentName: template.documentName,
    datasetId: template.datasetId,
    knowledgeBaseId: template.knowledgeBaseId,
    knowledgeBaseName: template.knowledgeBaseName,
    appDocumentId: template.appDocumentId,
    positions: Array.isArray(chunk.positions)
      ? (chunk.positions as MappedHit['positions'])
      : undefined,
    score: extra.score,
    sourceQuery: extra.sourceQuery,
  };
}
