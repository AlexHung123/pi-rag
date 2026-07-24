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
      doc.run = 'RUNNING';
      doc.progress = 0.1;
      doc.progress_msg = 'Mock parsing...';
      doc.parseStartedAt = Date.now();
      // Simulate async completion after first status poll window
      setTimeout(() => {
        const text = (doc.buffer || Buffer.from('')).toString('utf8');
        const pieces = splitText(text || `Content of ${doc.name}`);
        doc.chunks = pieces.map((content, i) => ({
          id: `${docId.slice(0, 8)}_${i}`,
          content,
          document_id: docId,
          available: true,
        }));
        doc.chunk_count = doc.chunks.length;
        doc.progress = 1;
        doc.run = 'DONE';
        doc.progress_msg = 'Mock parse complete';
        doc.status = '1';
      }, 800);
    }
  }

  getDocument(datasetId: string, documentId: string): RagflowDocument | null {
    const doc = this.docsByDataset.get(datasetId)?.get(documentId);
    if (!doc) return null;
    // Advance mock progress if still "running"
    if (String(doc.run).toUpperCase().includes('RUN') && doc.parseStartedAt) {
      const elapsed = Date.now() - doc.parseStartedAt;
      doc.progress = Math.min(0.95, 0.1 + elapsed / 1000);
    }
    return doc;
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

  retrieve(datasetIds: string[], question: string, topK: number): RetrieveHit[] {
    const q = question.toLowerCase();
    const hits: RetrieveHit[] = [];
    for (const dsId of datasetIds) {
      const map = this.docsByDataset.get(dsId);
      if (!map) continue;
      for (const doc of map.values()) {
        for (const chunk of doc.chunks) {
          const content = chunk.content || '';
          const score = content.toLowerCase().includes(q)
            ? 0.9
            : overlapScore(q, content.toLowerCase());
          if (score > 0.05) {
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
