import { Injectable, Logger } from '@nestjs/common';
import {
  CreateDatasetInput,
  RagflowChunk,
  RagflowDataset,
  RagflowDocument,
  RetrieveHit,
} from './ragflow.types';
import { RagflowMockStore } from './ragflow-mock.store';
import { badRequest } from '../common/errors';

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

  async retrieve(input: {
    datasetIds: string[];
    question: string;
    topK?: number;
  }): Promise<RetrieveHit[]> {
    const topK = input.topK || 6;
    if (this.useMock()) {
      return this.mock.retrieve(input.datasetIds, input.question, topK);
    }
    // RAGFlow retrieval endpoint
    const data = await this.request<{ chunks?: Array<Record<string, unknown>> }>(
      'POST',
      '/api/v1/retrieval',
      {
        body: {
          question: input.question,
          dataset_ids: input.datasetIds,
          top_k: topK,
          page_size: topK,
        },
      },
    );
    const chunks = data?.chunks || [];
    return chunks.map((c) => ({
      id: String(c.id || c.chunk_id || ''),
      content: String(c.content || c.content_with_weight || ''),
      documentId: c.document_id ? String(c.document_id) : undefined,
      documentName: c.document_keyword
        ? String(c.document_keyword)
        : c.docnm_kwd
          ? String(c.docnm_kwd)
          : undefined,
      datasetId: c.dataset_id ? String(c.dataset_id) : undefined,
      score: typeof c.similarity === 'number' ? c.similarity : undefined,
    }));
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
