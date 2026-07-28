import { Injectable, Logger } from '@nestjs/common';
import {
  CreateDatasetInput,
  RagflowChunk,
  RagflowDataset,
  RagflowDocument,
  RetrieveHit,
  RetrieveOptions,
} from './ragflow.types';
import { RagflowMockStore } from './ragflow-mock.store';
import { badRequest } from '../common/errors';
import { getRagRetrievalConfig } from '../rag/rag-config';

type ApiEnvelope<T> = { code: number; message?: string; data?: T };

@Injectable()
export class RagflowService {
  private readonly logger = new Logger(RagflowService.name);
  private readonly mock = new RagflowMockStore();

  useMock(): boolean {
    const mockEnv = (process.env.RAGFLOW_MOCK || '').toLowerCase();
    if (mockEnv === 'true') return true;
    if (mockEnv === 'false') return false;
    return !process.env.RAGFLOW_API_KEY;
  }

  private baseUrl(): string {
    return (process.env.RAGFLOW_BASE_URL || 'http://localhost:9380').replace(/\/$/, '');
  }

  private headers(json = true): Record<string, string> {
    const key = process.env.RAGFLOW_API_KEY || '';
    const h: Record<string, string> = {
      Authorization: `Bearer ${key}`,
    };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    init?: { body?: unknown; form?: FormData; signal?: AbortSignal },
  ): Promise<T> {
    const url = `${this.baseUrl()}${path}`;
    const headers = this.headers(!init?.form);
    if (init?.form) {
      delete headers['Content-Type'];
    }
    const res = await fetch(url, {
      method,
      headers,
      body: init?.form
        ? (init.form as unknown as BodyInit)
        : init?.body !== undefined
          ? JSON.stringify(init.body)
          : undefined,
      signal: init?.signal,
    });
    const text = await res.text();
    let json: ApiEnvelope<T>;
    try {
      json = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      throw badRequest(`RAGFlow invalid response (${res.status}): ${text.slice(0, 200)}`);
    }
    if (json.code !== 0) {
      throw badRequest(json.message || `RAGFlow error code ${json.code}`);
    }
    return json.data as T;
  }

  async createDataset(input: CreateDatasetInput): Promise<RagflowDataset> {
    if (this.useMock()) {
      this.logger.debug(`mock createDataset ${input.name}`);
      return this.mock.createDataset(input);
    }
    const data = await this.request<RagflowDataset>('POST', '/api/v1/datasets', {
      body: {
        name: input.name,
        description: input.description || '',
        chunk_method: input.chunkMethod || 'naive',
        ...(input.parserConfig ? { parser_config: input.parserConfig } : {}),
      },
    });
    return data;
  }

  async deleteDatasets(ids: string[]): Promise<void> {
    if (this.useMock()) {
      for (const id of ids) this.mock.deleteDataset(id);
      return;
    }
    await this.request('DELETE', '/api/v1/datasets', { body: { ids } });
  }

  async uploadDocuments(
    datasetId: string,
    files: Array<{ filename: string; buffer: Buffer; mimetype?: string }>,
  ): Promise<RagflowDocument[]> {
    if (this.useMock()) {
      return this.mock.uploadDocuments(
        datasetId,
        files.map((f) => ({ filename: f.filename, buffer: f.buffer })),
      );
    }
    const form = new FormData();
    for (const f of files) {
      const blob = new Blob([new Uint8Array(f.buffer)], {
        type: f.mimetype || 'application/octet-stream',
      });
      form.append('file', blob, f.filename);
    }
    const data = await this.request<RagflowDocument[]>(
      'POST',
      `/api/v1/datasets/${datasetId}/documents`,
      { form },
    );
    return Array.isArray(data) ? data : [];
  }

  async parseDocuments(datasetId: string, documentIds: string[]): Promise<void> {
    if (this.useMock()) {
      this.mock.parseDocuments(datasetId, documentIds);
      return;
    }
    await this.request('POST', `/api/v1/datasets/${datasetId}/chunks`, {
      body: { document_ids: documentIds },
    });
  }

