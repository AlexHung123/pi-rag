import { randomUUID } from 'crypto';
import {
  CreateDatasetInput,
  RagflowChunk,
  RagflowDataset,
  RagflowDocument,
  RetrieveHit,
} from './ragflow.types';

type MockDoc = RagflowDocument & {
  buffer?: Buffer;
  chunks: RagflowChunk[];
  parseStartedAt?: number;
  parseTimer?: ReturnType<typeof setTimeout>;
};

/**
 * In-memory RAGFlow stand-in for local UI development when RAGFLOW_MOCK=true
 * or when RAGFLOW_API_KEY is empty.
 */
export class RagflowMockStore {
  private datasets = new Map<string, RagflowDataset>();
  private docsByDataset = new Map<string, Map<string, MockDoc>>();

  createDataset(input: CreateDatasetInput): RagflowDataset {
    const id = randomUUID().replace(/-/g, '');
    const ds: RagflowDataset = {
      id,
      name: input.name,
      description: input.description || '',
      chunk_method: input.chunkMethod || 'naive',
    };
    this.datasets.set(id, ds);
    this.docsByDataset.set(id, new Map());
    return ds;
  }

  deleteDataset(datasetId: string) {
    this.datasets.delete(datasetId);
    this.docsByDataset.delete(datasetId);
  }

  uploadDocuments(
    datasetId: string,
    files: Array<{ filename: string; buffer: Buffer }>,
  ): RagflowDocument[] {
    const map = this.docsByDataset.get(datasetId);
    if (!map) throw new Error(`dataset not found: ${datasetId}`);
    const out: RagflowDocument[] = [];
    for (const f of files) {
      const id = randomUUID().replace(/-/g, '');
      const doc: MockDoc = {
        id,
        name: f.filename,
        size: f.buffer.length,
        run: 'UNSTART',
        progress: 0,
        progress_msg: '',
        chunk_count: 0,
        process_begin_at: null,
        process_duration: 0,
        buffer: f.buffer,
        chunks: [],
      };
      map.set(id, doc);
      out.push(doc);
    }
    return out;
  }

  parseDocuments(datasetId: string, documentIds: string[]) {
    const map = this.docsByDataset.get(datasetId);
    if (!map) throw new Error(`dataset not found: ${datasetId}`);
    for (const docId of documentIds) {
      const doc = map.get(docId);
      if (!doc) continue;
      if (doc.parseTimer) {
        clearTimeout(doc.parseTimer);
        doc.parseTimer = undefined;
      }
      doc.run = 'RUNNING';
      doc.progress = 0.1;
      doc.progress_msg = 'Mock parsing...';
      doc.parseStartedAt = Date.now();
      doc.process_begin_at = new Date(doc.parseStartedAt).toUTCString();
      doc.process_duration = 0;
      // Simulate async completion after first status poll window
      doc.parseTimer = setTimeout(() => {
        doc.parseTimer = undefined;
        const text = (doc.buffer || Buffer.from('')).toString('utf8');
        const pieces = splitText(text || `Content of ${doc.name}`);
        doc.chunks = pieces.map((content, i) => ({
          id: `${docId.slice(0, 8)}_${i}`,
          content,
          document_id: docId,
          available: true,
          // Demo boxes: page 1, staggered vertical bands (PDF space units)
          positions: [[1, 40, 520, 80 + i * 90, 140 + i * 90]],
        }));
        doc.chunk_count = doc.chunks.length;
        doc.progress = 1;
        doc.run = 'DONE';
        doc.progress_msg = 'Mock parse complete';
        doc.status = '1';
        if (doc.parseStartedAt) {
          doc.process_duration = Math.max(
            0.1,
            (Date.now() - doc.parseStartedAt) / 1000,
          );
        }
      }, 800);
    }
  }

  /** Stop parsing for specified documents (cancel in-flight mock parse). */
  stopParseDocuments(datasetId: string, documentIds: string[]) {
    const map = this.docsByDataset.get(datasetId);
    if (!map) throw new Error(`dataset not found: ${datasetId}`);
    for (const docId of documentIds) {
      const doc = map.get(docId);
      if (!doc) continue;
      if (doc.parseTimer) {
        clearTimeout(doc.parseTimer);
        doc.parseTimer = undefined;
      }
      doc.run = 'UNSTART';
      doc.progress = 0;
      doc.progress_msg = 'Parse stopped';
      doc.parseStartedAt = undefined;
      doc.process_begin_at = null;
      doc.process_duration = 0;
      // Keep any chunks already produced; in-flight mock never had partial chunks.
    }
  }