  /**
   * Stop parsing specified documents.
   * RAGFlow: DELETE /api/v1/datasets/{dataset_id}/chunks
   * Body: { document_ids: string[] }
   */
  async stopParseDocuments(datasetId: string, documentIds: string[]): Promise<void> {
    if (this.useMock()) {
      this.mock.stopParseDocuments(datasetId, documentIds);
      return;
    }
    await this.request('DELETE', `/api/v1/datasets/${datasetId}/chunks`, {
      body: { document_ids: documentIds },
    });
  }

  async getDocument(
    datasetId: string,
    documentId: string,
  ): Promise<RagflowDocument | null> {
    if (this.useMock()) {
      return this.mock.getDocument(datasetId, documentId);
    }
    // List with id filter
    const data = await this.request<{ docs?: RagflowDocument[]; total?: number } | RagflowDocument[]>(
      'GET',
      `/api/v1/datasets/${datasetId}/documents?id=${encodeURIComponent(documentId)}&page=1&page_size=1`,
    );
    if (Array.isArray(data)) return data[0] || null;
    const docs = (data as { docs?: RagflowDocument[] }).docs || [];
    return docs[0] || null;
  }

  async deleteDocuments(datasetId: string, documentIds: string[]): Promise<void> {
    if (this.useMock()) {
      for (const id of documentIds) this.mock.deleteDocument(datasetId, id);
      return;
    }
    await this.request('DELETE', `/api/v1/datasets/${datasetId}/documents`, {
      body: { ids: documentIds },
    });
  }

  /**
   * Download original document bytes from RAGFlow.
   * API: GET /api/v1/datasets/{dataset_id}/documents/{document_id}
   * Success returns raw file body; failure returns JSON { code, message }.
   */
  async downloadDocument(
    datasetId: string,
    documentId: string,
  ): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
    if (this.useMock()) {
      const file = this.mock.downloadDocument(datasetId, documentId);
      if (!file) throw badRequest('document file not found');
      return {
        buffer: file.buffer,
        contentType: guessContentType(file.filename),
        filename: file.filename,
      };
    }

    const url = `${this.baseUrl()}/api/v1/datasets/${datasetId}/documents/${documentId}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: this.headers(false),
    });
    const contentType = res.headers.get('content-type') || '';
    const disposition = res.headers.get('content-disposition') || '';
    const filenameFromHeader = parseFilename(disposition);

    // RAGFlow returns JSON on error; binary/text on success.
    if (contentType.includes('application/json')) {
      const text = await res.text();
      let message = `RAGFlow download failed (${res.status})`;
      try {
        const json = JSON.parse(text) as ApiEnvelope<unknown>;
        if (json.message) message = json.message;
        else if (json.code !== 0) message = `RAGFlow error code ${json.code}`;
      } catch {
        message = text.slice(0, 200) || message;
      }
      throw badRequest(message);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw badRequest(
        `RAGFlow download failed (${res.status}): ${text.slice(0, 200)}`,
      );
    }

    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    const filename = filenameFromHeader || `document-${documentId}`;
    return {
      buffer,
      contentType: contentType || guessContentType(filename),
      filename,
    };
  }

  async listChunks(
    datasetId: string,
    documentId: string,
    opts: { page?: number; pageSize?: number; keywords?: string } = {},
  ): Promise<{ chunks: RagflowChunk[]; total: number }> {
    const page = opts.page || 1;
    const pageSize = opts.pageSize || 20;
    if (this.useMock()) {
      return this.mock.listChunks(datasetId, documentId, page, pageSize, opts.keywords);
    }
    const qs = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
    });
    if (opts.keywords) qs.set('keywords', opts.keywords);
    const data = await this.request<{ chunks: RagflowChunk[]; total: number }>(
      'GET',
      `/api/v1/datasets/${datasetId}/documents/${documentId}/chunks?${qs}`,
    );
    return {
      chunks: data?.chunks || [],
      total: data?.total || 0,
    };
  }

  async retrieve(input: RetrieveOptions): Promise<RetrieveHit[]> {
    const defaults = getRagRetrievalConfig();
    const pageSize = Math.max(1, input.pageSize ?? defaults.pageSize);
    const topK = Math.max(pageSize, input.topK ?? defaults.topK);
    const similarityThreshold =
      input.similarityThreshold ?? defaults.similarityThreshold;
    const vectorSimilarityWeight =
      input.vectorSimilarityWeight ?? defaults.vectorSimilarityWeight;
    const rerankId = input.rerankId ?? defaults.rerankId;
    const keyword = input.keyword === true;

    if (this.useMock()) {
      return this.mock.retrieve(input.datasetIds, input.question, pageSize, {
        similarityThreshold,
        keyword,
        vectorSimilarityWeight,
      });
    }

    const body: Record<string, unknown> = {
      question: input.question,
      dataset_ids: input.datasetIds,
      // Over-retrieve then let page_size trim; hybrid/rerank reorder inside RAGFlow.
      top_k: topK,
      page_size: pageSize,
      similarity_threshold: similarityThreshold,
      vector_similarity_weight: vectorSimilarityWeight,
    };
    if (input.documentIds?.length) {
      body.document_ids = input.documentIds;
    }
    if (rerankId) {
      body.rerank_id = rerankId;
    }
    // RAGFlow ES keyword path: keyword=true enables term matching via ElasticSearch.
    if (keyword) {
      body.keyword = true;
    }

    this.logger.debug(
      `retrieve q="${input.question.slice(0, 80)}" datasets=${input.datasetIds.length} top_k=${topK} page_size=${pageSize} thr=${similarityThreshold} v_weight=${vectorSimilarityWeight}${keyword ? ' keyword=true' : ''}${rerankId ? ` rerank=${rerankId}` : ''}`,
    );

    const data = await this.request<{ chunks?: Array<Record<string, unknown>> }>(
      'POST',
      '/api/v1/retrieval',
      { body },
    );
    const chunks = data?.chunks || [];
    return chunks.map((c) => this.mapRetrievalChunk(c));
  }

  private mapRetrievalChunk(c: Record<string, unknown>): RetrieveHit {
    const rawPositions = c.positions ?? c.position;
    let positions: RetrieveHit['positions'];
    if (Array.isArray(rawPositions)) {
      positions = rawPositions as RetrieveHit['positions'];
    }
    const score =
      typeof c.similarity === 'number'
        ? c.similarity
        : typeof c.score === 'number'
          ? c.score
          : undefined;
    return {
      id: String(c.id || c.chunk_id || ''),
      content: String(c.content || c.content_with_weight || ''),
      documentId: c.document_id ? String(c.document_id) : undefined,
      documentName: c.document_keyword
        ? String(c.document_keyword)
        : c.docnm_kwd
          ? String(c.docnm_kwd)
          : undefined,
      datasetId: c.dataset_id ? String(c.dataset_id) : undefined,
      score,
      positions,
    };
  }

  mapRunToStatus(run: string | number | undefined): 'unstart' | 'running' | 'done' | 'fail' {
    const v = String(run ?? 'UNSTART').toUpperCase();
    if (v === '0' || v === 'UNSTART' || v === 'UNSTARTED') return 'unstart';
    if (v === '1' || v === 'RUNNING' || v === '2' || v.includes('RUN')) {
      // RAGFlow sometimes uses numeric codes; treat in-progress codes as running
      if (v === '3' || v === 'DONE' || v === 'SUCCESS' || v === '4') return 'done';
      if (v === 'FAIL' || v === 'FAILED' || v === '5') return 'fail';
      if (v === '1' || v === '2' || v.includes('RUN') || v === 'RUNNING') return 'running';
    }
    if (v === '3' || v === 'DONE' || v === 'SUCCESS' || v === 'CANCEL' && false) return 'done';
    if (v.includes('DONE') || v.includes('SUCCESS') || v === '3') return 'done';
    if (v.includes('FAIL') || v === '4' || v === '5') return 'fail';
    if (v.includes('RUN')) return 'running';
    return 'unstart';
  }
}

function parseFilename(contentDisposition: string): string | undefined {
  if (!contentDisposition) return undefined;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return utf8[1].trim().replace(/^"|"$/g, '');
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(contentDisposition);
  return plain?.[1]?.trim() || undefined;
}

function guessContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    markdown: 'text/markdown; charset=utf-8',
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    json: 'application/json',
    csv: 'text/csv; charset=utf-8',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  return map[ext] || 'application/octet-stream';
}