  getDocument(datasetId: string, documentId: string): RagflowDocument | null {
    const doc = this.docsByDataset.get(datasetId)?.get(documentId);
    if (!doc) return null;
    // Advance mock progress if still "running"
    if (String(doc.run).toUpperCase().includes('RUN') && doc.parseStartedAt) {
      const elapsed = Date.now() - doc.parseStartedAt;
      doc.progress = Math.min(0.95, 0.1 + elapsed / 1000);
      doc.process_duration = elapsed / 1000;
      doc.process_begin_at = new Date(doc.parseStartedAt).toUTCString();
    }
    return doc;
  }

  downloadDocument(
    datasetId: string,
    documentId: string,
  ): { buffer: Buffer; filename: string } | null {
    const doc = this.docsByDataset.get(datasetId)?.get(documentId);
    if (!doc) return null;
    return {
      buffer: doc.buffer || Buffer.from(`Mock content for ${doc.name}`, 'utf8'),
      filename: doc.name || 'document.bin',
    };
  }

  deleteDocument(datasetId: string, documentId: string) {
    this.docsByDataset.get(datasetId)?.delete(documentId);
  }

  listChunks(
    datasetId: string,
    documentId: string,
    page: number,
    pageSize: number,
    keywords?: string,
  ): { chunks: RagflowChunk[]; total: number } {
    const doc = this.docsByDataset.get(datasetId)?.get(documentId);
    if (!doc) return { chunks: [], total: 0 };
    let chunks = doc.chunks;
    if (keywords) {
      const k = keywords.toLowerCase();
      chunks = chunks.filter((c) => (c.content || '').toLowerCase().includes(k));
    }
    const total = chunks.length;
    const start = (page - 1) * pageSize;
    return { chunks: chunks.slice(start, start + pageSize), total };
  }

  retrieve(
    datasetIds: string[],
    question: string,
    topK: number,
    opts: {
      similarityThreshold?: number;
      keyword?: boolean;
      vectorSimilarityWeight?: number;
    } = {},
  ): RetrieveHit[] {
    const threshold =
      typeof opts.similarityThreshold === 'number'
        ? opts.similarityThreshold
        : 0.05;
    const keywordMode = opts.keyword === true;
    // Low vector weight ≈ prefer exact/term match (keyword path).
    const preferKeyword =
      keywordMode ||
      (typeof opts.vectorSimilarityWeight === 'number' &&
        opts.vectorSimilarityWeight <= 0.25);
    const q = question.toLowerCase().trim();
    const hits: RetrieveHit[] = [];
    for (const dsId of datasetIds) {
      const map = this.docsByDataset.get(dsId);
      if (!map) continue;
      for (const doc of map.values()) {
        for (const chunk of doc.chunks) {
          const content = chunk.content || '';
          const lower = content.toLowerCase();
          let score: number;
          if (preferKeyword) {
            // Exact substring / phrase bias (ES keyword stand-in).
            if (q && lower.includes(q)) {
              score = 0.95;
            } else {
              score = keywordOverlapScore(q, lower);
            }
          } else {
            score = lower.includes(q)
              ? 0.9
              : overlapScore(q, lower);
          }
          if (score >= threshold) {
            hits.push({
              id: chunk.id,
              content,
              documentId: doc.id,
              documentName: doc.name,
              datasetId: dsId,
              score,
            });
          }
        }
      }
    }
    return hits.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, topK);
  }
}

function splitText(text: string): string[] {
  const parts = text
    .split(/\n{2,}|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return [text.slice(0, 500) || 'empty document'];
  const chunks: string[] = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + ' ' + p).length > 400) {
      if (buf) chunks.push(buf.trim());
      buf = p;
    } else {
      buf = buf ? `${buf} ${p}` : p;
    }
  }
  if (buf) chunks.push(buf.trim());
  return chunks.slice(0, 50);
}

function overlapScore(q: string, content: string): number {
  const terms = q.split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return 0;
  let hit = 0;
  for (const t of terms) if (content.includes(t)) hit += 1;
  return hit / terms.length / 3;
}

/** Stricter term match for keyword/ES path mock. */
function keywordOverlapScore(q: string, content: string): number {
  // Split on whitespace and common code/phrase separators.
  const terms = q
    .split(/[\s,;|/\\]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (!terms.length) return 0;
  let hit = 0;
  for (const t of terms) {
    if (content.includes(t)) hit += 1;
  }
  if (hit === 0) return 0;
  // Require at least one term; full match scores high.
  return hit === terms.length ? 0.85 : (hit / terms.length) * 0.6;
}
